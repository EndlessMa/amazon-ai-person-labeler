import { spawn } from 'node:child_process'
import {
  createReadStream,
  existsSync
} from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat
} from 'node:fs/promises'
import {
  basename,
  extname,
  join,
  relative,
  resolve
} from 'node:path'
import type { ErrorCode, SourceType } from '../../shared/contracts'
import { LIMITS } from '../../shared/contracts'
import {
  assertNoRelativePathCollisions,
  isSameOrDescendantPath,
  normalizeSafeRelativePath,
  portableRelativePathKey,
  resolveSafeDestination,
  UnsafeRelativePathError
} from './path-safety'

const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024
const REJECT_PASSWORD = '__AI_LABELER_REJECTS_ENCRYPTED_ARCHIVES__'
const ARCHIVE_EXTENSION =
  /\.(?:zip|zipx|rar|r\d{2}|7z|tar|tgz|gz|bz2|xz|cab)$/i
const SPLIT_ARCHIVE_NAME =
  /(?:\.part\d+\.rar|\.r\d{2}|\.z\d{2}|\.zip\.\d{3}|\.7z\.\d{3})$/i

export class ArchiveError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly archivePath?: string,
    readonly entryPath?: string
  ) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export interface ArchiveEntry {
  path: string
  normalizedPath: string
  size: number
  packedSize?: number
  modified?: string
  crc?: string
  isDirectory: boolean
  isEncrypted: boolean
  isSymlink: boolean
  isHardlink: boolean
  properties: Readonly<Record<string, string>>
}

export interface ArchiveInspection {
  archivePath: string
  canonicalPath: string
  sourceType: Extract<SourceType, 'zip' | 'rar'>
  format: 'zip' | 'rar4' | 'rar5'
  header: Readonly<Record<string, string>>
  entries: ArchiveEntry[]
  totalUncompressedBytes: number
  sourceSize: number
  sourceModifiedMs: number
}

export interface ArchiveEntryFailure {
  archivePath: string
  entryPath: string
  errorCode: Extract<ErrorCode, 'ARCHIVE_CRC_FAILED' | 'SOURCE_READ_FAILED'>
  errorMessage: string
}

export interface ExtractedArchiveFile {
  entry: ArchiveEntry
  extractedPath: string
}

export interface ArchiveExtraction {
  tempDirectory: string
  files: ExtractedArchiveFile[]
  failures: ArchiveEntryFailure[]
  warnings: string[]
}

export interface ArchiveOperationOptions {
  signal?: AbortSignal
}

export interface ArchiveValidationLimits {
  maxEntries?: number
  maxTotalUncompressedBytes?: number
}

interface SevenZipResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface TechnicalListing {
  header: Record<string, string>
  entries: ArchiveEntry[]
}

let sevenZipExecutablePromise: Promise<string> | undefined

export function getSevenZipExecutable(): Promise<string> {
  sevenZipExecutablePromise ??= import('7zip-bin-full').then(({ path7z }) => {
    // Native executables cannot be spawned from inside app.asar. electron-builder
    // places this dependency in app.asar.unpacked via the package configuration.
    const unpacked = path7z.replace(
      /([\\/])app\.asar([\\/])/,
      '$1app.asar.unpacked$2'
    )
    return existsSync(unpacked) ? unpacked : path7z
  })
  return sevenZipExecutablePromise
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArchiveError('CANCELLED', '操作已取消。')
  }
}

async function runSevenZip(
  args: readonly string[],
  signal?: AbortSignal
): Promise<SevenZipResult> {
  throwIfAborted(signal)
  const executable = await getSevenZipExecutable()

  return await new Promise<SevenZipResult>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false

    const finishWithError = (error: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      rejectPromise(error)
    }
    const abort = (): void => {
      child.kill()
      finishWithError(new ArchiveError('CANCELLED', '操作已取消。'))
    }
    const append = (target: 'stdout' | 'stderr', chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill()
        finishWithError(
          new ArchiveError(
            'ARCHIVE_INDEX_CORRUPT',
            '压缩包技术列表异常大，已停止读取。'
          )
        )
        return
      }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }

    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: string) => append('stdout', chunk))
    child.stderr.on('data', (chunk: string) => append('stderr', chunk))
    child.on('error', (error) => {
      finishWithError(
        new ArchiveError(
          'INTERNAL_ERROR',
          `无法启动压缩包引擎：${error.message}`
        )
      )
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolvePromise({
        exitCode: code ?? 2,
        stdout,
        stderr
      })
    })
    // Never leave 7-Zip waiting for an interactive password.
    child.stdin.end()
  })
}

