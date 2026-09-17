import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat
} from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  LIMITS,
  type BatchAction,
  type BatchEvent,
  type BatchSummary,
  type ErrorCode,
  type FileOutcome,
  type FileFingerprint,
  type FileResult,
  type InputSelection,
  type PreflightRequest,
  type PreflightSummary,
  type ProcessRequest,
  type ScannedFile,
  type SourceType
} from '../../shared/contracts'
import { AppError, errorMessage } from './errors'
import { waitForOperation } from './pending-operation'
import {
  inspectImage,
  prepareMetadataTools,
  mutateTargetSubject,
  sha256File,
  verifyMutatedImage
} from './metadata'
import {
  assertNoRelativePathCollisions,
  resolveSafeDestination,
  validateInputOutputSeparation
} from './path-safety'
import { allocateFlatOutputNames } from './output-names'
import { RecoveryJournal } from './recovery-journal'
import type { RecoveryStore } from './recovery'
import {
  assertDiskCapacity,
  availableDiskBytes,
  createBatchId,
  createUniqueBatchDirectory,
  publishFileNoClobber
} from './runtime-fs'

export interface PreparedCandidate {
  sourceId: string
  sourceType: SourceType
  sourcePath: string
  canonicalPath: string
  displayName: string
  relativePath: string
  bytes: number
  modifiedMs: number
  errorCode?: ErrorCode
  errorMessage?: string
}

export interface PreparedInputSet {
  candidates: PreparedCandidate[]
  totalScannedEntries: number
  totalUncompressedBytes: number
  warnings?: string[]
  temporaryPaths?: string[]
  cleanup(): Promise<void>
}

export interface PrepareInputsOptions {
  recursive: boolean
  tempRoot?: string
  signal?: AbortSignal
}

export type InputPreparer = (
  inputs: readonly InputSelection[],
  options: PrepareInputsOptions
) => Promise<PreparedInputSet>

export interface BatchServiceOptions {
  appDataDirectory: string
  recovery: RecoveryStore
  prepareInputs: InputPreparer
  createThumbnail?: (path: string) => Promise<string | undefined>
  shouldCreateThumbnails?: () => Promise<boolean>
  removeInvalidatedOutput?: (path: string) => Promise<void>
  removeStagingDirectory?: (path: string) => Promise<void>
}

interface PreflightState {
  request: PreflightRequest
  summary: PreflightSummary
  prepared: PreparedInputSet
  candidatesById: Map<string, PreparedCandidate>
  inputById: Map<string, InputSelection>
  archiveFingerprints: Map<string, FileFingerprint>
  tempRoot?: string
}

interface ArchiveFingerprintCapture {
  fingerprints: Map<string, FileFingerprint>
  failures: Map<
    string,
    {
      code: Extract<ErrorCode, 'SOURCE_READ_FAILED' | 'SOURCE_CHANGED'>
      message: string
    }
  >
}

const PREFLIGHT_CONCURRENCY = 4
const MAX_EMBEDDED_THUMBNAILS = 300

const KNOWN_ERROR_CODES = new Set<ErrorCode>([
  'UNSUPPORTED_FORMAT',
  'EXTENSION_MISMATCH',
  'ANIMATED_PNG',
  'IMAGE_TOO_LARGE',
  'PIXEL_LIMIT_EXCEEDED',
  'MALFORMED_METADATA',
  'SOURCE_CHANGED',
  'ARCHIVE_ENCRYPTED',
  'ARCHIVE_SPLIT',
  'ARCHIVE_NESTED',
  'ARCHIVE_SFX',
  'ARCHIVE_PATH_UNSAFE',
  'ARCHIVE_INDEX_CORRUPT',
  'ARCHIVE_CRC_FAILED',
  'ENTRY_LIMIT_EXCEEDED',
  'IMAGE_LIMIT_EXCEEDED',
  'TOTAL_SIZE_LIMIT_EXCEEDED',
  'OUTPUT_NESTED_WITH_INPUT',
  'OUTPUT_COLLISION',
  'INSUFFICIENT_DISK_SPACE',
  'SOURCE_READ_FAILED',
  'OUTPUT_WRITE_FAILED',
  'POST_VERIFY_FAILED',
  'PAYLOAD_CHANGED',
  'METADATA_CHANGED',
  'CANCELLED',
  'INTERNAL_ERROR'
])

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AppError('CANCELLED', '操作已取消')
  }
}

function normalizeFailure(error: unknown): {
  code: ErrorCode
  message: string
} {
  const possibleCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
  return {
    code:
      possibleCode && KNOWN_ERROR_CODES.has(possibleCode as ErrorCode)
        ? (possibleCode as ErrorCode)
        : 'INTERNAL_ERROR',
    message: errorMessage(error)
  }
}

function fileId(candidate: PreparedCandidate): string {
  return createHash('sha256')
    .update(candidate.sourceId)
    .update('\0')
    .update(candidate.relativePath)
    .digest('hex')
    .slice(0, 24)
}

