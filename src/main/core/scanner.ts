import { constants as fsConstants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs
} from 'node:fs/promises'
import {
  basename,
  extname,
  join,
  resolve
} from 'node:path'
import type {
  ErrorCode,
  ImageFormat,
  InputKind,
  InputSelection,
  SourceType
} from '../../shared/contracts'
import { LIMITS } from '../../shared/contracts'
import {
  ArchiveError,
  cleanupArchiveTemps,
  extractArchive,
  inspectArchive,
  type ArchiveEntryFailure
} from './archive'
import {
  assertNoRelativePathCollisions,
  isSameOrDescendantPath,
  normalizeSafeRelativePath,
  portableFilesystemCaseFold,
  portableRelativePathKey,
  UnsafeRelativePathError
} from './path-safety'

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])
const MAC_ALIAS_SIGNATURE = Buffer.from([
  0x62, 0x6f, 0x6f, 0x6b, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x61, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x00
])
const SHORTCUT_EXTENSION = /\.(?:lnk|alias)$/i
const MAX_PNG_CHUNKS_TO_INSPECT = 100_000

export class InputPreparationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly sourcePath?: string
  ) {
    super(message)
    this.name = 'InputPreparationError'
  }
}

export interface PreparedCandidate {
  sourceId: string
  sourceType: SourceType
  /** Real file path consumed by the metadata engine. */
  sourcePath: string
  /** Canonical real path; equal to sourcePath for extracted archive entries. */
  canonicalPath: string
  displayName: string
  relativePath: string
  bytes: number
  modifiedMs: number
  format?: ImageFormat
  errorCode?: ErrorCode
  errorMessage?: string
}

export interface PreparationIssue {
  sourceId: string
  sourcePath: string
  errorCode: ErrorCode
  errorMessage: string
}

export interface PrepareInputsOptions {
  recursive: boolean
  tempRoot?: string
  signal?: AbortSignal
}

export interface PreparedInputs {
  candidates: PreparedCandidate[]
  totalScannedEntries: number
  totalUncompressedBytes: number
  supportedImages: number
  archiveTemps: string[]
  temporaryPaths: string[]
  archiveEntryFailures: ArchiveEntryFailure[]
  archiveSourceFingerprints: ArchiveSourceFingerprint[]
  issues: PreparationIssue[]
  warnings: string[]
  cleanup(): Promise<void>
}

export interface ArchiveSourceFingerprint {
  sourceId: string
  sourcePath: string
  canonicalPath: string
  bytes: number
  modifiedMs: number
}

interface NormalizedSelection {
  selection: InputSelection
  canonicalPath: string
  actualKind: InputKind
}

interface MutablePreparation {
  candidates: PreparedCandidate[]
  totalScannedEntries: number
  totalUncompressedBytes: number
  supportedImages: number
  archiveTemps: string[]
  archiveEntryFailures: ArchiveEntryFailure[]
  archiveSourceFingerprints: ArchiveSourceFingerprint[]
  issues: PreparationIssue[]
  warnings: string[]
  archiveExtractedBytes: number
  seenCandidatePaths: Set<string>
  seenScannedEntries: Set<string>
  explicitFilePaths: Set<string>
}

interface ImageProbe {
  format?: ImageFormat
  errorCode?: ErrorCode
  errorMessage?: string
}

type OpenFileHandle = Awaited<ReturnType<typeof open>>

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new InputPreparationError('CANCELLED', '操作已取消。')
  }
}

function portablePathKey(path: string): string {
  const normalized = resolve(path).normalize('NFC')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? portableFilesystemCaseFold(normalized)
    : normalized
}

async function isAliasOrShortcut(
  path: string,
  existingHandle?: OpenFileHandle
): Promise<boolean> {
  if (SHORTCUT_EXTENSION.test(path)) return true

  // Current Finder aliases are bookmark files whose data fork starts with
  // "book\0\0\0\0mark\0\0\0\0". This avoids resolving/following an alias,
  // including one whose visible name has no ".alias" suffix. Detect it on
  // Windows too because inputs can arrive through a cross-platform share.
  const handle = existingHandle ?? await open(path, 'r').catch(() => undefined)
  if (!handle) return false
  try {
    const prefix = await readAt(handle, 0, MAC_ALIAS_SIGNATURE.length)
    return prefix.equals(MAC_ALIAS_SIGNATURE)
  } catch {
    return false
  } finally {
    if (!existingHandle) await handle.close().catch(() => undefined)
  }
}