function parseProperties(lines: readonly string[]): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const line of lines) {
    const separator = line.indexOf(' = ')
    if (separator <= 0) continue
    properties[line.slice(0, separator)] = line.slice(separator + 3)
  }
  return properties
}

function numericProperty(
  properties: Readonly<Record<string, string>>,
  name: string,
  required: boolean
): number | undefined {
  const raw = properties[name]
  if (raw === undefined || raw === '') {
    if (required) {
      throw new ArchiveError(
        'ARCHIVE_INDEX_CORRUPT',
        `压缩包条目缺少 ${name} 字段。`
      )
    }
    return undefined
  }
  if (!/^\d+$/.test(raw)) {
    throw new ArchiveError(
      'ARCHIVE_INDEX_CORRUPT',
      `压缩包条目的 ${name} 字段无效。`
    )
  }

  const value = BigInt(raw)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError(
      'TOTAL_SIZE_LIMIT_EXCEEDED',
      '压缩包声明的文件大小超出可安全处理范围。'
    )
  }
  return Number(value)
}

function propertyIsPositive(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLocaleLowerCase('en-US')
  return normalized !== '' && normalized !== '-' && normalized !== '0' &&
    normalized !== 'false' && normalized !== 'no'
}

function toArchiveEntry(
  properties: Record<string, string>
): ArchiveEntry {
  const rawPath = properties.Path
  if (!rawPath) {
    throw new ArchiveError(
      'ARCHIVE_INDEX_CORRUPT',
      '压缩包条目缺少路径。'
    )
  }

  let normalizedPath: string
  try {
    normalizedPath = normalizeSafeRelativePath(rawPath)
  } catch (error) {
    if (error instanceof UnsafeRelativePathError) {
      throw new ArchiveError(
        'ARCHIVE_PATH_UNSAFE',
        `压缩包包含危险路径：${rawPath}`,
        undefined,
        rawPath
      )
    }
    throw error
  }

  const attributes = properties.Attributes ?? ''
  const mode = properties.Mode ?? ''
  const trimmedAttributes = attributes.trimStart()
  const trimmedMode = mode.trimStart()
  const folder =
    properties.Folder === '+' ||
    /^d/i.test(trimmedAttributes) ||
    /^d/i.test(trimmedMode) ||
    rawPath.endsWith('/') ||
    rawPath.endsWith('\\')
  const symlink =
    propertyIsPositive(properties['Symbolic Link']) ||
    propertyIsPositive(properties.Symlink) ||
    /^l/i.test(trimmedAttributes) ||
    /^l/i.test(trimmedMode) ||
    /(?:^|\s)L(?:\s|$)/.test(attributes) ||
    propertyIsPositive(properties.Reparse)
  const hardlink =
    propertyIsPositive(properties['Hard Link']) ||
    propertyIsPositive(properties.Hardlink)

  const size = numericProperty(properties, 'Size', !folder) ?? 0
  const packedSize = numericProperty(properties, 'Packed Size', false)
  const crc = properties.CRC?.trim().toLocaleUpperCase('en-US')
  if (!folder && (crc === undefined || !/^[0-9A-F]{8}$/.test(crc))) {
    throw new ArchiveError(
      'ARCHIVE_INDEX_CORRUPT',
      `压缩包条目的 CRC 字段缺失或无效：${rawPath}`,
      undefined,
      rawPath
    )
  }

  return {
    path: rawPath,
    normalizedPath,
    size,
    ...(packedSize === undefined ? {} : { packedSize }),
    ...(properties.Modified === undefined
      ? {}
      : { modified: properties.Modified }),
    ...(crc === undefined ? {} : { crc }),
    isDirectory: folder,
    isEncrypted: propertyIsPositive(properties.Encrypted),
    isSymlink: symlink,
    isHardlink: hardlink,
    properties
  }
}

