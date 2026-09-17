import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { ExifTool, type ReadRawTaskOptions } from 'exiftool-vendored'
import type {
  BatchAction,
  FileFingerprint,
  ImageFormat,
  OperationMode,
  SubjectAnalysis
} from '../../shared/contracts'
import { LIMITS, TARGET_SUBJECT } from '../../shared/contracts'
import { AppError } from './errors'
import {
  imagePayloadSha256,
  parseImageBuffer,
  type ImageStructure
} from './image-format'
import { inspectEmbeddedXmp } from './xmp'
import { waitForOperation } from './pending-operation'

export { imagePayloadSha256 } from './image-format'

type JsonPrimitive = string | number | boolean | null
export type MetadataValue =
  | JsonPrimitive
  | MetadataValue[]
  | { [key: string]: MetadataValue }
export type MetadataSnapshot = Record<string, MetadataValue>

export interface ImageInspection {
  format: ImageFormat
  width: number
  height: number
  bytes: number
  subject: SubjectAnalysis
  fingerprint: FileFingerprint
  payloadSha256: string
  metadataSnapshot: MetadataSnapshot
}

export interface MutationResult {
  action: Exclude<BatchAction, 'detect-only' | 'skip'>
  originalSubject: SubjectAnalysis
  subject: SubjectAnalysis
  sourceSha256: string
  outputSha256: string
  payloadSha256: string
  payloadUnchanged: boolean
  nonTargetMetadataEqual: boolean
  postVerified: boolean
}

export interface MutationVerification {
  subject: SubjectAnalysis
  sourceSha256: string
  outputSha256: string
  payloadSha256: string
  payloadUnchanged: boolean
  nonTargetMetadataEqual: boolean
  subjectExpectationMet: boolean
  postVerified: boolean
}

const createMetadataTool = (): ExifTool => new ExifTool({
  maxProcs: 2,
  useMWG: false,
  taskTimeoutMillis: 120_000,
  taskRetries: 0
})
let metadataTool = createMetadataTool()
let metadataToolInterrupted = false

function interruptMetadataTool(): void {
  metadataToolInterrupted = true
  void metadataTool.end(false).catch(() => undefined)
}

/** A new batch may retry a stopped engine, but files within a batch cannot. */
export async function prepareMetadataTools(signal: AbortSignal): Promise<void> {
  if (metadataToolClosed) throw new AppError('INTERNAL_ERROR', '元数据引擎已经关闭')
  if (metadataToolInterrupted) {
    metadataTool = createMetadataTool()
    metadataToolInterrupted = false
  }
  try {
    await waitForOperation(
      () => metadataTool.version(),
      30_000,
      '元数据引擎启动超时（30 秒）。请检查 ExifTool 组件是否完整或被安全软件拦截，然后重试。',
      signal,
      interruptMetadataTool
    )
  } catch (error) {
    interruptMetadataTool()
    if (error instanceof AppError) throw error
    throw new AppError('INTERNAL_ERROR', `元数据引擎启动失败：${errorText(error)}`)
  }
}

function readRaw(
  filePath: string,
  options: ReadRawTaskOptions,
  signal?: AbortSignal
): ReturnType<ExifTool['readRaw']> {
  if (metadataToolInterrupted) {
    return Promise.reject(new AppError('INTERNAL_ERROR', '元数据引擎已停止，请重新预检'))
  }
  return waitForOperation(
    () => metadataTool.readRaw(filePath, options),
    300_000,
    `元数据检查超时：${filePath}。请检查该文件和 ExifTool 组件后重新预检。`,
    signal,
    interruptMetadataTool
  )
}

const MISSING_YCBCR_POSITIONING_WARNING =
  'Missing required JPEG IFD0 tag 0x0213 YCbCrPositioning'

let metadataToolClosed = false

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasObjectEntries(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  )
}