async function normalizeSelections(
  inputs: readonly InputSelection[],
  issues: PreparationIssue[],
  signal?: AbortSignal
): Promise<NormalizedSelection[]> {
  const byCanonical = new Map<
    string,
    Omit<NormalizedSelection, 'groupName'> & { originalIndex: number }
  >()

  for (const [index, selection] of inputs.entries()) {
    throwIfAborted(signal)
    const absolute = resolve(selection.path)

    let sourceStat
    try {
      sourceStat = await lstat(absolute)
    } catch (error) {
      issues.push({
        sourceId: selection.id,
        sourcePath: selection.path,
        errorCode: 'SOURCE_READ_FAILED',
        errorMessage: `无法读取输入：${error instanceof Error ? error.message : String(error)}`
      })
      continue
    }

    if (sourceStat.isSymbolicLink() || await isAliasOrShortcut(absolute)) {
      // Symlinks, Finder aliases and Windows shortcuts are intentionally
      // invisible to the processing set rather than followed.
      continue
    }
    if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
      continue
    }

    const canonicalPath = await realpath(absolute)
    const key = portablePathKey(canonicalPath)
    const actualKind: InputKind = sourceStat.isDirectory()
      ? 'folder'
      : selection.kind === 'archive'
        ? 'archive'
        : 'file'
    const existing = byCanonical.get(key)

    // If the same physical file was selected both as a normal file and via the
    // archive picker, the explicit archive interpretation wins.
    if (
      !existing ||
      (actualKind === 'archive' && existing.actualKind !== 'archive')
    ) {
      byCanonical.set(key, {
        selection,
        canonicalPath,
        actualKind,
        originalIndex: existing?.originalIndex ?? index
      })
    }
  }

  return [...byCanonical.values()]
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((item) => ({
      selection: item.selection,
      canonicalPath: item.canonicalPath,
      actualKind: item.actualKind
    }))
}

function incrementScannedEntry(
  state: MutablePreparation,
  physicalKey: string
): void {
  if (state.seenScannedEntries.has(physicalKey)) return
  state.seenScannedEntries.add(physicalKey)
  state.totalScannedEntries += 1
  if (state.totalScannedEntries > LIMITS.maxScannedEntries) {
    throw new InputPreparationError(
      'ENTRY_LIMIT_EXCEEDED',
      `扫描条目超过 ${LIMITS.maxScannedEntries.toLocaleString('zh-CN')} 个限制。`
    )
  }
}

function addUncompressedBytes(
  state: MutablePreparation,
  bytes: number
): void {
  state.totalUncompressedBytes += bytes
  if (
    !Number.isSafeInteger(state.totalUncompressedBytes) ||
    state.totalUncompressedBytes > LIMITS.maxTotalUncompressedBytes
  ) {
    throw new InputPreparationError(
      'TOTAL_SIZE_LIMIT_EXCEEDED',
      '待处理文件的总大小超过 50 GB 限制。'
    )
  }
}

function extensionCategory(path: string): ImageFormat | undefined {
  const extension = extname(path).toLocaleLowerCase('en-US')
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg'
  if (extension === '.png') return 'png'
  return undefined
}