function reportSourcePath(
  candidate: PreparedCandidate,
  input: InputSelection | undefined
): string {
  if (
    input &&
    (candidate.sourceType === 'zip' || candidate.sourceType === 'rar')
  ) {
    return `${input.path}::${candidate.relativePath}`
  }
  return candidate.sourcePath
}

function invalidOutcome(code: ErrorCode): FileOutcome {
  return [
    'UNSUPPORTED_FORMAT',
    'EXTENSION_MISMATCH',
    'ANIMATED_PNG',
    'IMAGE_TOO_LARGE',
    'PIXEL_LIMIT_EXCEEDED'
  ].includes(code)
    ? 'skipped'
    : 'failed'
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      throwIfAborted(signal)
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      const value = values[index]
      if (value === undefined) return
      results[index] = await mapper(value, index)
    }
  }

  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, values.length)) },
      () => worker()
    )
  )
  const failed =
    workers.find(
      (worker) => worker.status === 'rejected' &&
        normalizeFailure(worker.reason).code !== 'CANCELLED'
    ) ?? workers.find((worker) => worker.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  throwIfAborted(signal)
  return results
}

function fingerprintMatches(
  expected: FileFingerprint,
  actual: FileFingerprint
): boolean {
  return (
    expected.size === actual.size &&
    expected.modifiedMs === actual.modifiedMs &&
    expected.sourceSha256 === actual.sourceSha256
  )
}

function calculateCounts(results: readonly FileResult[]): Pick<
  BatchSummary,
  'total' | 'succeeded' | 'skipped' | 'failed' | 'cancelled'
> {
  return {
    total: results.length,
    succeeded: results.filter((result) => result.outcome === 'passed').length,
    skipped: results.filter((result) => result.outcome === 'skipped').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    cancelled: results.filter((result) => result.outcome === 'cancelled').length
  }
}

function isOutputInfrastructureFailure(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  if (['ENOSPC', 'EIO', 'ENXIO', 'ESTALE', 'EROFS'].includes(code)) return true
  if (code === 'INSUFFICIENT_DISK_SPACE') return true
  if (code !== 'OUTPUT_WRITE_FAILED') return false
  const details =
    error && typeof error === 'object' && 'details' in error
      ? JSON.stringify((error as { details: unknown }).details)
      : ''
  return /(?:ENOSPC|EIO|ENXIO|ESTALE|EROFS|no space|disk full|read-only file system|stale file handle|device not configured)/iu.test(
    `${errorMessage(error)} ${details}`
  )
}

export class BatchService {
  private readonly appDataDirectory: string
  private readonly recovery: RecoveryStore
  private readonly prepareInputSet: InputPreparer
  private readonly createThumbnail?: BatchServiceOptions['createThumbnail']
  private readonly shouldCreateThumbnails?: BatchServiceOptions['shouldCreateThumbnails']
  private readonly removeInvalidatedOutput: (path: string) => Promise<void>
  private readonly removeStagingDirectory: (path: string) => Promise<void>
  private currentController: AbortController | undefined
  private currentOperation: 'preflight' | 'process' | undefined
  private preflightState: PreflightState | undefined

  constructor(options: BatchServiceOptions) {
    this.appDataDirectory = options.appDataDirectory
    this.recovery = options.recovery
    this.prepareInputSet = options.prepareInputs
    this.createThumbnail = options.createThumbnail
    this.shouldCreateThumbnails = options.shouldCreateThumbnails
    this.removeInvalidatedOutput =
      options.removeInvalidatedOutput ??
      ((path) => rm(path, { force: true }))
    this.removeStagingDirectory =
      options.removeStagingDirectory ??
      ((path) => rm(path, { recursive: true, force: true }))
  }