/**
 * Parser for `7z l -slt`. It deliberately consumes only the technical
 * key/value section and rejects records without a path/size later.
 */
export function parseSevenZipTechnicalListing(output: string): TechnicalListing {
  const lines = output.replaceAll('\r\n', '\n').split('\n')
  const divider = lines.findIndex((line) => /^-{10,}\s*$/.test(line))
  if (divider < 0) {
    throw new ArchiveError(
      'ARCHIVE_INDEX_CORRUPT',
      '无法识别压缩包技术列表。'
    )
  }

  const header = parseProperties(lines.slice(0, divider))
  const records: Record<string, string>[] = []
  let recordLines: string[] = []

  const finishRecord = (): void => {
    if (recordLines.length === 0) return
    const record = parseProperties(recordLines)
    if (Object.keys(record).length > 0) records.push(record)
    recordLines = []
  }

  for (const line of lines.slice(divider + 1)) {
    if (!line.trim()) {
      finishRecord()
      continue
    }
    if (line.indexOf(' = ') <= 0) {
      throw new ArchiveError(
        'ARCHIVE_PATH_UNSAFE',
        '压缩包技术列表包含无法安全解析的条目名称。'
      )
    }
    if (line.startsWith('Path = ') && recordLines.some((item) =>
      item.startsWith('Path = ')
    )) {
      finishRecord()
    }
    recordLines.push(line)
  }
  finishRecord()

  return {
    header,
    entries: records.map(toArchiveEntry)
  }
}

function archiveFormatFromListing(
  extension: string,
  listedType: string | undefined
): ArchiveInspection['format'] {
  const type = (listedType ?? '').trim().toLocaleLowerCase('en-US')
  if (extension === '.zip' && type === 'zip') return 'zip'
  if (extension === '.rar' && type === 'rar5') return 'rar5'
  if (extension === '.rar' && type === 'rar') return 'rar4'
  throw new ArchiveError(
    'UNSUPPORTED_FORMAT',
    '文件扩展名与压缩包实际格式不匹配，或格式不是 ZIP/RAR。'
  )
}

function headerIndicatesSplit(
  header: Readonly<Record<string, string>>,
  archivePath: string
): boolean {
  if (SPLIT_ARCHIVE_NAME.test(basename(archivePath))) return true
  const volumeCount = header.Volumes
  if (volumeCount && /^\d+$/.test(volumeCount) && Number(volumeCount) > 1) {
    return true
  }
  return (
    propertyIsPositive(header['Multi-volume']) ||
    propertyIsPositive(header.Multivolume) ||
    /\bVolume\b/i.test(header.Characteristics ?? '')
  )
}

function headerIndicatesSfx(
  header: Readonly<Record<string, string>>
): boolean {
  const offset = header.Offset
  const stubSize = header['Embedded Stub Size']
  return (
    (offset !== undefined && /^\d+$/.test(offset) && BigInt(offset) > 0n) ||
    (
      stubSize !== undefined &&
      /^\d+$/.test(stubSize) &&
      BigInt(stubSize) > 0n
    )
  )
}