async function readAt(
  handle: OpenFileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

async function inspectPngAnimation(
  handle: OpenFileHandle,
  size: number
): Promise<'static' | 'animated' | 'malformed'> {
  let offset = PNG_SIGNATURE.length
  let chunkCount = 0
  let sawHeader = false

  while (offset + 12 <= size && chunkCount < MAX_PNG_CHUNKS_TO_INSPECT) {
    const header = await readAt(handle, offset, 8)
    if (header.length !== 8) return 'malformed'
    const dataLength = header.readUInt32BE(0)
    const type = header.subarray(4, 8).toString('ascii')
    const nextOffset = offset + 12 + dataLength
    if (!Number.isSafeInteger(nextOffset) || nextOffset > size) {
      return 'malformed'
    }
    if (chunkCount === 0 && (type !== 'IHDR' || dataLength !== 13)) {
      return 'malformed'
    }
    if (type === 'IHDR') sawHeader = true
    if (type === 'acTL') return sawHeader ? 'animated' : 'malformed'
    if (type === 'IDAT') return sawHeader ? 'static' : 'malformed'
    if (type === 'IEND') return 'malformed'

    offset = nextOffset
    chunkCount += 1
  }
  return 'malformed'
}

async function probeSupportedImageHandle(
  handle: OpenFileHandle,
  path: string,
  bytes: number
): Promise<ImageProbe> {
  const expected = extensionCategory(path)
  const prefix = await readAt(handle, 0, 8)
  const isJpeg =
    prefix.length >= 3 &&
    prefix[0] === 0xff &&
    prefix[1] === 0xd8 &&
    prefix[2] === 0xff
  const isPng = prefix.equals(PNG_SIGNATURE)
  const actual: ImageFormat | undefined = isJpeg
    ? 'jpeg'
    : isPng
      ? 'png'
      : undefined

  if (!expected && actual) {
    return {
      errorCode: 'EXTENSION_MISMATCH',
      errorMessage: '文件内容是受支持图片，但扩展名不是 JPG/JPEG/PNG。'
    }
  }
  if (expected && actual !== expected) {
    return {
      errorCode: 'EXTENSION_MISMATCH',
      errorMessage: '文件扩展名与实际图片结构不匹配。'
    }
  }
  if (!expected || !actual) {
    return {
      errorCode: 'UNSUPPORTED_FORMAT',
      errorMessage: '不是受支持的 JPG/JPEG 或静态 PNG。'
    }
  }
  if (bytes > LIMITS.maxImageBytes) {
    return {
      format: actual,
      errorCode: 'IMAGE_TOO_LARGE',
      errorMessage: '单张图片超过 500 MB 限制。'
    }
  }
  if (actual === 'png') {
    const animation = await inspectPngAnimation(handle, bytes)
    if (animation === 'animated') {
      return {
        errorCode: 'ANIMATED_PNG',
        errorMessage: '不支持 APNG 动画图片。'
      }
    }
    if (animation === 'malformed') {
      return {
        errorCode: 'UNSUPPORTED_FORMAT',
        errorMessage: 'PNG 文件结构不完整或已损坏。'
      }
    }
  }
  return { format: actual }
}

export async function probeSupportedImage(
  path: string,
  bytes: number
): Promise<ImageProbe> {
  const handle = await open(path, 'r')
  try {
    return await probeSupportedImageHandle(handle, path, bytes)
  } finally {
    await handle.close()
  }
}

interface BoundRegularFile {
  handle: OpenFileHandle
  canonicalPath: string
  fileStat: Stats
  verifyUnchanged(): Promise<void>
}

function sameFileIdentity(
  left: Stats,
  right: Stats
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

function assertWithinSelectedRoot(
  canonicalRoot: string | undefined,
  canonicalPath: string,
  sourcePath: string
): void {
  if (
    canonicalRoot &&
    !isSameOrDescendantPath(canonicalRoot, canonicalPath)
  ) {
    throw new InputPreparationError(
      'SOURCE_CHANGED',
      '文件真实路径越过了所选目录，可能在扫描期间被链接替换。',
      sourcePath
    )
  }
}

async function openBoundRegularFile(
  path: string,
  canonicalRoot?: string
): Promise<BoundRegularFile | undefined> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile()) return undefined

  const flags =
    fsConstants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW)
  let handle: OpenFileHandle
  try {
    handle = await open(path, flags)
  } catch (error) {
    throw new InputPreparationError(
      'SOURCE_CHANGED',
      `文件在打开前发生变化或变成链接：${error instanceof Error ? error.message : String(error)}`,
      path
    )
  }

  try {
    const opened = await handle.stat({ bigint: false })
    const canonicalPath = await realpath(path)
    const afterOpen = await lstat(path)
    if (
      !opened.isFile() ||
      afterOpen.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpen)
    ) {
      throw new InputPreparationError(
        'SOURCE_CHANGED',
        '文件在扫描打开期间发生变化。',
        path
      )
    }
    assertWithinSelectedRoot(canonicalRoot, canonicalPath, path)

    const verifyUnchanged = async (): Promise<void> => {
      const [currentHandleStat, currentPathStat, currentCanonicalPath] =
        await Promise.all([
          handle.stat({ bigint: false }),
          lstat(path),
          realpath(path)
        ])
      if (
        currentPathStat.isSymbolicLink() ||
        !sameFileIdentity(opened, currentHandleStat) ||
        !sameFileIdentity(opened, currentPathStat) ||
        portablePathKey(currentCanonicalPath) !== portablePathKey(canonicalPath)
      ) {
        throw new InputPreparationError(
          'SOURCE_CHANGED',
          '文件在结构检查期间发生变化。',
          path
        )
      }
      assertWithinSelectedRoot(canonicalRoot, currentCanonicalPath, path)
    }

    return { handle, canonicalPath, fileStat: opened, verifyUnchanged }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function appendCandidate(
  state: MutablePreparation,
  base: Omit<
    PreparedCandidate,
    'format' | 'errorCode' | 'errorMessage'
  >,
  signal?: AbortSignal,
  existingHandle?: OpenFileHandle,
  verifyUnchanged?: () => Promise<void>
): Promise<void> {
  throwIfAborted(signal)
  const candidateKey = portablePathKey(base.canonicalPath)
  if (state.seenCandidatePaths.has(candidateKey)) return

  let probe: ImageProbe
  try {
    probe = existingHandle
      ? await probeSupportedImageHandle(
          existingHandle,
          base.canonicalPath,
          base.bytes
        )
      : await probeSupportedImage(base.canonicalPath, base.bytes)
  } catch (error) {
    probe = {
      errorCode: 'SOURCE_READ_FAILED',
      errorMessage: `无法读取文件结构：${error instanceof Error ? error.message : String(error)}`
    }
  }
  await verifyUnchanged?.()
  state.seenCandidatePaths.add(candidateKey)

  const candidate: PreparedCandidate = {
    ...base,
    ...(probe.format === undefined ? {} : { format: probe.format }),
    ...(probe.errorCode === undefined
      ? {}
      : { errorCode: probe.errorCode }),
    ...(probe.errorMessage === undefined
      ? {}
      : { errorMessage: probe.errorMessage })
  }
  state.candidates.push(candidate)

  if (
    probe.format &&
    probe.errorCode !== 'EXTENSION_MISMATCH' &&
    probe.errorCode !== 'ANIMATED_PNG' &&
    probe.errorCode !== 'UNSUPPORTED_FORMAT'
  ) {
    state.supportedImages += 1
    if (state.supportedImages > LIMITS.maxSupportedImages) {
      throw new InputPreparationError(
        'IMAGE_LIMIT_EXCEEDED',
        `受支持图片超过 ${LIMITS.maxSupportedImages.toLocaleString('zh-CN')} 张限制。`
      )
    }
  }
}

