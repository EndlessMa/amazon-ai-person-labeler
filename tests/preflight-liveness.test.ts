import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BatchService, type PreparedCandidate } from '../src/main/core/batch-service'
import { RecoveryStore } from '../src/main/core/recovery'
import * as metadata from '../src/main/core/metadata'
import { AppError } from '../src/main/core/errors'
import type { BatchEvent, PreflightRequest } from '../src/shared/contracts'

vi.mock('../src/main/core/metadata', () => ({
  prepareMetadataTools: vi.fn(async () => undefined),
  inspectImage: vi.fn(),
  mutateTargetSubject: vi.fn(),
  sha256File: vi.fn(),
  verifyMutatedImage: vi.fn()
}))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const inspection = {
  format: 'jpeg' as const, bytes: 10, width: 1, height: 1,
  subject: { state: 'untagged' as const, values: [], exactCount: 0, similarValues: [] },
  fingerprint: { size: 10, modifiedMs: 1, sourceSha256: 'source' },
  payloadSha256: 'payload', metadataSnapshot: {}
}
const request: PreflightRequest = { mode: 'add', recursive: true, inputs: [{ id: 'folder', kind: 'folder', path: '/images' }] }
function candidate(name: string): PreparedCandidate {
  return { sourceId: 'folder', sourceType: 'folder', sourcePath: `/images/${name}`, canonicalPath: `/images/${name}`, displayName: name, relativePath: name, bytes: 10, modifiedMs: 1 }
}
async function setup(candidates: PreparedCandidate[], thumbnail?: () => Promise<string | undefined>) {
  const root = await mkdtemp(join(tmpdir(), 'preflight-liveness-'))
  roots.push(root)
  const cleanup = vi.fn(async () => undefined)
  const service = new BatchService({
    appDataDirectory: root, recovery: new RecoveryStore(root),
    prepareInputs: async () => ({ candidates, totalScannedEntries: candidates.length, totalUncompressedBytes: 30, cleanup }),
    ...(thumbnail ? { createThumbnail: thumbnail } : {})
  })
  return { service, cleanup }
}

describe('preflight liveness', () => {
  it('continues without a thumbnail when its decoder never settles', async () => {
    vi.mocked(metadata.inspectImage).mockResolvedValue(inspection)
    const { service } = await setup([candidate('one.jpg')], () => new Promise(() => {}))
    try {
      const result = await service.preflight(request, () => {})
      expect(result.files[0]?.outcome).toBe('ready')
      expect(result.warnings[0]).toContain('缩略图')
    } finally { await service.dispose() }
  })

  it('reports monotonic completion including failures and skips when work finishes out of order', async () => {
    let release!: () => void
    vi.mocked(metadata.inspectImage).mockImplementation(async (path) => {
      if (path.endsWith('slow.jpg')) await new Promise<void>((resolve) => { release = resolve })
      else { release(); throw new AppError('MALFORMED_METADATA', 'bad XMP') }
      return inspection
    })
    const { service } = await setup([candidate('slow.jpg'), candidate('bad.jpg'), { ...candidate('skip.webp'), errorCode: 'UNSUPPORTED_FORMAT' }])
    const events: BatchEvent[] = []
    try {
      const result = await service.preflight(request, (event) => events.push(event))
      const progress = events.filter((event) => event.type === 'progress').map((event) => event.completed)
      expect(progress).toEqual([...progress].sort((a, b) => a - b))
      expect(progress.at(-1)).toBe(3)
      expect(result.files.map((file) => file.outcome)).toEqual(['ready', 'failed', 'skipped'])
    } finally { await service.dispose() }
  })

  it('cancels active reads, drains workers before cleanup, and permits a fresh preflight', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let active = 0
    vi.mocked(metadata.inspectImage).mockImplementation(async (_path, signal) => {
      active++
      started()
      try {
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new AppError('CANCELLED', '操作已取消')), { once: true }))
        return inspection
      } finally { active-- }
    })
    const { service, cleanup } = await setup([candidate('one.jpg'), candidate('two.jpg')])
    cleanup.mockImplementation(async () => { expect(active).toBe(0) })
    const pending = service.preflight(request, () => {})
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await ready
    service.cancel()
    await cancelled
    expect(cleanup).toHaveBeenCalledOnce()
    vi.mocked(metadata.inspectImage).mockResolvedValue(inspection)
    await expect(service.preflight(request, () => {})).resolves.toMatchObject({ supportedImages: 2 })
    await service.dispose()
  })
})