function archiveTextIndicatesEncryption(text: string): boolean {
  return /(?:^|\n)\s*(?:error:\s*)?(?:wrong password\b|password is incorrect\b|enter password\b|can(?:not|'t) open encrypted archive\b|headers error.*password)/im.test(
    text
  )
}

function archiveTextIndicatesSplit(text: string): boolean {
  return /(?:^|\n).*(?:missing volume|cannot find volume|unexpected end of archive)/im.test(
    text
  )
}

function archiveTextIndicatesSfx(text: string): boolean {
  return /(?:^|\n)\s*(?:warning:\s*)?(?:the )?archive is open with offset\b|(?:^|\n)\s*Embedded Stub Size\s*=/im.test(
    text
  )
}

export function validateArchiveManifest(
  inspection: Pick<ArchiveInspection, 'archivePath' | 'header' | 'entries'>,
  limits: ArchiveValidationLimits = {}
): number {
  const maxEntries = limits.maxEntries ?? LIMITS.maxScannedEntries
  const maxBytes =
    limits.maxTotalUncompressedBytes ?? LIMITS.maxTotalUncompressedBytes

  if (headerIndicatesSfx(inspection.header)) {
    throw new ArchiveError(
      'ARCHIVE_SFX',
      '不支持自解压（SFX）压缩包。',
      inspection.archivePath
    )
  }
  if (headerIndicatesSplit(inspection.header, inspection.archivePath)) {
    throw new ArchiveError(
      'ARCHIVE_SPLIT',
      '不支持分卷压缩包。',
      inspection.archivePath
    )
  }
  if (inspection.entries.length > maxEntries) {
    throw new ArchiveError(
      'ENTRY_LIMIT_EXCEEDED',
      `压缩包条目数超过 ${maxEntries.toLocaleString('zh-CN')} 个。`,
      inspection.archivePath
    )
  }

  let total = 0
  const normalizedPaths: string[] = []
  const fileKeys = new Set<string>()
  const allKeys = new Set<string>()

  for (const entry of inspection.entries) {
    if (entry.isEncrypted) {
      throw new ArchiveError(
        'ARCHIVE_ENCRYPTED',
        `压缩包条目已加密：${entry.path}`,
        inspection.archivePath,
        entry.path
      )
    }
    if (entry.isSymlink || entry.isHardlink) {
      throw new ArchiveError(
        'ARCHIVE_PATH_UNSAFE',
        `压缩包包含链接条目：${entry.path}`,
        inspection.archivePath,
        entry.path
      )
    }
    if (!entry.isDirectory && ARCHIVE_EXTENSION.test(entry.normalizedPath)) {
      throw new ArchiveError(
        'ARCHIVE_NESTED',
        `压缩包内还有压缩包：${entry.path}`,
        inspection.archivePath,
        entry.path
      )
    }

    normalizedPaths.push(entry.normalizedPath)
    const key = portableRelativePathKey(entry.normalizedPath)
    allKeys.add(key)
    if (!entry.isDirectory) fileKeys.add(key)

    if (!entry.isDirectory) {
      total += entry.size
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        throw new ArchiveError(
          'TOTAL_SIZE_LIMIT_EXCEEDED',
          '压缩包解压后的总大小超过 50 GB 限制。',
          inspection.archivePath
        )
      }
    }
  }

  try {
    assertNoRelativePathCollisions(normalizedPaths)
  } catch (error) {
    if (error instanceof UnsafeRelativePathError) {
      throw new ArchiveError(
        'OUTPUT_COLLISION',
        error.message,
        inspection.archivePath,
        error.unsafePath
      )
    }
    throw error
  }

  // A file named "a" and an entry "a/b" cannot both be created safely.
  for (const fileKey of fileKeys) {
    for (const otherKey of allKeys) {
      if (otherKey !== fileKey && otherKey.startsWith(`${fileKey}/`)) {
        throw new ArchiveError(
          'OUTPUT_COLLISION',
          `压缩包中的文件和目录路径冲突：${fileKey}`,
          inspection.archivePath,
          fileKey
        )
      }
    }
  }
  return total
}

async function readPrefix(path: string, length = 16): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function hasZipSignature(prefix: Buffer): boolean {
  if (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b) {
    return false
  }
  const signature = prefix.subarray(2, 4).toString('hex')
  return ['0304', '0506', '0606', '0708'].includes(signature)
}

function hasRarSignature(prefix: Buffer): boolean {
  return prefix.subarray(0, 7).equals(
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
  ) || prefix.subarray(0, 8).equals(
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  )
}

function hasArchiveSignature(prefix: Buffer): boolean {
  return hasZipSignature(prefix) || hasRarSignature(prefix)
}