  async preflight(
    request: PreflightRequest,
    emit: (event: BatchEvent) => void
  ): Promise<PreflightSummary> {
    if (this.currentOperation) {
      throw new AppError('INTERNAL_ERROR', '当前已有批次正在运行')
    }
    const batchId = createBatchId()
    const hasArchive = request.inputs.some((input) => input.kind === 'archive')
    if (hasArchive && !request.outputParent) {
      throw new AppError(
        'OUTPUT_WRITE_FAILED',
        '压缩包预检前必须先选择输出位置，临时文件只会创建在该位置'
      )
    }
    if (request.outputParent) {
      validateInputOutputSeparation(request.inputs, request.outputParent)
    }

    const controller = new AbortController()
    this.currentController = controller
    this.currentOperation = 'preflight'
    const startedAt = new Date().toISOString()
    let tempRoot: string | undefined
    let prepared: PreparedInputSet | undefined

    try {
      const existingRecovery = await this.recovery.get()
      if (
        existingRecovery &&
        existingRecovery.batchId !== this.preflightState?.summary.batchId
      ) {
        throw new AppError(
          'INTERNAL_ERROR',
          '检测到上次异常中断记录，请先导出或删除恢复记录'
        )
      }
      await this.cleanupPreviousPreflight()

      emit({ type: 'phase', phase: 'scanning', message: '正在扫描输入…' })
      if (hasArchive) {
        tempRoot = await mkdtemp(
          join(resolve(request.outputParent!), '.ai-labeler-temp-')
        )
        await this.recovery.set({
          batchId,
          createdAt: startedAt,
          outputDirectory: request.outputParent!,
          temporaryPaths: [tempRoot],
          reason: '压缩包预检进行中'
        })
      }

      const archiveCaptureBefore = await this.captureArchiveFingerprints(
        request.inputs,
        controller.signal
      )
      prepared = await this.prepareInputSet(request.inputs, {
        recursive: request.recursive,
        ...(tempRoot ? { tempRoot } : {}),
        signal: controller.signal
      })
      throwIfAborted(controller.signal)
      const archiveCaptureAfter =
        await this.captureArchiveFingerprints(request.inputs, controller.signal)
      const archiveSourceFailures = new Map(archiveCaptureBefore.failures)
      for (const input of request.inputs) {
        if (input.kind !== 'archive') continue
        const before = archiveCaptureBefore.fingerprints.get(input.id)
        const after = archiveCaptureAfter.fingerprints.get(input.id)
        if (before && (!after || !fingerprintMatches(before, after))) {
          archiveSourceFailures.set(input.id, {
            code: 'SOURCE_CHANGED',
            message: '压缩包在预检解压期间发生变化，请重新预检'
          })
        } else if (!before && after) {
          archiveSourceFailures.set(input.id, {
            code: 'SOURCE_CHANGED',
            message: '压缩包在预检期间出现或被替换，请重新预检'
          })
        }
      }

      if (prepared.totalScannedEntries > LIMITS.maxScannedEntries) {
        throw new AppError(
          'ENTRY_LIMIT_EXCEEDED',
          `扫描条目超过 ${LIMITS.maxScannedEntries.toLocaleString('zh-CN')} 个`
        )
      }
      if (
        prepared.totalUncompressedBytes > LIMITS.maxTotalUncompressedBytes
      ) {
        throw new AppError(
          'TOTAL_SIZE_LIMIT_EXCEEDED',
          '输入解压后的总大小超过 50 GB'
        )
      }

      const createThumbnails =
        Boolean(this.createThumbnail) &&
        (await this.shouldCreateThumbnails?.()) !== false
      let thumbnailCount = 0
      let thumbnailsUnavailable = false
      let completed = 0
      const inputById = new Map(
        request.inputs.map((input) => [input.id, input])
      )

      emit({ type: 'phase', phase: 'preflight', message: '正在检查图片和 XMP…' })
      emit({ type: 'progress', completed: 0, total: prepared.candidates.length })
      if (prepared.candidates.some((candidate) => !candidate.errorCode)) {
        emit({ type: 'phase', phase: 'preflight', message: '正在启动元数据引擎…' })
        await prepareMetadataTools(controller.signal)
        emit({ type: 'phase', phase: 'preflight', message: '正在检查图片和 XMP…' })
      }
      const files = await mapWithConcurrency(
        prepared.candidates,
        PREFLIGHT_CONCURRENCY,
        controller.signal,
        async (candidate): Promise<ScannedFile> => {
          const id = fileId(candidate)
          const input = inputById.get(candidate.sourceId)
          const sourcePath = reportSourcePath(candidate, input)
          const base: ScannedFile = {
            id,
            sourceId: candidate.sourceId,
            sourceType: candidate.sourceType,
            sourcePath,
            canonicalPath:
              candidate.sourceType === 'zip' || candidate.sourceType === 'rar'
                ? sourcePath
                : candidate.canonicalPath,
            displayName: candidate.displayName,
            relativePath: candidate.relativePath,
            bytes: candidate.bytes,
            modifiedMs: candidate.modifiedMs,
            selected: false,
            outcome: 'pending'
          }

          const archiveFailure = archiveSourceFailures.get(candidate.sourceId)
          const candidateErrorCode =
            archiveFailure?.code ?? candidate.errorCode
          const candidateErrorMessage =
            archiveFailure?.message ?? candidate.errorMessage
          emit({
            type: 'progress', completed,
            total: prepared!.candidates.length, currentFile: sourcePath
          })
          try {
            if (candidateErrorCode) {
              return {
                ...base,
                outcome: invalidOutcome(candidateErrorCode),
                errorCode: candidateErrorCode,
                ...(candidateErrorMessage
                  ? { errorMessage: candidateErrorMessage }
                  : {})
              }
            }

            const inspection = await inspectImage(
              candidate.canonicalPath, controller.signal
            )
            throwIfAborted(controller.signal)
            let thumbnailDataUrl: string | undefined
            if (
              createThumbnails &&
              !thumbnailsUnavailable &&
              thumbnailCount < MAX_EMBEDDED_THUMBNAILS &&
              this.createThumbnail
            ) {
              thumbnailCount += 1
              try {
                thumbnailDataUrl = await waitForOperation(
                  () => this.createThumbnail!(candidate.canonicalPath),
                  2_000,
                  '缩略图生成超时',
                  controller.signal
                )
              } catch {
                throwIfAborted(controller.signal)
                thumbnailsUnavailable = true
              }
            }
            throwIfAborted(controller.signal)
            return {
              ...base,
              format: inspection.format,
              bytes: inspection.bytes,
              width: inspection.width,
              height: inspection.height,
              modifiedMs: inspection.fingerprint.modifiedMs,
              selected: request.mode !== 'remove',
              outcome: 'ready',
              subject: inspection.subject,
              fingerprint: inspection.fingerprint,
              ...(thumbnailDataUrl ? { thumbnailDataUrl } : {})
            }
          } catch (error) {
            throwIfAborted(controller.signal)
            const failure = normalizeFailure(error)
            if (failure.code === 'INTERNAL_ERROR') {
              controller.abort()
              throw error
            }
            return {
              ...base,
              outcome: invalidOutcome(failure.code),
              errorCode: failure.code,
              errorMessage: failure.message
            }
          } finally {
            completed += 1
            emit({
              type: 'progress', completed,
              total: prepared!.candidates.length, currentFile: sourcePath
            })
          }
        }
      )

      const supported = files.filter(
        (file) => file.outcome === 'ready' && file.format !== undefined
      )
      if (supported.length > LIMITS.maxSupportedImages) {
        throw new AppError(
          'IMAGE_LIMIT_EXCEEDED',
          `支持的图片超过 ${LIMITS.maxSupportedImages.toLocaleString('zh-CN')} 张`
        )
      }
      const totalSupportedBytes = supported.reduce(
        (total, file) => total + file.bytes,
        0
      )
      // Archive extraction capacity is checked before and during extraction.
      // availableBytes is measured afterwards, so only the remaining output
      // requirement may be compared with it without double-counting temp data.
      const estimatedPeakBytes =
        request.mode === 'detect' ? 32 * 1024 ** 2 : totalSupportedBytes
      let availableBytes: number | undefined
      if (request.outputParent) {
        availableBytes = await availableDiskBytes(request.outputParent)
      }

      const summary: PreflightSummary = {
        batchId,
        startedAt,
        files,
        totalScannedEntries: prepared.totalScannedEntries,
        supportedImages: supported.length,
        totalSupportedBytes,
        estimatedPeakBytes,
        ...(availableBytes !== undefined ? { availableBytes } : {}),
        warnings: [
          ...(prepared.warnings ?? []),
          ...(thumbnailsUnavailable
            ? ['部分缩略图生成失败或超时，已跳过预览；图片检查结果不受影响。']
            : []),
          ...(createThumbnails && supported.length > MAX_EMBEDDED_THUMBNAILS
            ? [
                `为控制内存占用，仅预生成前 ${MAX_EMBEDDED_THUMBNAILS} 张缩略图；其余文件仍会正常处理。`
              ]
            : [])
        ]
      }
      const candidatesById = new Map<string, PreparedCandidate>()
      for (const candidate of prepared.candidates) {
        candidatesById.set(fileId(candidate), candidate)
      }
      this.preflightState = {
        request,
        summary,
        prepared,
        candidatesById,
        inputById,
        archiveFingerprints: archiveCaptureBefore.fingerprints,
        ...(tempRoot ? { tempRoot } : {})
      }
      return summary
    } catch (error) {
      let cleanupSucceeded = true
      try {
        await prepared?.cleanup()
        if (tempRoot) {
          await rm(tempRoot, { recursive: true, force: true })
        }
      } catch (cleanupError) {
        cleanupSucceeded = false
        const record = await this.recovery.get().catch(() => undefined)
        if (record?.batchId === batchId) {
          await this.recovery
            .update({
              reason: `预检失败且临时目录清理失败：${errorMessage(cleanupError)}`
            })
            .catch(() => undefined)
        }
      }
      if (cleanupSucceeded) {
        await this.clearRecoveryIfOwned(batchId, false).catch(() => undefined)
      }
      throw error
    } finally {
      this.currentController = undefined
      this.currentOperation = undefined
    }
  }