function diagnosticsFromRaw(tags: Record<string, unknown>): string[] {
  const messages: string[] = []
  for (const key of ['errors', 'warnings']) {
    const value = tags[key]
    if (Array.isArray(value)) {
      messages.push(
        ...value.filter((item): item is string => typeof item === 'string')
      )
    }
  }
  for (const [key, value] of Object.entries(tags)) {
    if (
      /(?:^|:)(?:Error|Warning)$/u.test(key) &&
      typeof value === 'string' &&
      value.length > 0
    ) {
      messages.push(value)
    }
  }
  if (hasObjectEntries(tags.invalidUtf8Bytes)) {
    messages.push('元数据包含无效 UTF-8 字节')
  }
  return [...new Set(messages)]
}

function isAllowedValidationWarning(
  validation: unknown,
  diagnostics: readonly string[]
): boolean {
  return (
    validation === '1 Warning' &&
    diagnostics.length === 1 &&
    diagnostics[0] === MISSING_YCBCR_POSITIONING_WARNING
  )
}

async function validateMetadataWithExifTool(filePath: string, signal?: AbortSignal): Promise<void> {
  let tags: Record<string, unknown>
  try {
    tags = (await readRaw(filePath, {
      readArgs: ['-G1', '-a', '-s', '-validate', '-warning', '-error'],
      ignoreMinorErrors: false,
      useMWG: false
    }, signal)) as Record<string, unknown>
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('MALFORMED_METADATA', 'ExifTool 无法安全读取元数据', {
      filePath,
      cause: errorText(error)
    })
  }

  const diagnostics = diagnosticsFromRaw(tags)
  const validation = tags['ExifTool:Validate']
  if (
    !isAllowedValidationWarning(validation, diagnostics) &&
    (diagnostics.length > 0 ||
      (validation !== undefined && validation !== 'OK'))
  ) {
    throw new AppError('MALFORMED_METADATA', '图片包含畸形或不一致的元数据', {
      filePath,
      validation,
      diagnostics
    })
  }
}

function toMetadataValue(value: unknown): MetadataValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(toMetadataValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, toMetadataValue(child)])
    )
  }
  return String(value)
}

function targetFreeSubject(value: unknown): MetadataValue[] {
  const values = Array.isArray(value) ? value : [value]
  return values
    .filter(
      (item): item is string =>
        typeof item === 'string' && item !== TARGET_SUBJECT
    )
    .map(toMetadataValue)
}

function shouldExcludeMetadataKey(key: string): boolean {
  return (
    key === 'SourceFile' ||
    key === 'errors' ||
    key === 'warnings' ||
    key === 'invalidUtf8Bytes' ||
    /^(?:ExifTool|System|File|Composite):/u.test(key) ||
    key === 'XMP-x:XMPToolkit'
  )
}

export async function readMetadataSnapshot(
  filePath: string,
  signal?: AbortSignal
): Promise<MetadataSnapshot> {
  let tags: Record<string, unknown>
  try {
    tags = (await readRaw(filePath, {
      readArgs: [
        '-G1',
        '-a',
        '-s',
        '-struct',
        '-n',
        '-all'
      ],
      ignoreMinorErrors: false,
      useMWG: false
    }, signal)) as Record<string, unknown>
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('MALFORMED_METADATA', '无法读取元数据语义快照', {
      filePath,
      cause: errorText(error)
    })
  }

  const diagnostics = diagnosticsFromRaw(tags)
  if (diagnostics.length > 0) {
    throw new AppError('MALFORMED_METADATA', '元数据读取出现错误或警告', {
      filePath,
      diagnostics
    })
  }

  const snapshot: MetadataSnapshot = {}
  for (const [key, value] of Object.entries(tags).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (shouldExcludeMetadataKey(key)) continue
    if (key === 'XMP-dc:Subject') {
      const remaining = targetFreeSubject(value)
      if (remaining.length > 0) snapshot[key] = remaining
      continue
    }
    snapshot[key] = toMetadataValue(value)
  }
  return snapshot
}