export async function inspectArchive(
  archivePath: string,
  options: ArchiveOperationOptions = {}
): Promise<ArchiveInspection> {
  throwIfAborted(options.signal)

  let sourceStat
  try {
    sourceStat = await lstat(archivePath)
  } catch (error) {
    throw new ArchiveError(
      'SOURCE_READ_FAILED',
      `无法读取压缩包：${error instanceof Error ? error.message : String(error)}`,
      archivePath
    )
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new ArchiveError(
      'ARCHIVE_PATH_UNSAFE',
      '压缩包输入必须是普通文件，不能是链接。',
      archivePath
    )
  }

  const extension = extname(archivePath).toLocaleLowerCase('en-US')
  if (extension !== '.zip' && extension !== '.rar') {
    throw new ArchiveError(
      'UNSUPPORTED_FORMAT',
      '仅支持扩展名为 .zip 或 .rar 的压缩包。',
      archivePath
    )
  }

  const result = await runSevenZip(
    [
      'l',
      '-slt',
      '-sccUTF-8',
      '-bd',
      '-y',
      `-p${REJECT_PASSWORD}`,
      '--',
      archivePath
    ],
    options.signal
  )
  const combinedOutput = `${result.stdout}\n${result.stderr}`
  if (archiveTextIndicatesEncryption(combinedOutput)) {
    throw new ArchiveError(
      'ARCHIVE_ENCRYPTED',
      '不支持加密压缩包。',
      archivePath
    )
  }
  if (archiveTextIndicatesSfx(combinedOutput)) {
    throw new ArchiveError(
      'ARCHIVE_SFX',
      '不支持自解压（SFX）压缩包。',
      archivePath
    )
  }
  if (result.exitCode !== 0) {
    if (archiveTextIndicatesSplit(combinedOutput)) {
      throw new ArchiveError(
        'ARCHIVE_SPLIT',
        '压缩包分卷不完整或属于分卷压缩包。',
        archivePath
      )
    }
    throw new ArchiveError(
      'ARCHIVE_INDEX_CORRUPT',
      '压缩包索引损坏或无法读取。',
      archivePath
    )
  }

  let listing: TechnicalListing
  try {
    listing = parseSevenZipTechnicalListing(result.stdout)
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new ArchiveError(
        error.code,
        error.message,
        archivePath,
        error.entryPath
      )
    }
    throw error
  }

  const format = archiveFormatFromListing(extension, listing.header.Type)
  const canonicalPath = await realpath(archivePath)
  const inspection: ArchiveInspection = {
    archivePath,
    canonicalPath,
    sourceType: extension === '.zip' ? 'zip' : 'rar',
    format,
    header: listing.header,
    entries: listing.entries,
    totalUncompressedBytes: 0,
    sourceSize: sourceStat.size,
    sourceModifiedMs: sourceStat.mtimeMs
  }
  inspection.totalUncompressedBytes = validateArchiveManifest(inspection)

  const prefix = await readPrefix(archivePath)
  const signatureMatches =
    (format === 'zip' && hasZipSignature(prefix)) ||
    (format !== 'zip' && hasRarSignature(prefix))
  if (!signatureMatches) {
    throw new ArchiveError(
      'ARCHIVE_SFX',
      '压缩包前存在自解压程序或其他前置数据。',
      archivePath
    )
  }

  const after = await stat(archivePath)
  if (
    after.size !== sourceStat.size ||
    after.mtimeMs !== sourceStat.mtimeMs
  ) {
    throw new ArchiveError(
      'SOURCE_CHANGED',
      '压缩包在预检期间发生变化，请重新预检。',
      archivePath
    )
  }
  return inspection
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export async function crc32File(
  path: string,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal)
  let crc = 0xffffffff
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })

  try {
    for await (const chunkValue of stream) {
      throwIfAborted(signal)
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue)
      for (const byte of chunk) {
        crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
      }
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  return ((crc ^ 0xffffffff) >>> 0)
    .toString(16)
    .padStart(8, '0')
    .toLocaleUpperCase('en-US')
}