  async process(
    request: ProcessRequest,
    emit: (event: BatchEvent) => void
  ): Promise<BatchSummary> {
    if (this.currentOperation) {
      throw new AppError('INTERNAL_ERROR', '当前已有批次正在运行')
    }
    const state = this.preflightState
    if (!state || state.summary.batchId !== request.batchId) {
      throw new AppError('SOURCE_CHANGED', '预检结果已失效，请重新预检')
    }
    if (state.request.mode !== request.mode) {
      throw new AppError('SOURCE_CHANGED', '处理模式已变化，请重新预检')
    }
    if (request.selectedFileIds.length === 0) {
      throw new AppError('INTERNAL_ERROR', '请至少选择一张通过预检的图片')
    }
    const selected = new Set(request.selectedFileIds)
    for (const id of selected) {
      const file = state.summary.files.find((candidate) => candidate.id === id)
      if (!file || file.outcome !== 'ready') {
        throw new AppError('INTERNAL_ERROR', '选择中包含未通过预检的文件')
      }
    }
    const hasArchive = state.request.inputs.some(
      (input) => input.kind === 'archive'
    )
    if (
      hasArchive &&
      state.request.outputParent &&
      resolve(state.request.outputParent) !== resolve(request.outputParent)
    ) {
      throw new AppError(
        'SOURCE_CHANGED',
        '压缩包预检后更改了输出位置，请重新预检'
      )
    }

    const controller = new AbortController()
    this.currentController = controller
    this.currentOperation = 'process'
    // A processing attempt consumes its preflight. Any retry must perform a
    // fresh preflight and receive a new batch ID; otherwise the recovery
    // journal for this attempt could be truncated or overwritten.
    this.preflightState = undefined
    let outputDirectory: string | undefined
    let deliveryDirectory: string | undefined
    let stagingDirectory: string | undefined
    let journal: RecoveryJournal | undefined
    let changedBeforeProcessing = new Set<string>()
    const startedAt = new Date().toISOString()
    const temporaryPaths = [
      ...(state.tempRoot ? [state.tempRoot] : []),
      ...(state.prepared.temporaryPaths ?? [])
    ].filter(
      (path, index, all) =>
        basename(path).startsWith('.ai-labeler-temp-') &&
        all.indexOf(path) === index
    )

    try {
      changedBeforeProcessing = await this.changedArchiveSourceIds(state)
      validateInputOutputSeparation(state.request.inputs, request.outputParent)
      const selectedOutputBytes = state.summary.files
        .filter(
          (file) =>
            selected.has(file.id) &&
            file.outcome === 'ready' &&
            file.format !== undefined
        )
        .reduce((total, file) => total + file.bytes, 0)
      const requiredForOutput =
        request.mode === 'detect' ? 32 * 1024 ** 2 : selectedOutputBytes
      await assertDiskCapacity(request.outputParent, requiredForOutput)

      outputDirectory = await createUniqueBatchDirectory(
        request.outputParent,
        request.batchId
      )
      deliveryDirectory =
        request.mode === 'detect' ? undefined : outputDirectory
      stagingDirectory =
        request.mode === 'detect'
          ? undefined
          : join(
              outputDirectory,
              `.ai-labeler-temp-staging-${request.batchId}`
            )
      if (deliveryDirectory && stagingDirectory) {
        // Record the safe cleanup target before either mkdir starts so a
        // partial initialization failure cannot leave an untracked staging
        // directory.
        temporaryPaths.push(stagingDirectory)
        await mkdir(stagingDirectory, { mode: 0o700 })
      }

      journal = new RecoveryJournal(this.appDataDirectory, request.batchId)
      await journal.initialize(request.mode, outputDirectory)
      await this.recovery.set({
        batchId: request.batchId,
        createdAt: startedAt,
        // Temporary archive roots are direct children of the selected output
        // parent, so that parent is the canonical cleanup boundary.
        outputDirectory: request.outputParent,
        reportDraftPath: journal.path,
        ...(temporaryPaths.length > 0 ? { temporaryPaths } : {}),
        reason: '批次处理中'
      })
    } catch (error) {
      let outputCleanupSucceeded = true
      if (outputDirectory) {
        try {
          await rm(outputDirectory, { recursive: true, force: true })
        } catch {
          outputCleanupSucceeded = false
        }
      }

      let tempCleanupSucceeded = true
      try {
        await state.prepared.cleanup()
        if (state.tempRoot) {
          await rm(state.tempRoot, { recursive: true, force: true })
        }
      } catch {
        tempCleanupSucceeded = false
      }

      let journalCleanupSucceeded = true
      if (outputCleanupSucceeded && tempCleanupSucceeded) {
        try {
          await (
            journal ??
            new RecoveryJournal(this.appDataDirectory, request.batchId)
          ).remove()
        } catch {
          journalCleanupSucceeded = false
        }
      } else {
        journalCleanupSucceeded = false
      }

      if (
        outputCleanupSucceeded &&
        tempCleanupSucceeded &&
        journalCleanupSucceeded
      ) {
        await this.clearRecoveryIfOwned(request.batchId, false).catch(
          () => undefined
        )
      } else {
        await this.recovery
          .set({
            batchId: request.batchId,
            createdAt: startedAt,
            outputDirectory: request.outputParent,
            ...(journal ? { reportDraftPath: journal.path } : {}),
            ...((!tempCleanupSucceeded || !outputCleanupSucceeded) &&
            temporaryPaths.length > 0
              ? { temporaryPaths }
              : {}),
            reason: `批次初始化失败且存在未清理内容：${errorMessage(error)}`
          })
          .catch(() => undefined)
      }
      this.currentController = undefined
      this.currentOperation = undefined
      throw error
    }

    // From here on the recovery journal and output directory are initialized.
    const activeJournal = journal
    if (!activeJournal || !outputDirectory) {
      this.currentController = undefined
      this.currentOperation = undefined
      throw new AppError('INTERNAL_ERROR', '批次初始化状态不完整')
    }

    const results: FileResult[] = []
    let hardStop = false
    let invalidatedOutputCleanupFailed = false
    let stagingCleanupSucceeded = true

    try {
      const outputRelativePaths =
        request.mode === 'detect'
          ? new Map<string, string>()
          : this.allocateOutputRelativePaths(state, selected)
      assertNoRelativePathCollisions([...outputRelativePaths.values()])

      emit({
        type: 'phase',
        phase: 'processing',
        message:
          request.mode === 'detect' ? '正在生成检测报告…' : '正在处理输出副本…'
      })

      for (const file of state.summary.files) {
        let result: FileResult
        if (file.outcome !== 'ready') {
          result = this.preflightFailureResult(file)
        } else if (!selected.has(file.id)) {
          result = this.unselectedResult(file)
        } else if (changedBeforeProcessing.has(file.sourceId)) {
          result = this.sourceChangedResult(
            file,
            '压缩包在预检后发生变化，本文件未处理'
          )
        } else if (controller.signal.aborted || hardStop) {
          result = this.cancelledResult(file, hardStop)
        } else {
          try {
            result = await this.processFile(
              state,
              file,
              request.mode,
              deliveryDirectory,
              stagingDirectory,
              outputRelativePaths.get(file.id),
              controller.signal,
              emit
            )
          } catch (error) {
            const failure = normalizeFailure(error)
            result = {
              fileId: file.id,
              sourcePath: file.sourcePath,
              sourceType: file.sourceType,
              ...(file.subject ? { originalState: file.subject.state } : {}),
              action: 'skip',
              outcome:
                failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
              errorCode: failure.code,
              errorMessage: failure.message,
              finishedAt: new Date().toISOString()
            }
            hardStop ||= isOutputInfrastructureFailure(error)
          }
        }

        results.push(result)
        await activeJournal.append(result)
        emit({ type: 'file-result', result })
        emit({
          type: 'progress',
          completed: results.length,
          total: state.summary.files.length,
          currentFile: file.sourcePath
        })
      }

      const changedAfterProcessing =
        await this.changedArchiveSourceIds(state)
      if (changedAfterProcessing.size > 0) {
        for (let index = 0; index < results.length; index += 1) {
          const previous = results[index]
          if (!previous) continue
          const scanned = state.summary.files.find(
            (file) => file.id === previous.fileId
          )
          if (
            !scanned ||
            previous.outcome !== 'passed' ||
            scanned.outcome !== 'ready' ||
            !selected.has(scanned.id) ||
            !changedAfterProcessing.has(scanned.sourceId)
          ) {
            continue
          }
          let removalFailure: string | undefined
          if (previous.outputPath) {
            try {
              await this.removeInvalidatedOutput(previous.outputPath)
            } catch (error) {
              removalFailure = errorMessage(error)
              invalidatedOutputCleanupFailed = true
            }
          }
          const corrected: FileResult = {
            ...previous,
            outcome: 'failed',
            errorCode: 'SOURCE_CHANGED',
            errorMessage: removalFailure
              ? `压缩包在批次处理期间发生变化；残留输出删除失败：${removalFailure}`
              : '压缩包在批次处理期间发生变化，已移除对应输出',
            finishedAt: new Date().toISOString()
          }
          if (!removalFailure) delete corrected.outputPath
          results[index] = corrected
          await activeJournal.append(corrected)
          emit({ type: 'file-result', result: corrected })
        }
      }

      if (stagingDirectory) {
        try {
          await this.removeStagingDirectory(stagingDirectory)
        } catch (error) {
          stagingCleanupSucceeded = false
        }
      }

      emit({ type: 'phase', phase: 'reporting', message: '正在整理处理结果…' })
      const finishedAt = new Date().toISOString()
      const counts = calculateCounts(results)

      const summary: BatchSummary = {
        batchId: request.batchId,
        mode: request.mode,
        outputDirectory,
        startedAt,
        finishedAt,
        ...counts,
        results
      }
      emit({
        type: 'phase',
        phase:
          controller.signal.aborted || hardStop ? 'cancelled' : 'complete',
        message: controller.signal.aborted
          ? '批次已取消，已验证的输出已保留'
          : hardStop
            ? '输出位置发生故障，已停止新任务；已验证的输出已保留'
            : '批次处理与二次校验完成'
      })

      let cleanupSucceeded = true
      try {
        await state.prepared.cleanup()
        if (state.tempRoot) {
          await rm(state.tempRoot, { recursive: true, force: true })
        }
      } catch (error) {
        cleanupSucceeded = false
        await this.recovery
          .update({ reason: '批次完成，但临时目录清理失败' })
          .catch(() => undefined)
      }
      if (invalidatedOutputCleanupFailed) {
        await this.recovery
          .update({
            reason:
              '批次已完成，但存在因源压缩包变化而无法删除的残留输出'
          })
          .catch(() => undefined)
      }
      if (!stagingCleanupSucceeded) {
        await this.recovery
          .update({
            reason: '批次已完成，但输出暂存目录清理失败'
          })
          .catch(() => undefined)
      }
      if (
        cleanupSucceeded &&
        stagingCleanupSucceeded &&
        !invalidatedOutputCleanupFailed
      ) {
        await activeJournal.remove()
        await this.clearRecoveryIfOwned(request.batchId, false)
      }
      return summary
    } catch (error) {
      let stagingCleanupFailure: string | undefined
      if (stagingDirectory) {
        try {
          await this.removeStagingDirectory(stagingDirectory)
          stagingCleanupSucceeded = true
        } catch (cleanupError) {
          stagingCleanupSucceeded = false
          stagingCleanupFailure = errorMessage(cleanupError)
        }
      }
      await activeJournal.flush().catch(() => undefined)
      await this.recovery
        .update({
          reason: `批次异常中断：${errorMessage(error)}${
            stagingCleanupFailure
              ? `；输出暂存目录清理失败：${stagingCleanupFailure}`
              : ''
          }`
        })
        .catch(() => undefined)
      throw error
    } finally {
      this.currentController = undefined
      this.currentOperation = undefined
    }
  }

