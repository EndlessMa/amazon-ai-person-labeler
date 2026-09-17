import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PreferencesStore } from '../src/main/core/preferences'
import { RecoveryStore } from '../src/main/core/recovery'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ai-labeler-store-'))
  temporaryDirectories.push(path)
  return path
}

describe('local stores', () => {
  it('stores the approved preferences including the default output folder', async () => {
    const directory = await temporaryDirectory()
    const store = new PreferencesStore(directory)
    expect(await store.get()).toEqual({
      recursive: true,
      showThumbnails: true,
      defaultOutputFolder: ''
    })
    await store.set({
      recursive: false,
      showThumbnails: false,
      defaultOutputFolder: '/share/labelled-images'
    })
    expect(await store.get()).toEqual({
      recursive: false,
      showThumbnails: false,
      defaultOutputFolder: '/share/labelled-images'
    })
  })

  it('persists, exports, and clears an interrupted-batch record', async () => {
    const directory = await temporaryDirectory()
    const exportDirectory = await temporaryDirectory()
    const draft = join(directory, 'draft.csv')
    await writeFile(draft, 'draft')
    const store = new RecoveryStore(directory)
    await store.set({
      batchId: 'batch-1',
      createdAt: '2026-07-29T00:00:00.000Z',
      outputDirectory: '/share/output',
      reportDraftPath: draft,
      temporaryPaths: [],
      reason: '处理中'
    })
    expect((await store.get())?.batchId).toBe('batch-1')
    const exported = await store.exportTo(exportDirectory)
    expect(exported).toBeDefined()
    expect(await readFile(exported!, 'utf8')).toBe('draft')
    await store.clear()
    expect(await store.get()).toBeUndefined()
  })

  it('removes only explicitly named stale tool temp directories', async () => {
    const directory = await temporaryDirectory()
    const staleTemporary = join(directory, '.ai-labeler-temp-batch-2')
    await mkdir(staleTemporary)
    const store = new RecoveryStore(directory)
    await store.set({
      batchId: 'batch-2',
      createdAt: '2026-07-29T00:00:00.000Z',
      outputDirectory: directory,
      temporaryPaths: [staleTemporary],
      reason: '异常中断'
    })
    await store.clear()
    await expect(stat(staleTemporary)).rejects.toThrow()

    await store.set({
      batchId: 'batch-3',
      createdAt: '2026-07-29T00:00:00.000Z',
      outputDirectory: directory,
      temporaryPaths: [directory],
      reason: '异常中断'
    })
    await expect(store.clear()).rejects.toThrow(/不安全/)
    expect((await store.get())?.batchId).toBe('batch-3')
  })

  it('validates every recovery temp path is under the canonical output root before deleting any', async () => {
    const outputRoot = await temporaryDirectory()
    const outsideRoot = await temporaryDirectory()
    const safeTemporary = join(outputRoot, '.ai-labeler-temp-safe')
    const unsafeTemporary = join(outsideRoot, '.ai-labeler-temp-outside')
    await Promise.all([mkdir(safeTemporary), mkdir(unsafeTemporary)])

    const store = new RecoveryStore(outputRoot)
    await store.set({
      batchId: 'batch-safe-boundary',
      createdAt: '2026-07-29T00:00:00.000Z',
      outputDirectory: outputRoot,
      temporaryPaths: [safeTemporary, unsafeTemporary],
      reason: '异常中断'
    })

    await expect(store.clear()).rejects.toThrow(/不安全/)
    expect((await stat(safeTemporary)).isDirectory()).toBe(true)
    expect((await stat(unsafeTemporary)).isDirectory()).toBe(true)
    expect((await store.get())?.batchId).toBe('batch-safe-boundary')
  })
})