async function assertArchiveUnchanged(
  inspection: ArchiveInspection
): Promise<void> {
  const current = await stat(inspection.archivePath)
  if (
    current.size !== inspection.sourceSize ||
    current.mtimeMs !== inspection.sourceModifiedMs
  ) {
    throw new ArchiveError(
      'SOURCE_CHANGED',
      '压缩包在预检后发生变化，请重新预检。',
      inspection.archivePath
    )
  }
}

async function walkExtractedFiles(
  root: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const directories = [root]

  while (directories.length > 0) {
    throwIfAborted(signal)
    const directory = directories.pop()
    if (!directory) break
    const children = await readdir(directory, { withFileTypes: true })

    for (const child of children) {
      throwIfAborted(signal)
      const absolute = join(directory, child.name)
      const childStat = await lstat(absolute)
      const rawRelative = relative(root, absolute)
      let normalized: string
      try {
        normalized = normalizeSafeRelativePath(rawRelative)
      } catch {
        throw new ArchiveError(
          'ARCHIVE_PATH_UNSAFE',
          `解压后发现危险路径：${rawRelative}`
        )
      }

      if (childStat.isSymbolicLink()) {
        throw new ArchiveError(
          'ARCHIVE_PATH_UNSAFE',
          `解压后发现链接：${rawRelative}`
        )
      }
      if (childStat.isDirectory()) {
        directories.push(absolute)
      } else if (childStat.isFile()) {
        files.set(portableRelativePathKey(normalized), absolute)
      } else {
        throw new ArchiveError(
          'ARCHIVE_PATH_UNSAFE',
          `解压后发现非常规文件：${rawRelative}`
        )
      }
    }
  }
  return files
}

function extractionMessage(result: SevenZipResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  return text.length > 800 ? `${text.slice(0, 800)}…` : text
}

function extractionTextIndicatesDiskFull(text: string): boolean {
  return /(?:no space left on device|not enough space on (?:the )?disk|disk full|there is not enough space)/i.test(
    text
  )
}

function extractionTextIndicatesWriteFailure(text: string): boolean {
  return /(?:cannot create|can'?t create|write error|permission denied|read-only file system)/i.test(
    text
  )
}

