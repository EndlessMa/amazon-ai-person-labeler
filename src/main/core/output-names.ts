import { createHash } from 'node:crypto'
import { basename, parse } from 'node:path'
import { AppError } from './errors'
import {
  normalizeSafeRelativePath,
  portableRelativePathKey
} from './path-safety'

const MAX_COLLISION_NAME_BYTES = 240
const MAX_COLLISION_NAME_CODE_UNITS = 240
const MAX_SUFFIX_ATTEMPTS = 100_000

export interface FlatOutputCandidate {
  id: string
  relativePath: string
}

export interface SourceAwareOutputCandidate extends FlatOutputCandidate {
  sourceId: string
  /**
   * Folder inputs receive their own top-level output directory. Direct files
   * and archives omit this value and keep the existing flat-output behavior.
   */
  sourceDirectoryName?: string
}

function fitsCollisionNameLimit(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= MAX_COLLISION_NAME_BYTES &&
    value.length <= MAX_COLLISION_NAME_CODE_UNITS
  )
}

function truncateUnicode(
  value: string,
  maxBytes: number,
  maxCodeUnits: number
): string {
  let result = ''

  for (const character of value.normalize('NFC')) {
    const next = `${result}${character}`
    if (
      Buffer.byteLength(next, 'utf8') > maxBytes ||
      next.length > maxCodeUnits
    ) {
      break
    }
    result = next
  }

  return result
}

function collisionName(originalName: string, suffix: number): string {
  const parsed = parse(originalName)
  const suffixText = ` (${suffix})`
  const unchangedStem = `${parsed.name}${suffixText}${parsed.ext}`
  if (fitsCollisionNameLimit(unchangedStem)) {
    return normalizeSafeRelativePath(unchangedStem)
  }

  const digest = createHash('sha256')
    .update(originalName)
    .digest('hex')
    .slice(0, 8)
  const marker = `-${digest}${suffixText}`
  const fixedBytes = Buffer.byteLength(`${marker}${parsed.ext}`, 'utf8')
  const fixedCodeUnits = marker.length + parsed.ext.length
  const truncatedStem = truncateUnicode(
    parsed.name,
    MAX_COLLISION_NAME_BYTES - fixedBytes,
    MAX_COLLISION_NAME_CODE_UNITS - fixedCodeUnits
  )
  if (!truncatedStem) {
    throw new AppError(
      'OUTPUT_COLLISION',
      `文件名过长，无法生成安全的重名副本：${originalName}`
    )
  }
  return normalizeSafeRelativePath(
    `${truncatedStem}${marker}${parsed.ext}`
  )
}

function directoryCollisionName(
  originalName: string,
  suffix: number
): string {
  const suffixText = ` (${suffix})`
  const unchangedName = `${originalName}${suffixText}`
  if (fitsCollisionNameLimit(unchangedName)) {
    return normalizeSafeRelativePath(unchangedName)
  }

  const digest = createHash('sha256')
    .update(originalName)
    .digest('hex')
    .slice(0, 8)
  const marker = `-${digest}${suffixText}`
  const truncatedName = truncateUnicode(
    originalName,
    MAX_COLLISION_NAME_BYTES - Buffer.byteLength(marker, 'utf8'),
    MAX_COLLISION_NAME_CODE_UNITS - marker.length
  )
  if (!truncatedName) {
    throw new AppError(
      'OUTPUT_COLLISION',
      `文件夹名称过长，无法生成安全的重名目录：${originalName}`
    )
  }
  return normalizeSafeRelativePath(`${truncatedName}${marker}`)
}

function safeSourceDirectoryName(
  rawName: string,
  sourceId: string
): string {
  let normalized: string
  try {
    normalized = normalizeSafeRelativePath(basename(rawName))
  } catch {
    const digest = createHash('sha256')
      .update(sourceId)
      .update('\0')
      .update(rawName)
      .digest('hex')
      .slice(0, 8)
    return `输入文件夹-${digest}`
  }

  if (fitsCollisionNameLimit(normalized)) return normalized

  const digest = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 8)
  const marker = `-${digest}`
  const truncatedName = truncateUnicode(
    normalized,
    MAX_COLLISION_NAME_BYTES - Buffer.byteLength(marker, 'utf8'),
    MAX_COLLISION_NAME_CODE_UNITS - marker.length
  )
  if (!truncatedName) {
    return `输入文件夹-${digest}`
  }
  return normalizeSafeRelativePath(`${truncatedName}${marker}`)
}

function assertUniqueCandidateIds(
  files: readonly Pick<FlatOutputCandidate, 'id'>[]
): void {
  const uniqueIds = new Set<string>()
  for (const file of files) {
    if (uniqueIds.has(file.id)) {
      throw new AppError(
        'OUTPUT_COLLISION',
        `输入文件标识重复，无法安全分配输出名称：${file.id}`
      )
    }
    uniqueIds.add(file.id)
  }
}

/**
 * Puts every output directly under the batch directory. Original basenames are preserved
 * whenever possible. Portable-equivalent duplicates receive a numeric suffix;
 * naturally occurring names such as "photo (2).jpg" are reserved first so a
 * generated duplicate never takes them away.
 */