export function metadataSnapshotsEqual(
  left: MetadataSnapshot,
  right: MetadataSnapshot
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function stableImageRead(filePath: string): Promise<{
  buffer: Buffer
  modifiedMs: number
  structure: ImageStructure
}> {
  let before
  try {
    before = await stat(filePath)
  } catch (error) {
    throw new AppError('SOURCE_READ_FAILED', `无法读取图片：${filePath}`, {
      cause: errorText(error)
    })
  }
  if (!before.isFile()) {
    throw new AppError('SOURCE_READ_FAILED', '所选路径不是普通文件', {
      filePath
    })
  }
  if (before.size > LIMITS.maxImageBytes) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `单张图片超过 ${LIMITS.maxImageBytes} 字节上限`,
      { filePath, bytes: before.size }
    )
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    throw new AppError('SOURCE_READ_FAILED', `无法读取图片：${filePath}`, {
      cause: errorText(error)
    })
  }
  const after = await stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new AppError('SOURCE_CHANGED', '图片在检查期间发生变化', {
      filePath,
      beforeSize: before.size,
      afterSize: after.size,
      beforeModifiedMs: before.mtimeMs,
      afterModifiedMs: after.mtimeMs
    })
  }

  return {
    buffer,
    modifiedMs: before.mtimeMs,
    structure: parseImageBuffer(buffer, filePath)
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  } catch (error) {
    throw new AppError('SOURCE_READ_FAILED', `无法计算文件 SHA-256：${filePath}`, {
      cause: errorText(error)
    })
  }
}

/**
 * Performs the mandatory read-only inspection for one direct or extracted
 * image. It validates the actual container, size/pixel limits, embedded XMP,
 * and EXIF/XMP consistency before returning a source fingerprint.
 */
export async function inspectImage(filePath: string, signal?: AbortSignal): Promise<ImageInspection> {
  if (metadataToolClosed) {
    throw new AppError('INTERNAL_ERROR', '元数据引擎已经关闭')
  }
  const { buffer, modifiedMs, structure } = await stableImageRead(filePath)
  const sourceSha256 = createHash('sha256').update(buffer).digest('hex')
  const subject = inspectEmbeddedXmp(buffer, structure.format)

  await validateMetadataWithExifTool(filePath, signal)
  const metadataSnapshot = await readMetadataSnapshot(filePath, signal)
  const finalStat = await stat(filePath)
  if (finalStat.size !== buffer.length || finalStat.mtimeMs !== modifiedMs) {
    throw new AppError('SOURCE_CHANGED', '图片在元数据检查期间发生变化', {
      filePath
    })
  }

  return {
    format: structure.format,
    width: structure.width,
    height: structure.height,
    bytes: buffer.length,
    subject,
    fingerprint: {
      size: buffer.length,
      modifiedMs,
      sourceSha256
    },
    payloadSha256: structure.payloadSha256,
    metadataSnapshot
  }
}

function subjectExpectationMet(
  subject: SubjectAnalysis,
  mode: 'add' | 'remove'
): boolean {
  return mode === 'add' ? subject.exactCount === 1 : subject.exactCount === 0
}

function actionFor(
  subject: SubjectAnalysis,
  mode: 'add' | 'remove'
): MutationResult['action'] {
  if (mode === 'remove') {
    return subject.exactCount === 0 ? 'copy-unchanged' : 'remove-standard'
  }
  if (subject.exactCount === 0) return 'add-standard'
  return subject.exactCount === 1
    ? 'copy-unchanged'
    : 'normalize-duplicate'
}

/**
 * Mutates only the supplied path. Callers MUST copy the source into the batch
 * output first and pass that output-copy path here; this API never creates the
 * copy and cannot infer whether a path is an original. Every actual write is
 * immediately re-read and rejected if the payload, non-target metadata, or
 * requested exact target count fails verification.
 */