async function processRegularFile(
  state: MutablePreparation,
  selection: NormalizedSelection,
  absolutePath: string,
  relativeWithinSource: string,
  sourceType: Extract<SourceType, 'direct-file' | 'folder'>,
  countAsScanned: boolean,
  signal?: AbortSignal,
  canonicalRoot?: string
): Promise<void> {
  throwIfAborted(signal)
  const bound = await openBoundRegularFile(absolutePath, canonicalRoot)
  if (!bound) return

  try {
    if (await isAliasOrShortcut(absolutePath, bound.handle)) return

    const physicalKey = portablePathKey(bound.canonicalPath)
    if (countAsScanned) incrementScannedEntry(state, physicalKey)
    if (state.seenCandidatePaths.has(physicalKey)) return

    // A file explicitly selected as an archive/direct file is handled by that
    // selection even if an overlapping folder also contains it.
    if (
      sourceType === 'folder' &&
      state.explicitFilePaths.has(physicalKey)
    ) {
      return
    }

    await appendCandidate(
      state,
      {
        sourceId: selection.selection.id,
        sourceType,
        sourcePath: absolutePath,
        canonicalPath: bound.canonicalPath,
        displayName: basename(absolutePath),
        relativePath: normalizeSafeRelativePath(relativeWithinSource),
        bytes: bound.fileStat.size,
        modifiedMs: bound.fileStat.mtimeMs
      },
      signal,
      bound.handle,
      bound.verifyUnchanged
    )
    addUncompressedBytes(state, bound.fileStat.size)
  } finally {
    await bound.handle.close().catch(() => undefined)
  }
}

