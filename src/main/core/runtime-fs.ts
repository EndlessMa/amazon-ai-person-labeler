import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { AppError } from './errors'

export function createBatchId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14)
  return `${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`
}

function safeDirectoryName(value: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return cleaned || '批次'
}

export async function createUniqueBatchDirectory(
  outputParent: string,
  batchId: string
): Promise<string> {
  const parent = resolve(outputParent)
  const parentStat = await stat(parent)
  if (!parentStat.isDirectory()) {
    throw new AppError('OUTPUT_WRITE_FAILED', '输出位置不是文件夹')
  }

  const base = safeDirectoryName(`AI人物标签-${batchId}`)
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const candidate = join(parent, `${base}${suffix}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
    }
  }
  throw new AppError('OUTPUT_COLLISION', '无法创建唯一的批次输出目录')
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relation = relative(resolve(parentPath), resolve(childPath))
  return relation !== '' && !relation.startsWith(`..${sep}`) && relation !== '..'
}

export function assertPathsDoNotNest(
  inputPaths: string[],
  outputParent: string
): void {
  const output = resolve(outputParent)
  for (const inputPath of inputPaths) {
    const input = resolve(inputPath)
    if (
      input === output ||
      isPathInside(input, output) ||
      isPathInside(output, input)
    ) {
      throw new AppError(
        'OUTPUT_NESTED_WITH_INPUT',
        `输入与输出位置不能互相包含：${inputPath}`
      )
    }
  }
}

export async function availableDiskBytes(path: string): Promise<number> {
  const stats = await statfs(path)
  return Number(stats.bavail) * Number(stats.bsize)
}

export function requiredDiskBytes(estimatedPeakBytes: number): number {
  return (
    estimatedPeakBytes +
    Math.max(Math.ceil(estimatedPeakBytes * 0.1), 2 * 1024 ** 3)
  )
}

export async function assertDiskCapacity(
  outputParent: string,
  estimatedPeakBytes: number
): Promise<number> {
  const available = await availableDiskBytes(outputParent)
  const required = requiredDiskBytes(estimatedPeakBytes)
  if (available < required) {
    throw new AppError('INSUFFICIENT_DISK_SPACE', '输出磁盘可用空间不足', {
      available,
      required,
      estimatedPeakBytes
    })
  }
  return available
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
}

function publishError(error: unknown, destination: string): AppError {
  const originalCode = filesystemErrorCode(error)
  if (originalCode === 'EEXIST' || originalCode === 'ENOTEMPTY') {
    return new AppError(
      'OUTPUT_COLLISION',
      `输出文件名发生冲突，未覆盖已有文件：${destination}`,
      { originalCode, destination }
    )
  }
  return new AppError(
    'OUTPUT_WRITE_FAILED',
    `无法写入输出文件：${destination}`,
    {
      originalCode,
      destination,
      cause: error instanceof Error ? error.message : String(error)
    }
  )
}

/**
 * Publishes a fully verified staged file without ever replacing an existing
 * destination. A hard link gives an atomic publish on normal local filesystems;
 * exclusive copy is the compatibility fallback for shares without hard links.
 */
export async function publishFileNoClobber(
  stagedPath: string,
  destination: string
): Promise<void> {
  try {
    await link(stagedPath, destination)
  } catch (error) {
    const code = filesystemErrorCode(error)
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw publishError(error, destination)
    }
    if (
      ![
        'EACCES',
        'EPERM',
        'ENOTSUP',
        'EOPNOTSUPP',
        'ENOSYS',
        'EXDEV',
        'EINVAL'
      ].includes(code)
    ) {
      throw publishError(error, destination)
    }

    try {
      await copyFile(stagedPath, destination, fsConstants.COPYFILE_EXCL)
    } catch (copyError) {
      throw publishError(copyError, destination)
    }
  }

  // Publishing already succeeded. A leftover private staging link/copy can be
  // removed by the batch-level staging cleanup without invalidating output.
  await rm(stagedPath, { force: true }).catch(() => undefined)
}

export async function atomicWrite(
  destination: string,
  data: string | Uint8Array
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