export function allocateFlatOutputNames(
  files: readonly FlatOutputCandidate[]
): Map<string, string> {
  assertUniqueCandidateIds(files)

  const prepared = files.map((file) => {
    const originalName = normalizeSafeRelativePath(
      basename(file.relativePath)
    )
    return {
      ...file,
      originalName,
      originalKey: portableRelativePathKey(originalName)
    }
  })
  const reservedOriginalKeys = new Set(
    prepared.map((file) => file.originalKey)
  )
  const usedKeys = new Set<string>()
  const nextSuffixByOriginalKey = new Map<string, number>()
  const allocated = new Map<string, string>()

  for (const file of prepared) {
    if (!usedKeys.has(file.originalKey)) {
      usedKeys.add(file.originalKey)
      allocated.set(file.id, file.originalName)
      continue
    }

    let suffix = nextSuffixByOriginalKey.get(file.originalKey) ?? 2
    let assigned = false
    for (
      let attempts = 0;
      attempts < MAX_SUFFIX_ATTEMPTS;
      attempts += 1
    ) {
      const candidate = collisionName(file.originalName, suffix)
      const candidateKey = portableRelativePathKey(candidate)
      suffix += 1

      if (
        usedKeys.has(candidateKey) ||
        reservedOriginalKeys.has(candidateKey)
      ) {
        continue
      }

      usedKeys.add(candidateKey)
      allocated.set(file.id, candidate)
      nextSuffixByOriginalKey.set(file.originalKey, suffix)
      assigned = true
      break
    }

    if (!assigned) {
      throw new AppError(
        'OUTPUT_COLLISION',
        `无法为重名图片分配唯一输出名称：${file.originalName}`
      )
    }
  }

  return allocated
}

/**
 * Preserves a separate namespace for every folder input:
 *
 *   images/<input-folder>/<relative-path>
 *
 * Direct files and archive entries intentionally retain the established flat
 * output behavior. Folder names that are portable-equivalent receive a stable
 * numeric suffix, and a folder can never collide with a flat output file at
 * the images/ root.
 */
export function allocateSourceAwareOutputPaths(
  files: readonly SourceAwareOutputCandidate[]
): Map<string, string> {
  assertUniqueCandidateIds(files)

  const flatFiles = files.filter(
    (file) => file.sourceDirectoryName === undefined
  )
  const allocated = allocateFlatOutputNames(flatFiles)
  const usedRootKeys = new Set(
    [...allocated.values()].map(portableRelativePathKey)
  )
  const rawGroupNames = new Map<string, string>()

  for (const file of files) {
    if (file.sourceDirectoryName === undefined) continue
    const existing = rawGroupNames.get(file.sourceId)
    if (
      existing !== undefined &&
      portableRelativePathKey(
        safeSourceDirectoryName(existing, file.sourceId)
      ) !==
        portableRelativePathKey(
          safeSourceDirectoryName(file.sourceDirectoryName, file.sourceId)
        )
    ) {
      throw new AppError(
        'OUTPUT_COLLISION',
        `同一输入来源对应了多个文件夹名称：${file.sourceId}`
      )
    }
    rawGroupNames.set(file.sourceId, existing ?? file.sourceDirectoryName)
  }

  const groups = [...rawGroupNames.entries()].map(([sourceId, rawName]) => {
    const originalName = safeSourceDirectoryName(rawName, sourceId)
    return {
      sourceId,
      originalName,
      originalKey: portableRelativePathKey(originalName)
    }
  })
  const reservedOriginalKeys = new Set(
    groups.map((group) => group.originalKey)
  )
  const nextSuffixByOriginalKey = new Map<string, number>()
  const groupNameBySourceId = new Map<string, string>()

  for (const group of groups) {
    if (!usedRootKeys.has(group.originalKey)) {
      usedRootKeys.add(group.originalKey)
      groupNameBySourceId.set(group.sourceId, group.originalName)
      continue
    }

    let suffix = nextSuffixByOriginalKey.get(group.originalKey) ?? 2
    let assigned = false
    for (
      let attempts = 0;
      attempts < MAX_SUFFIX_ATTEMPTS;
      attempts += 1
    ) {
      const candidate = directoryCollisionName(group.originalName, suffix)
      const candidateKey = portableRelativePathKey(candidate)
      suffix += 1
      if (
        usedRootKeys.has(candidateKey) ||
        reservedOriginalKeys.has(candidateKey)
      ) {
        continue
      }

      usedRootKeys.add(candidateKey)
      groupNameBySourceId.set(group.sourceId, candidate)
      nextSuffixByOriginalKey.set(group.originalKey, suffix)
      assigned = true
      break
    }

    if (!assigned) {
      throw new AppError(
        'OUTPUT_COLLISION',
        `无法为重名输入文件夹分配唯一输出目录：${group.originalName}`
      )
    }
  }

  for (const file of files) {
    if (file.sourceDirectoryName === undefined) continue
    const groupName = groupNameBySourceId.get(file.sourceId)
    if (!groupName) {
      throw new AppError('INTERNAL_ERROR', '输入文件夹输出目录未分配')
    }
    allocated.set(
      file.id,
      normalizeSafeRelativePath(`${groupName}/${file.relativePath}`)
    )
  }

  return allocated
}