export async function mutateTargetSubject(
  sourceCopyPath: string,
  mode: Exclude<OperationMode, 'detect'>
): Promise<MutationResult> {
  const before = await inspectImage(sourceCopyPath)
  const action = actionFor(before.subject, mode)

  if (action !== 'copy-unchanged') {
    const edits =
      mode === 'remove'
        ? ([
            {
              tag: 'XMP-dc:Subject',
              operation: 'remove',
              value: TARGET_SUBJECT
            }
          ] as const)
        : before.subject.exactCount > 1
          ? ([
              {
                tag: 'XMP-dc:Subject',
                operation: 'remove',
                value: TARGET_SUBJECT
              },
              {
                tag: 'XMP-dc:Subject',
                operation: 'add',
                value: TARGET_SUBJECT
              }
            ] as const)
          : ([
              {
                tag: 'XMP-dc:Subject',
                operation: 'add',
                value: TARGET_SUBJECT
              }
            ] as const)

    try {
      const result = await metadataTool.editTags(sourceCopyPath, edits, {
        writeArgs: ['-overwrite_original'],
        ignoreMinorErrors: false,
        useMWG: false
      })
      if ((result.warnings?.length ?? 0) > 0 || result.updated !== 1) {
        throw new Error(
          result.warnings?.join('; ') ??
            `ExifTool 未确认更新文件（updated=${result.updated}）`
        )
      }
    } catch (error) {
      throw new AppError('OUTPUT_WRITE_FAILED', '写入目标 XMP 标签失败', {
        filePath: sourceCopyPath,
        cause: errorText(error)
      })
    }
  }

  const after = await inspectImage(sourceCopyPath)
  const payloadUnchanged =
    before.payloadSha256 === after.payloadSha256 &&
    before.format === after.format &&
    before.width === after.width &&
    before.height === after.height
  const nonTargetMetadataEqual = metadataSnapshotsEqual(
    before.metadataSnapshot,
    after.metadataSnapshot
  )
  const expected = subjectExpectationMet(after.subject, mode)

  if (!payloadUnchanged) {
    throw new AppError('PAYLOAD_CHANGED', '写入后图片压缩数据发生变化', {
      filePath: sourceCopyPath
    })
  }
  if (!nonTargetMetadataEqual) {
    throw new AppError('METADATA_CHANGED', '写入后非目标元数据发生语义变化', {
      filePath: sourceCopyPath
    })
  }
  if (!expected) {
    throw new AppError('POST_VERIFY_FAILED', '独立解析器的写入后校验未通过', {
      filePath: sourceCopyPath,
      mode,
      exactCount: after.subject.exactCount
    })
  }

  return {
    action,
    originalSubject: before.subject,
    subject: after.subject,
    sourceSha256: before.fingerprint.sourceSha256,
    outputSha256: after.fingerprint.sourceSha256,
    payloadSha256: after.payloadSha256,
    payloadUnchanged,
    nonTargetMetadataEqual,
    postVerified: true
  }
}

/**
 * Compares an untouched source with a completed output using the independent
 * XMP parser, image-payload hashes and ExifTool semantic snapshots.
 */
export async function verifyMutatedImage(
  sourcePath: string,
  outputPath: string,
  expectedMode: Exclude<OperationMode, 'detect'>
): Promise<MutationVerification> {
  const [source, output] = await Promise.all([
    inspectImage(sourcePath),
    inspectImage(outputPath)
  ])
  const payloadUnchanged =
    source.payloadSha256 === output.payloadSha256 &&
    source.format === output.format &&
    source.width === output.width &&
    source.height === output.height
  const nonTargetMetadataEqual = metadataSnapshotsEqual(
    source.metadataSnapshot,
    output.metadataSnapshot
  )
  const expectationMet = subjectExpectationMet(output.subject, expectedMode)

  return {
    subject: output.subject,
    sourceSha256: source.fingerprint.sourceSha256,
    outputSha256: output.fingerprint.sourceSha256,
    payloadSha256: output.payloadSha256,
    payloadUnchanged,
    nonTargetMetadataEqual,
    subjectExpectationMet: expectationMet,
    postVerified:
      payloadUnchanged && nonTargetMetadataEqual && expectationMet
  }
}

export async function closeMetadataTools(): Promise<void> {
  if (metadataToolClosed) return
  metadataToolClosed = true
  await metadataTool.end()
}
