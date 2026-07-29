import { copyFile, readFile, realpath, rm } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from 'node:path'
import type { RecoveryRecord } from '../../shared/contracts'
import { atomicWrite } from './runtime-fs'

async function canonicalizeExistingAncestor(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    const missing: string[] = []
    let cursor = absolute
    while (true) {
      try {
        const ancestor = await realpath(cursor)
        return resolve(ancestor, ...missing.reverse())
      } catch {
        const parent = dirname(cursor)
        if (parent === cursor) return absolute
        missing.push(basename(cursor))
        cursor = parent
      }
    }
  }
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(relation)
  )
}

export class RecoveryStore {
  private readonly path: string

  constructor(appDataDirectory: string) {
    this.path = join(appDataDirectory, 'recovery.json')
  }

  async get(): Promise<RecoveryRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return undefined
      const value = parsed as Record<string, unknown>
      if (
        typeof value.batchId !== 'string' ||
        typeof value.createdAt !== 'string' ||
        typeof value.outputDirectory !== 'string' ||
        typeof value.reason !== 'string'
      ) {
        return undefined
      }
      const record: RecoveryRecord = {
        batchId: value.batchId,
        createdAt: value.createdAt,
        outputDirectory: value.outputDirectory,
        reason: value.reason
      }
      if (typeof value.reportDraftPath === 'string') {
        record.reportDraftPath = value.reportDraftPath
      }
      if (
        Array.isArray(value.temporaryPaths) &&
        value.temporaryPaths.every((path) => typeof path === 'string')
      ) {
        record.temporaryPaths = value.temporaryPaths
      }
      return record
    } catch {
      return undefined
    }
  }

  async set(record: RecoveryRecord): Promise<void> {
    await atomicWrite(this.path, `${JSON.stringify(record, null, 2)}\n`)
  }

  async update(
    update: Partial<Pick<RecoveryRecord, 'reason' | 'reportDraftPath'>>
  ): Promise<void> {
    const current = await this.get()
    if (!current) return
    await this.set({ ...current, ...update })
  }

  async exportTo(directory: string): Promise<string | undefined> {
    const record = await this.get()
    if (!record) return undefined
    const source = record.reportDraftPath ?? this.path
    const destination = join(
      directory,
      `异常中断-${record.batchId}-${basename(source)}`
    )
    await copyFile(source, destination)
    return destination
  }

  async clear(removeTemporaryPaths = true): Promise<void> {
    const record = removeTemporaryPaths ? await this.get() : undefined
    if (record?.temporaryPaths) {
      const cleanupRoot = await canonicalizeExistingAncestor(
        record.outputDirectory
      )
      const validatedTargets: string[] = []
      for (const candidate of record.temporaryPaths) {
        const resolved = await canonicalizeExistingAncestor(candidate)
        const name = basename(resolved)
        if (
          !name.startsWith('.ai-labeler-temp-') ||
          !isStrictDescendant(cleanupRoot, resolved)
        ) {
          throw new Error(`拒绝清理不安全的临时目录：${candidate}`)
        }
        if (!validatedTargets.includes(resolved)) validatedTargets.push(resolved)
      }
      // Validate the complete set before performing the first destructive
      // operation. A malformed record therefore cannot cause partial cleanup.
      for (const target of validatedTargets) {
        await rm(target, { recursive: true, force: true })
      }
    }
    await rm(this.path, { force: true })
  }
}
