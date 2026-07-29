import {
  lstatSync,
  realpathSync
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  resolve,
  sep
} from 'node:path'
import type { InputSelection } from '../../shared/contracts'

/**
 * A path rejected here must never be handed to an archive extractor as a
 * destination.  We intentionally apply the Windows restrictions on macOS as
 * well: batches are expected to behave consistently on both supported
 * platforms and may be written to a cross-platform share.
 */
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const WINDOWS_INVALID_CHARACTER = /[<>"|?*]/

export class PathSafetyError extends Error {
  readonly code = 'OUTPUT_NESTED_WITH_INPUT' as const

  constructor(
    message: string,
    readonly inputPath?: string,
    readonly outputPath?: string
  ) {
    super(message)
    this.name = 'PathSafetyError'
  }
}

export class UnsafeRelativePathError extends Error {
  readonly code = 'ARCHIVE_PATH_UNSAFE' as const

  constructor(
    message: string,
    readonly unsafePath: string
  ) {
    super(message)
    this.name = 'UnsafeRelativePathError'
  }
}

function realpathOrResolved(path: string): string {
  const absolute = resolve(path)

  try {
    return realpathSync.native(absolute)
  } catch {
    // The final output batch directory usually does not exist at preflight
    // time. Resolve the nearest existing ancestor so a symlink in a parent
    // directory cannot defeat the nesting check.
    const missingParts: string[] = []
    let cursor = absolute

    while (true) {
      try {
        const ancestor = realpathSync.native(cursor)
        return resolve(ancestor, ...missingParts.reverse())
      } catch {
        const parent = dirname(cursor)
        if (parent === cursor) return absolute
        missingParts.push(basename(cursor))
        cursor = parent
      }
    }
  }
}

function comparisonKey(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path).normalize('NFC')
  return platform === 'win32' || platform === 'darwin'
    ? portableFilesystemCaseFold(normalized)
    : normalized
}

/**
 * Conservative case folding for filesystems used by the supported desktop
 * platforms. macOS and Windows equate more names than a simple lowercase
 * transform (for example final sigma, sharp-s and compatibility ligatures).
 * Over-collapsing here only adds a numeric suffix; under-collapsing could
 * overwrite a prior output.
 */
export function portableFilesystemCaseFold(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleUpperCase('en-US')
    .toLocaleLowerCase('en-US')
    .normalize('NFC')
}

export function isSameOrDescendantPath(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const parentKey = comparisonKey(parent, platform)
  const candidateKey = comparisonKey(candidate, platform)
  if (parentKey === candidateKey) return true

  const suffix = parentKey.endsWith(sep) ? '' : sep
  return candidateKey.startsWith(`${parentKey}${suffix}`)
}

/**
 * Rejects selecting an output directory equal to, below, or above any input
 * directory. A normal file/archive may be written beside the output because a
 * file cannot contain the output; a selection declared as a file but actually
 * resolving to a directory is still treated as a directory.
 */
export function validateInputOutputSeparation(
  inputs: readonly Pick<InputSelection, 'path' | 'kind'>[],
  outputParent: string
): void {
  if (!outputParent.trim()) {
    throw new PathSafetyError('必须选择输出目录。', undefined, outputParent)
  }

  const canonicalOutput = realpathOrResolved(outputParent)

  for (const input of inputs) {
    let isDirectory = input.kind === 'folder'

    if (!isDirectory) {
      try {
        isDirectory = lstatSync(input.path).isDirectory()
      } catch {
        // A missing input will be reported by the scanner. It cannot safely be
        // assumed to be a directory here.
      }
    }

    if (!isDirectory) continue

    const canonicalInput = realpathOrResolved(input.path)
    if (
      isSameOrDescendantPath(canonicalInput, canonicalOutput) ||
      isSameOrDescendantPath(canonicalOutput, canonicalInput)
    ) {
      throw new PathSafetyError(
        '输入目录和输出目录不能相同或互相嵌套。',
        input.path,
        outputParent
      )
    }
  }
}

/**
 * Converts an archive/output relative path to portable slash-separated form.
 * It rejects traversal, absolute/device paths, alternate data streams,
 * platform-reserved components and names that Windows would silently trim.
 */
export function normalizeSafeRelativePath(rawPath: string): string {
  if (!rawPath || CONTROL_CHARACTER.test(rawPath)) {
    throw new UnsafeRelativePathError('路径为空或包含控制字符。', rawPath)
  }

  const slashPath = rawPath.replaceAll('\\', '/')
  if (
    slashPath.startsWith('/') ||
    slashPath.startsWith('//') ||
    /^[a-zA-Z]:/.test(slashPath) ||
    isAbsolute(rawPath)
  ) {
    throw new UnsafeRelativePathError('不允许绝对路径或设备路径。', rawPath)
  }

  const result: string[] = []
  for (const component of slashPath.split('/')) {
    if (!component || component === '.') continue
    if (component === '..') {
      throw new UnsafeRelativePathError('路径不能包含“..”跳转。', rawPath)
    }
    if (
      component.includes(':') ||
      WINDOWS_INVALID_CHARACTER.test(component) ||
      component.endsWith('.') ||
      component.endsWith(' ') ||
      WINDOWS_DEVICE_NAME.test(component)
    ) {
      throw new UnsafeRelativePathError(
        '路径包含跨平台不安全或保留的名称。',
        rawPath
      )
    }
    result.push(component)
  }

  if (result.length === 0) {
    throw new UnsafeRelativePathError('路径没有有效名称。', rawPath)
  }
  return result.join('/')
}

export function resolveSafeDestination(root: string, rawPath: string): string {
  const normalized = normalizeSafeRelativePath(rawPath)
  const destination = resolve(root, ...normalized.split('/'))
  if (!isSameOrDescendantPath(resolve(root), destination)) {
    throw new UnsafeRelativePathError('目标路径越过了解压根目录。', rawPath)
  }
  return destination
}

export function portableRelativePathKey(relativePath: string): string {
  return normalizeSafeRelativePath(relativePath)
    .split('/')
    .map(portableFilesystemCaseFold)
    .join('/')
}

export interface RelativePathCollision {
  key: string
  paths: string[]
}

export function findRelativePathCollisions(
  relativePaths: readonly string[]
): RelativePathCollision[] {
  const byKey = new Map<string, string[]>()

  for (const path of relativePaths) {
    const key = portableRelativePathKey(path)
    const existing = byKey.get(key)
    if (existing) existing.push(path)
    else byKey.set(key, [path])
  }

  return [...byKey.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([key, paths]) => ({ key, paths }))
}

export function assertNoRelativePathCollisions(
  relativePaths: readonly string[]
): void {
  const [collision] = findRelativePathCollisions(relativePaths)
  if (!collision) return

  throw new UnsafeRelativePathError(
    `多个文件会写入同一输出路径：${collision.paths.join('；')}`,
    collision.paths[0] ?? ''
  )
}