export async function extractArchive(
  inspection: ArchiveInspection,
  tempRoot: string,
  options: ArchiveOperationOptions = {}
): Promise<ArchiveExtraction> {
  throwIfAborted(options.signal)
  await assertArchiveUnchanged(inspection)
  await mkdir(tempRoot, { recursive: true })
  const canonicalTempRoot = await realpath(tempRoot)
  const tempDirectory = await mkdtemp(join(canonicalTempRoot, 'archive-'))

  try {
    const result = await runSevenZip(
      [
        'x',
        `-o${tempDirectory}`,
        '-aoa',
        '-bd',
        '-bb1',
        '-y',
        `-p${REJECT_PASSWORD}`,
        '--',
        inspection.archivePath
      ],
      options.signal
    )
    const output = `${result.stdout}\n${result.stderr}`
    if (extractionTextIndicatesDiskFull(output)) {
      throw new ArchiveError(
        'INSUFFICIENT_DISK_SPACE',
        '临时解压位置磁盘空间不足。',
        inspection.archivePath
      )
    }
    if (result.exitCode !== 0 && extractionTextIndicatesWriteFailure(output)) {
      throw new ArchiveError(
        'OUTPUT_WRITE_FAILED',
        `无法写入临时解压位置：${extractionMessage(result)}`,
        inspection.archivePath
      )
    }
    if (archiveTextIndicatesEncryption(output)) {
      throw new ArchiveError(
        'ARCHIVE_ENCRYPTED',
        '不支持加密压缩包。',
        inspection.archivePath
      )
    }

    await assertArchiveUnchanged(inspection)
    const extractedFiles = await walkExtractedFiles(
      tempDirectory,
      options.signal
    )
    const expectedFileKeys = new Set(
      inspection.entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => portableRelativePathKey(entry.normalizedPath))
    )
    for (const key of extractedFiles.keys()) {
      if (!expectedFileKeys.has(key)) {
        throw new ArchiveError(
          'ARCHIVE_INDEX_CORRUPT',
          '解压结果包含技术列表中不存在的文件。',
          inspection.archivePath
        )
      }
    }

    const files: ExtractedArchiveFile[] = []
    const failures: ArchiveEntryFailure[] = []
    for (const entry of inspection.entries) {
      if (entry.isDirectory) continue
      throwIfAborted(options.signal)

      const intendedPath = resolveSafeDestination(
        tempDirectory,
        entry.normalizedPath
      )
      const extractedPath =
        extractedFiles.get(portableRelativePathKey(entry.normalizedPath)) ??
        intendedPath

      let extractedStat
      try {
        extractedStat = await lstat(extractedPath)
      } catch {
        failures.push({
          archivePath: inspection.archivePath,
          entryPath: entry.path,
          errorCode: 'ARCHIVE_CRC_FAILED',
          errorMessage: '条目未能完整解压。'
        })
        continue
      }

      let failureMessage: string | undefined
      if (!extractedStat.isFile() || extractedStat.size !== entry.size) {
        failureMessage = '解压后的文件大小与压缩包索引不一致。'
      } else if (entry.crc) {
        const actualCrc = await crc32File(extractedPath, options.signal)
        if (actualCrc !== entry.crc) {
          failureMessage = `CRC 校验失败（索引 ${entry.crc}，实际 ${actualCrc}）。`
        }
      } else {
        // `toArchiveEntry` rejects this for normal runtime listings. Keep the
        // extraction boundary fail-closed for callers constructing an
        // ArchiveInspection directly.
        failureMessage = '压缩包索引缺少可验证的 CRC。'
      }

      if (failureMessage) {
        await rm(extractedPath, { force: true })
        failures.push({
          archivePath: inspection.archivePath,
          entryPath: entry.path,
          errorCode: 'ARCHIVE_CRC_FAILED',
          errorMessage: failureMessage
        })
        continue
      }

      const prefix = await readPrefix(extractedPath)
      if (hasArchiveSignature(prefix)) {
        throw new ArchiveError(
          'ARCHIVE_NESTED',
          `压缩包内含有伪装或嵌套的压缩包：${entry.path}`,
          inspection.archivePath,
          entry.path
        )
      }
      files.push({ entry, extractedPath })
    }

    const warnings: string[] = []
    if (result.exitCode !== 0) {
      if (failures.length === 0) {
        throw new ArchiveError(
          'ARCHIVE_INDEX_CORRUPT',
          `压缩包解压失败：${extractionMessage(result)}`,
          inspection.archivePath
        )
      }
      warnings.push(
        `部分条目解压失败（7-Zip 退出码 ${result.exitCode}），已逐项记录。`
      )
    }
    return { tempDirectory, files, failures, warnings }
  } catch (error) {
    await cleanupArchiveTemp(tempDirectory, canonicalTempRoot)
    throw error
  }
}

export async function cleanupArchiveTemp(
  tempDirectory: string,
  tempRoot: string
): Promise<void> {
  const root = await realpath(resolve(tempRoot)).catch(() => resolve(tempRoot))
  const target = await realpath(resolve(tempDirectory)).catch(
    () => resolve(tempDirectory)
  )
  if (
    target === root ||
    !isSameOrDescendantPath(root, target) ||
    !basename(target).startsWith('archive-')
  ) {
    throw new ArchiveError(
      'INTERNAL_ERROR',
      '拒绝清理不属于本批次的临时目录。'
    )
  }
  await rm(target, { recursive: true, force: true })
}

export async function cleanupArchiveTemps(
  tempDirectories: readonly string[],
  tempRoot: string
): Promise<void> {
  const errors: Error[] = []
  for (const tempDirectory of [...tempDirectories].reverse()) {
    try {
      await cleanupArchiveTemp(tempDirectory, tempRoot)
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, '部分压缩包临时目录清理失败。')
  }
}