async function processFolder(
  state: MutablePreparation,
  selection: NormalizedSelection,
  recursive: boolean,
  signal?: AbortSignal
): Promise<void> {
  const root = selection.canonicalPath
  const pending: Array<{ directory: string; relativeDirectory: string }> = [
    { directory: root, relativeDirectory: '' }
  ]

  while (pending.length > 0) {
    throwIfAborted(signal)
    const current = pending.pop()
    if (!current) break

    let canonicalDirectory: string
    let children
    try {
      const currentStat = await lstat(current.directory)
      canonicalDirectory = await realpath(current.directory)
      if (
        currentStat.isSymbolicLink() ||
        !currentStat.isDirectory() ||
        !isSameOrDescendantPath(root, canonicalDirectory)
      ) {
        throw new InputPreparationError(
          'SOURCE_CHANGED',
          '目录在递归扫描期间被链接替换或越过所选根目录。',
          current.directory
        )
      }
      children = await readdir(canonicalDirectory, { withFileTypes: true })
    } catch (error) {
      state.issues.push({
        sourceId: selection.selection.id,
        sourcePath: current.directory,
        errorCode:
          error instanceof InputPreparationError
            ? error.code
            : 'SOURCE_READ_FAILED',
        errorMessage: `无法读取目录：${error instanceof Error ? error.message : String(error)}`
      })
      continue
    }
    children.sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN')
    )

    for (const child of children) {
      throwIfAborted(signal)
      const absolutePath = join(canonicalDirectory, child.name)
      const relativePath = current.relativeDirectory
        ? join(current.relativeDirectory, child.name)
        : child.name

      let childStat
      try {
        childStat = await lstat(absolutePath)
      } catch (error) {
        incrementScannedEntry(state, portablePathKey(absolutePath))
        state.issues.push({
          sourceId: selection.selection.id,
          sourcePath: absolutePath,
          errorCode: 'SOURCE_READ_FAILED',
          errorMessage: `无法读取条目：${error instanceof Error ? error.message : String(error)}`
        })
        continue
      }

      let canonicalChildPath: string | undefined
      if (!childStat.isSymbolicLink()) {
        try {
          canonicalChildPath = await realpath(absolutePath)
        } catch (error) {
          state.issues.push({
            sourceId: selection.selection.id,
            sourcePath: absolutePath,
            errorCode: 'SOURCE_CHANGED',
            errorMessage: `条目在扫描期间发生变化：${error instanceof Error ? error.message : String(error)}`
          })
          continue
        }
        if (!isSameOrDescendantPath(root, canonicalChildPath)) {
          state.issues.push({
            sourceId: selection.selection.id,
            sourcePath: absolutePath,
            errorCode: 'SOURCE_CHANGED',
            errorMessage: '条目真实路径越过了所选目录。'
          })
          continue
        }
      }

      // Count the directory entry even when intentionally ignored.
      const entryKey = childStat.isSymbolicLink()
        ? portablePathKey(absolutePath)
        : portablePathKey(canonicalChildPath!)
      incrementScannedEntry(state, entryKey)

      if (childStat.isSymbolicLink()) continue
      if (childStat.isDirectory()) {
        if (recursive) {
          pending.push({
            directory: canonicalChildPath!,
            relativeDirectory: relativePath
          })
        }
        continue
      }
      if (!childStat.isFile()) continue

      try {
        await processRegularFile(
          state,
          selection,
          absolutePath,
          relativePath,
          'folder',
          false,
          signal,
          root
        )
      } catch (error) {
        if (
          error instanceof InputPreparationError &&
          isBatchFatalPreparationError(error)
        ) {
          throw error
        }
        state.issues.push({
          sourceId: selection.selection.id,
          sourcePath: absolutePath,
          errorCode:
            error instanceof InputPreparationError
              ? error.code
              : 'SOURCE_READ_FAILED',
          errorMessage: `文件预检失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
  }
}

async function processArchive(
  state: MutablePreparation,
  selection: NormalizedSelection,
  tempRoot: string,
  signal?: AbortSignal
): Promise<void> {
  let inspection
  try {
    inspection = await inspectArchive(
      selection.canonicalPath,
      signal ? { signal } : {}
    )
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new InputPreparationError(
        error.code,
        error.message,
        error.archivePath ?? selection.selection.path
      )
    }
    throw error
  }

  for (const entry of inspection.entries) {
    incrementScannedEntry(
      state,
      `${portablePathKey(inspection.canonicalPath)}::${collisionKeyForEntry(entry.normalizedPath)}`
    )
  }
  addUncompressedBytes(state, inspection.totalUncompressedBytes)
  state.archiveSourceFingerprints.push({
    sourceId: selection.selection.id,
    sourcePath: selection.selection.path,
    canonicalPath: inspection.canonicalPath,
    bytes: inspection.sourceSize,
    modifiedMs: inspection.sourceModifiedMs
  })
  await assertArchiveExtractionCapacity(
    tempRoot,
    inspection.totalUncompressedBytes,
    state.archiveExtractedBytes
  )

  let extraction
  try {
    extraction = await extractArchive(
      inspection,
      tempRoot,
      signal ? { signal } : {}
    )
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new InputPreparationError(
        error.code,
        error.message,
        error.archivePath ?? selection.selection.path
      )
    }
    throw error
  }

  state.archiveTemps.push(extraction.tempDirectory)
  state.archiveExtractedBytes += inspection.totalUncompressedBytes
  state.archiveEntryFailures.push(...extraction.failures)
  state.warnings.push(...extraction.warnings)

  for (const failure of extraction.failures) {
    const entry = inspection.entries.find(
      (candidate) => candidate.path === failure.entryPath
    )
    const relativePath = normalizeSafeRelativePath(failure.entryPath)
    state.candidates.push({
      sourceId: selection.selection.id,
      sourceType: inspection.sourceType,
      sourcePath: `${selection.canonicalPath}::${relativePath}`,
      canonicalPath: `${inspection.canonicalPath}::${relativePath}`,
      displayName: basename(relativePath),
      relativePath,
      bytes: entry?.size ?? 0,
      modifiedMs: 0,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage
    })
  }

  for (const extracted of extraction.files) {
    throwIfAborted(signal)
    let bound: BoundRegularFile | undefined
    try {
      bound = await openBoundRegularFile(
        extracted.extractedPath,
        extraction.tempDirectory
      )
      if (!bound || bound.fileStat.size !== extracted.entry.size) {
        throw new InputPreparationError(
          'SOURCE_CHANGED',
          '解压条目在加入处理队列前发生变化。',
          extracted.entry.normalizedPath
        )
      }
      if (await isAliasOrShortcut(extracted.extractedPath, bound.handle)) {
        continue
      }

      // Archive entries represent distinct logical source paths, even if their
      // contents are byte-identical.
      state.seenCandidatePaths.delete(portablePathKey(bound.canonicalPath))
      await appendCandidate(
        state,
        {
          sourceId: selection.selection.id,
          sourceType: inspection.sourceType,
          sourcePath: bound.canonicalPath,
          canonicalPath: bound.canonicalPath,
          displayName: basename(extracted.entry.normalizedPath),
          relativePath: extracted.entry.normalizedPath,
          bytes: bound.fileStat.size,
          modifiedMs: bound.fileStat.mtimeMs
        },
        signal,
        bound.handle,
        bound.verifyUnchanged
      )
    } catch (error) {
      if (
        error instanceof InputPreparationError &&
        isBatchFatalPreparationError(error)
      ) {
        throw error
      }
      state.candidates.push({
        sourceId: selection.selection.id,
        sourceType: inspection.sourceType,
        sourcePath: `${selection.canonicalPath}::${extracted.entry.normalizedPath}`,
        canonicalPath: `${inspection.canonicalPath}::source-changed:${extracted.entry.normalizedPath}`,
        displayName: basename(extracted.entry.normalizedPath),
        relativePath: extracted.entry.normalizedPath,
        bytes: extracted.entry.size,
        modifiedMs: 0,
        errorCode:
          error instanceof InputPreparationError
            ? error.code
            : 'SOURCE_READ_FAILED',
        errorMessage:
          error instanceof Error ? error.message : String(error)
      })
    } finally {
      await bound?.handle.close().catch(() => undefined)
    }
  }
}

function collisionKeyForEntry(path: string): string {
  return portableRelativePathKey(path)
}

async function assertArchiveExtractionCapacity(
  tempRoot: string,
  nextArchiveBytes: number,
  alreadyExtractedBytes: number
): Promise<void> {
  try {
    await mkdir(tempRoot, { recursive: true })
    const fileSystem = await statfs(tempRoot, { bigint: true })
    const availableBytes = fileSystem.bavail * fileSystem.bsize
    const cumulativeBytes =
      BigInt(alreadyExtractedBytes) + BigInt(nextArchiveBytes)
    const tenPercentReserve = (cumulativeBytes + 9n) / 10n
    const reserve =
      tenPercentReserve > 2n * 1024n ** 3n
        ? tenPercentReserve
        : 2n * 1024n ** 3n
    const required = BigInt(nextArchiveBytes) + reserve
    if (availableBytes < required) {
      throw new InputPreparationError(
        'INSUFFICIENT_DISK_SPACE',
        `临时解压至少还需要 ${required.toLocaleString('zh-CN')} 字节可用空间。`,
        tempRoot
      )
    }
  } catch (error) {
    if (error instanceof InputPreparationError) throw error
    throw new InputPreparationError(
      'OUTPUT_WRITE_FAILED',
      `无法检查临时解压位置容量：${error instanceof Error ? error.message : String(error)}`,
      tempRoot
    )
  }
}

function initialState(explicitFilePaths: Set<string>): MutablePreparation {
  return {
    candidates: [],
    totalScannedEntries: 0,
    totalUncompressedBytes: 0,
    supportedImages: 0,
    archiveTemps: [],
    archiveEntryFailures: [],
    archiveSourceFingerprints: [],
    issues: [],
    warnings: [],
    archiveExtractedBytes: 0,
    seenCandidatePaths: new Set(),
    seenScannedEntries: new Set(),
    explicitFilePaths
  }
}

function sourceTypeForIssue(input: InputSelection | undefined): SourceType {
  if (!input || input.kind === 'file') return 'direct-file'
  if (input.kind === 'folder') return 'folder'
  return extname(input.path).toLocaleLowerCase('en-US') === '.rar'
    ? 'rar'
    : 'zip'
}

function appendIssueCandidates(
  state: MutablePreparation,
  inputs: readonly InputSelection[]
): void {
  const inputsById = new Map(inputs.map((input) => [input.id, input]))
  for (const [index, issue] of state.issues.entries()) {
    const input = inputsById.get(issue.sourceId)
    const displayName =
      basename(issue.sourcePath) || basename(input?.path ?? '') || '输入错误'
    const relativePath = normalizeSafeRelativePath(
      `__input-errors__/${String(index + 1).padStart(5, '0')}-error`
    )
    state.candidates.push({
      sourceId: issue.sourceId,
      sourceType: sourceTypeForIssue(input),
      sourcePath: issue.sourcePath,
      canonicalPath: `${resolve(issue.sourcePath)}::input-error:${index + 1}`,
      displayName,
      relativePath,
      bytes: 0,
      modifiedMs: 0,
      errorCode: issue.errorCode,
      errorMessage: issue.errorMessage
    })
  }
  if (state.issues.length > 0) {
    state.warnings.push(
      `${state.issues.length.toLocaleString('zh-CN')} 个输入条目无法读取或已被拒绝，详情见文件列表和报告。`
    )
  }
}

function isBatchFatalPreparationError(
  error: InputPreparationError
): boolean {
  return new Set<ErrorCode>([
    'CANCELLED',
    'ENTRY_LIMIT_EXCEEDED',
    'IMAGE_LIMIT_EXCEEDED',
    'TOTAL_SIZE_LIMIT_EXCEEDED',
    'INSUFFICIENT_DISK_SPACE',
    'OUTPUT_WRITE_FAILED',
    'INTERNAL_ERROR'
  ]).has(error.code)
}

/**
 * Enumerates user selections without following links, expands validated
 * ZIP/RAR inputs into batch-scoped temporary directories, and returns both
 * valid image candidates and reportable per-file input errors.
 */
export async function prepareInputs(
  inputs: readonly InputSelection[],
  options: PrepareInputsOptions
): Promise<PreparedInputs> {
  const normalizationIssues: PreparationIssue[] = []
  const selections = await normalizeSelections(
    inputs,
    normalizationIssues,
    options.signal
  )
  const explicitFilePaths = new Set(
    selections
      .filter((selection) => selection.actualKind !== 'folder')
      .map((selection) => portablePathKey(selection.canonicalPath))
  )
  const state = initialState(explicitFilePaths)
  state.issues.push(...normalizationIssues)

  const cleanup = async (): Promise<void> => {
    if (state.archiveTemps.length === 0) return
    if (!options.tempRoot) {
      throw new InputPreparationError(
        'INTERNAL_ERROR',
        '缺少压缩包临时目录，无法执行安全清理。'
      )
    }
    await cleanupArchiveTemps(state.archiveTemps, options.tempRoot)
    state.archiveTemps.splice(0)
  }

  try {
    for (const selection of selections) {
      throwIfAborted(options.signal)
      try {
        if (selection.actualKind === 'folder') {
          await processFolder(
            state,
            selection,
            options.recursive,
            options.signal
          )
        } else if (selection.actualKind === 'archive') {
          if (!options.tempRoot) {
            throw new InputPreparationError(
              'OUTPUT_WRITE_FAILED',
              '压缩包预检需要位于输出位置内的临时目录。',
              selection.selection.path
            )
          }
          await processArchive(
            state,
            selection,
            options.tempRoot,
            options.signal
          )
        } else {
          incrementScannedEntry(
            state,
            portablePathKey(selection.canonicalPath)
          )
          await processRegularFile(
            state,
            selection,
            selection.canonicalPath,
            basename(selection.canonicalPath),
            'direct-file',
            false,
            options.signal
          )
        }
      } catch (error) {
        if (
          error instanceof InputPreparationError &&
          !isBatchFatalPreparationError(error)
        ) {
          incrementScannedEntry(
            state,
            `${portablePathKey(selection.canonicalPath)}::rejected-input`
          )
          state.issues.push({
            sourceId: selection.selection.id,
            sourcePath: error.sourcePath ?? selection.selection.path,
            errorCode: error.code,
            errorMessage: error.message
          })
          continue
        }
        throw error
      }
    }

    appendIssueCandidates(state, inputs)
    try {
      const pathsBySource = new Map<string, string[]>()
      for (const candidate of state.candidates) {
        const sourcePaths = pathsBySource.get(candidate.sourceId)
        if (sourcePaths) sourcePaths.push(candidate.relativePath)
        else pathsBySource.set(candidate.sourceId, [candidate.relativePath])
      }
      for (const sourcePaths of pathsBySource.values()) {
        assertNoRelativePathCollisions(sourcePaths)
      }
    } catch (error) {
      if (error instanceof UnsafeRelativePathError) {
        throw new InputPreparationError(
          'OUTPUT_COLLISION',
          error.message,
          error.unsafePath
        )
      }
      throw error
    }

    return {
      candidates: state.candidates,
      totalScannedEntries: state.totalScannedEntries,
      totalUncompressedBytes: state.totalUncompressedBytes,
      supportedImages: state.supportedImages,
      archiveTemps: state.archiveTemps,
      temporaryPaths: state.archiveTemps,
      archiveEntryFailures: state.archiveEntryFailures,
      archiveSourceFingerprints: state.archiveSourceFingerprints,
      issues: state.issues,
      warnings: state.warnings,
      cleanup
    }
  } catch (error) {
    await cleanup().catch(() => undefined)
    if (error instanceof InputPreparationError) throw error
    if (error instanceof ArchiveError) {
      throw new InputPreparationError(
        error.code,
        error.message,
        error.archivePath
      )
    }
    throw new InputPreparationError(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error)
    )
  }
}