  cancel(): void {
    this.currentController?.abort()
  }

  async dispose(): Promise<void> {
    this.cancel()
    const deadline = Date.now() + 5_000
    while (this.currentOperation && Date.now() < deadline) {
      await delay(50)
    }
    if (!this.currentOperation) await this.cleanupPreviousPreflight()
  }

  private async processFile(
    state: PreflightState,
    file: ScannedFile,
    mode: ProcessRequest['mode'],
    deliveryDirectory: string | undefined,
    stagingDirectory: string | undefined,
    outputRelativePath: string | undefined,
    signal: AbortSignal,
    emit: (event: BatchEvent) => void
  ): Promise<FileResult> {
    throwIfAborted(signal)
    const candidate = state.candidatesById.get(file.id)
    if (!candidate || !file.fingerprint || !file.subject) {
      throw new AppError('INTERNAL_ERROR', '预检文件状态不完整')
    }

    const current = await inspectImage(candidate.canonicalPath)
    if (!fingerprintMatches(file.fingerprint, current.fingerprint)) {
      throw new AppError('SOURCE_CHANGED', '源文件在预检后发生变化')
    }

    if (mode === 'detect') {
      return {
        fileId: file.id,
        sourcePath: file.sourcePath,
        sourceType: file.sourceType,
        originalState: file.subject.state,
        action: 'detect-only',
        outcome: 'passed',
        postVerifyState: current.subject.state,
        sourceSha256: current.fingerprint.sourceSha256,
        payloadSha256: current.payloadSha256,
        finishedAt: new Date().toISOString()
      }
    }

    if (!deliveryDirectory) {
      throw new AppError('INTERNAL_ERROR', '输出图片目录未创建')
    }
    if (!stagingDirectory) {
      throw new AppError('INTERNAL_ERROR', '输出暂存目录未创建')
    }
    if (!outputRelativePath) {
      throw new AppError('INTERNAL_ERROR', '输出图片名称未分配')
    }
    const outputPath = resolveSafeDestination(
      deliveryDirectory,
      outputRelativePath
    )
    const outputParts = parse(outputPath)
    const partialPath = join(
      stagingDirectory,
      `${file.id}-${randomUUID()}${outputParts.ext}`
    )

    try {
      await copyFile(
        candidate.canonicalPath,
        partialPath,
        fsConstants.COPYFILE_EXCL
      )
      await chmod(partialPath, 0o600).catch(() => undefined)
      throwIfAborted(signal)

      const mutation = await mutateTargetSubject(partialPath, mode)
      emit({
        type: 'phase',
        phase: 'verifying',
        message: `正在二次校验：${file.displayName}`
      })
      const verification = await verifyMutatedImage(
        candidate.canonicalPath,
        partialPath,
        mode
      )
      if (
        !verification.postVerified ||
        verification.sourceSha256 !== file.fingerprint.sourceSha256
      ) {
        throw new AppError(
          verification.sourceSha256 !== file.fingerprint.sourceSha256
            ? 'SOURCE_CHANGED'
            : 'POST_VERIFY_FAILED',
          verification.sourceSha256 !== file.fingerprint.sourceSha256
            ? '源文件在复制或二次校验期间发生变化'
            : '输出副本的二次校验未通过'
        )
      }
      // Keep the copy private while mutating, then publish it with normal
      // read permissions for coworkers and downstream upload processes.
      await chmod(partialPath, 0o644).catch(() => undefined)
      await mkdir(dirname(outputPath), { recursive: true })
      await publishFileNoClobber(partialPath, outputPath)
      return {
        fileId: file.id,
        sourcePath: file.sourcePath,
        outputPath,
        sourceType: file.sourceType,
        originalState: file.subject.state,
        action: mutation.action,
        outcome: 'passed',
        postVerifyState: verification.subject.state,
        sourceSha256: verification.sourceSha256,
        outputSha256: verification.outputSha256,
        payloadSha256: verification.payloadSha256,
        finishedAt: new Date().toISOString()
      }
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private allocateOutputRelativePaths(
    state: PreflightState,
    selected: ReadonlySet<string>
  ): Map<string, string> {
    return allocateFlatOutputNames(
      state.summary.files
        .filter((file) => file.outcome === 'ready' && selected.has(file.id))
        .map((file) => ({
          id: file.id,
          relativePath: file.relativePath
        }))
    )
  }

  private sourceChangedResult(
    file: ScannedFile,
    message: string
  ): FileResult {
    return {
      fileId: file.id,
      sourcePath: file.sourcePath,
      sourceType: file.sourceType,
      ...(file.subject ? { originalState: file.subject.state } : {}),
      action: 'skip',
      outcome: 'failed',
      ...(file.fingerprint
        ? { sourceSha256: file.fingerprint.sourceSha256 }
        : {}),
      errorCode: 'SOURCE_CHANGED',
      errorMessage: message,
      finishedAt: new Date().toISOString()
    }
  }

  private cancelledResult(
    file: ScannedFile,
    dueToOutputFailure = false
  ): FileResult {
    return {
      fileId: file.id,
      sourcePath: file.sourcePath,
      sourceType: file.sourceType,
      ...(file.subject ? { originalState: file.subject.state } : {}),
      action: 'skip',
      outcome: 'cancelled',
      ...(file.fingerprint
        ? { sourceSha256: file.fingerprint.sourceSha256 }
        : {}),
      errorCode: dueToOutputFailure ? 'OUTPUT_WRITE_FAILED' : 'CANCELLED',
      errorMessage: dueToOutputFailure
        ? '输出位置发生故障，尚未启动本文件'
        : '用户已取消批次，尚未启动本文件',
      finishedAt: new Date().toISOString()
    }
  }

  private preflightFailureResult(file: ScannedFile): FileResult {
    return {
      fileId: file.id,
      sourcePath: file.sourcePath,
      sourceType: file.sourceType,
      action: 'skip',
      outcome: file.outcome === 'failed' ? 'failed' : 'skipped',
      ...(file.errorCode ? { errorCode: file.errorCode } : {}),
      ...(file.errorMessage ? { errorMessage: file.errorMessage } : {}),
      finishedAt: new Date().toISOString()
    }
  }

  private unselectedResult(file: ScannedFile): FileResult {
    return {
      fileId: file.id,
      sourcePath: file.sourcePath,
      sourceType: file.sourceType,
      ...(file.subject ? { originalState: file.subject.state } : {}),
      action: 'skip',
      outcome: 'skipped',
      ...(file.fingerprint
        ? { sourceSha256: file.fingerprint.sourceSha256 }
        : {}),
      errorMessage: '用户未选择此文件',
      finishedAt: new Date().toISOString()
    }
  }

  private async cleanupPreviousPreflight(): Promise<void> {
    const previous = this.preflightState
    this.preflightState = undefined
    if (!previous) return
    let cleanupSucceeded = true
    try {
      await previous.prepared.cleanup()
      if (previous.tempRoot) {
        await rm(previous.tempRoot, { recursive: true, force: true })
      }
    } catch (error) {
      cleanupSucceeded = false
      const record = await this.recovery.get().catch(() => undefined)
      if (record?.batchId === previous.summary.batchId) {
        await this.recovery
          .update({
            reason: `预检临时目录清理失败：${errorMessage(error)}`
          })
          .catch(() => undefined)
      }
    }
    if (cleanupSucceeded) {
      await this.clearRecoveryIfOwned(
        previous.summary.batchId,
        false
      ).catch(() => undefined)
    }
  }

  private async captureArchiveFingerprints(
    inputs: readonly InputSelection[],
    signal: AbortSignal
  ): Promise<ArchiveFingerprintCapture> {
    const fingerprints = new Map<string, FileFingerprint>()
    const failures: ArchiveFingerprintCapture['failures'] = new Map()
    for (const input of inputs) {
      if (input.kind !== 'archive') continue
      throwIfAborted(signal)
      try {
        const before = await stat(input.path)
        const sourceSha256 = await sha256File(input.path)
        const after = await stat(input.path)
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        ) {
          throw new AppError(
            'SOURCE_CHANGED',
            '压缩包在计算预检指纹时发生变化'
          )
        }
        fingerprints.set(input.id, {
          size: after.size,
          modifiedMs: after.mtimeMs,
          sourceSha256
        })
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          String((error as { code: unknown }).code) === 'CANCELLED'
        ) {
          throw error
        }
        failures.set(input.id, {
          code:
            error instanceof AppError && error.code === 'SOURCE_CHANGED'
              ? 'SOURCE_CHANGED'
              : 'SOURCE_READ_FAILED',
          message:
            error instanceof AppError && error.code === 'SOURCE_CHANGED'
              ? error.message
              : `无法读取压缩包指纹：${input.path}（${errorMessage(error)}）`
        })
      }
    }
    return { fingerprints, failures }
  }

  private async changedArchiveSourceIds(
    state: PreflightState
  ): Promise<Set<string>> {
    const changed = new Set<string>()
    for (const input of state.request.inputs) {
      const expected = state.archiveFingerprints.get(input.id)
      if (!expected) continue
      try {
        const currentStat = await stat(input.path)
        if (
          currentStat.size !== expected.size ||
          currentStat.mtimeMs !== expected.modifiedMs
        ) {
          changed.add(input.id)
          continue
        }
        const sourceSha256 = await sha256File(input.path)
        if (sourceSha256 !== expected.sourceSha256) changed.add(input.id)
      } catch {
        changed.add(input.id)
      }
    }
    return changed
  }

  private async clearRecoveryIfOwned(
    batchId: string,
    removeTemporaryPaths: boolean
  ): Promise<void> {
    const record = await this.recovery.get()
    if (record?.batchId === batchId) {
      await this.recovery.clear(removeTemporaryPaths)
    }
  }
}
