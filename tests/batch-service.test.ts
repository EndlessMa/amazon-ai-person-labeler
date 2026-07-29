import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { prepareInputsForBatch } from '../src/main/input-adapter'
import { BatchService } from '../src/main/core/batch-service'
import {
  closeMetadataTools,
  inspectImage,
  sha256File
} from '../src/main/core/metadata'
import { RecoveryStore } from '../src/main/core/recovery'
import type {
  BatchEvent,
  OperationMode,
  PreflightSummary
} from '../src/shared/contracts'

const FIXTURES = resolve(process.cwd(), 'regression-fixtures')
const IMAGE_FIXTURES = join(FIXTURES, 'images')
const NORMAL_ARCHIVE = join(FIXTURES, 'normal.zip')
const temporaryRoots = new Set<string>()
const discardEvent = (_event: BatchEvent): void => undefined

async function makeTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.add(root)
  return root
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }

  await visit(root)
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function isDirectChild(root: string, path: string): boolean {
  return relative(root, path).split(/[\\/]/).length === 1
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    (await listFiles(root)).map(async (path) => [
      relative(root, path),
      await sha256File(path)
    ] as const)
  )
  return Object.fromEntries(entries)
}

async function expectReportArtifacts(
  reportPath: string,
  logPath: string
): Promise<void> {
  const [report, log, reportStats, logStats] = await Promise.all([
    readFile(reportPath, 'utf8'),
    readFile(logPath, 'utf8'),
    stat(reportPath),
    stat(logPath)
  ])
  expect(reportStats.isFile()).toBe(true)
  expect(logStats.isFile()).toBe(true)
  expect(report.startsWith('\uFEFF')).toBe(true)
  expect(report).toContain('批次ID')
  expect(report).toContain('源文件SHA-256')
  expect(log).toContain('"event":"batch-start"')
  expect(log).toContain('"event":"batch-complete"')
}

async function createService(root: string): Promise<{
  service: BatchService
  recovery: RecoveryStore
}> {
  const appDataDirectory = join(root, 'app-data')
  await mkdir(appDataDirectory, { recursive: true })
  const recovery = new RecoveryStore(appDataDirectory)
  return {
    service: new BatchService({
      appDataDirectory,
      recovery,
      prepareInputs: prepareInputsForBatch,
      shouldCreateThumbnails: async () => false
    }),
    recovery
  }
}

function selectedReadyFiles(preflight: PreflightSummary): string[] {
  return preflight.files
    .filter((file) => file.outcome === 'ready')
    .map((file) => file.id)
}

async function runFolderBatch(
  root: string,
  mode: OperationMode,
  inputFolder: string
) {
  const outputParent = join(root, `${mode}-output`)
  await mkdir(outputParent, { recursive: true })
  const { service, recovery } = await createService(
    join(root, `${mode}-service`)
  )

  try {
    const preflight = await service.preflight(
      {
        mode,
        recursive: true,
        inputs: [{ id: `${mode}-folder`, path: inputFolder, kind: 'folder' }],
        outputParent
      },
      discardEvent
    )
    const ready = preflight.files.filter((file) => file.outcome === 'ready')
    expect(ready).toHaveLength(5)

    const summary = await service.process(
      {
        batchId: preflight.batchId,
        mode,
        selectedFileIds: selectedReadyFiles(preflight),
        outputParent
      },
      discardEvent
    )
    return { preflight, ready, summary }
  } finally {
    await service.dispose()
    await recovery.clear().catch(() => undefined)
  }
}

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true })
  }
  temporaryRoots.clear()
})

afterAll(async () => {
  await closeMetadataTools()
})

describe.sequential('BatchService + prepareInputsForBatch 真实端到端', () => {
  it(
    'detect/add/remove 保持源文件不变，并生成完整且通过二次校验的交付物',
    async () => {
      const root = await makeTemporaryRoot('ai-label-batch-e2e-')
      const originalSourceHashes = await hashTree(IMAGE_FIXTURES)

      const detected = await runFolderBatch(root, 'detect', IMAGE_FIXTURES)
      expect(detected.summary.results).toHaveLength(8)
      expect(detected.summary.succeeded).toBe(5)
      expect(detected.summary.failed).toBe(1)
      expect(detected.summary.skipped).toBe(2)
      await expect(
        access(join(detected.summary.outputDirectory, 'images'))
      ).rejects.toThrow()
      await expectReportArtifacts(
        detected.summary.reportPath,
        detected.summary.logPath
      )
      expect(await hashTree(IMAGE_FIXTURES)).toEqual(originalSourceHashes)

      const added = await runFolderBatch(root, 'add', IMAGE_FIXTURES)
      const addedImagesRoot = join(added.summary.outputDirectory, 'images')
      const addedSourceRoot = join(
        addedImagesRoot,
        basename(IMAGE_FIXTURES)
      )
      const addedImages = await listFiles(addedImagesRoot)
      expect(added.summary.results).toHaveLength(8)
      expect(
        added.summary.succeeded,
        JSON.stringify(
          added.summary.results.map((result) => ({
            sourcePath: result.sourcePath,
            outcome: result.outcome,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage
          })),
          null,
          2
        )
      ).toBe(5)
      expect(added.summary.failed).toBe(1)
      expect(added.summary.skipped).toBe(2)
      expect(addedImages).toHaveLength(added.ready.length)
      expect(addedImages.every((output) =>
        isDirectChild(addedSourceRoot, output)
      )).toBe(true)
      expect(
        added.summary.results
          .filter((result) => result.outcome === 'passed')
          .every((result) => result.outputPath !== undefined)
      ).toBe(true)
      for (const output of addedImages) {
        const inspected = await inspectImage(output)
        expect(inspected.subject.exactCount).toBe(1)
        expect(inspected.subject.state).toBe('compliant')
        if (process.platform !== 'win32') {
          expect((await stat(output)).mode & 0o444).toBe(0o444)
        }
      }
      await expectReportArtifacts(
        added.summary.reportPath,
        added.summary.logPath
      )
      expect(await hashTree(IMAGE_FIXTURES)).toEqual(originalSourceHashes)

      const addedSourceHashes = await hashTree(addedImagesRoot)
      const removed = await runFolderBatch(root, 'remove', addedSourceRoot)
      const removedImagesRoot = join(
        removed.summary.outputDirectory,
        'images'
      )
      const removedSourceRoot = join(
        removedImagesRoot,
        basename(addedSourceRoot)
      )
      const removedImages = await listFiles(removedImagesRoot)
      expect(removed.summary.results).toHaveLength(5)
      expect(removed.summary.succeeded).toBe(5)
      expect(removed.summary.failed).toBe(0)
      expect(removed.summary.skipped).toBe(0)
      expect(removedImages).toHaveLength(removed.ready.length)
      expect(removedImages.every((output) =>
        isDirectChild(removedSourceRoot, output)
      )).toBe(true)
      for (const output of removedImages) {
        const inspected = await inspectImage(output)
        expect(inspected.subject.exactCount).toBe(0)
      }
      await expectReportArtifacts(
        removed.summary.reportPath,
        removed.summary.logPath
      )
      expect(await hashTree(addedImagesRoot)).toEqual(addedSourceHashes)
      expect(await hashTree(IMAGE_FIXTURES)).toEqual(originalSourceHashes)
    },
    120_000
  )

  it(
    '两个输入文件夹含同名图片时均通过预检并输出到各自顶层文件夹',
    async () => {
      const root = await makeTemporaryRoot('ai-label-folder-groups-e2e-')
      const firstDirectory = join(root, '牛油果收纳盒')
      const secondDirectory = join(root, '沙拉罐图片')
      const firstImage = join(firstDirectory, '主图.png')
      const secondImage = join(secondDirectory, '主图.png')
      const outputParent = join(root, 'output')
      await Promise.all([
        mkdir(firstDirectory, { recursive: true }),
        mkdir(secondDirectory, { recursive: true }),
        mkdir(outputParent, { recursive: true })
      ])
      await Promise.all([
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), firstImage),
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), secondImage)
      ])
      const { service, recovery } = await createService(
        join(root, 'folder-groups-service')
      )

      try {
        const preflight = await service.preflight(
          {
            mode: 'add',
            recursive: true,
            inputs: [
              {
                id: 'first-folder',
                path: firstDirectory,
                kind: 'folder'
              },
              {
                id: 'second-folder',
                path: secondDirectory,
                kind: 'folder'
              }
            ],
            outputParent
          },
          discardEvent
        )
        const ready = preflight.files.filter(
          (file) => file.outcome === 'ready'
        )
        expect(preflight.supportedImages).toBe(2)
        expect(ready).toHaveLength(2)
        expect(new Set(ready.map((file) => file.id)).size).toBe(2)
        expect(ready.map((file) => file.relativePath)).toEqual([
          '主图.png',
          '主图.png'
        ])
        expect(ready.map((file) => file.sourceId)).toEqual([
          'first-folder',
          'second-folder'
        ])

        const summary = await service.process(
          {
            batchId: preflight.batchId,
            mode: 'add',
            selectedFileIds: selectedReadyFiles(preflight),
            outputParent
          },
          discardEvent
        )
        const imagesRoot = join(summary.outputDirectory, 'images')
        const firstOutput = join(imagesRoot, '牛油果收纳盒', '主图.png')
        const secondOutput = join(imagesRoot, '沙拉罐图片', '主图.png')
        const topLevelEntries = await readdir(imagesRoot, {
          withFileTypes: true
        })

        expect(summary.results).toHaveLength(2)
        expect(summary.succeeded).toBe(2)
        expect(summary.failed).toBe(0)
        expect(summary.skipped).toBe(0)
        expect(summary.cancelled).toBe(0)
        expect(
          topLevelEntries
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right, 'zh-CN'))
        ).toEqual(
          ['牛油果收纳盒', '沙拉罐图片'].sort((left, right) =>
            left.localeCompare(right, 'zh-CN')
          )
        )
        expect(topLevelEntries.every((entry) => entry.isDirectory())).toBe(
          true
        )
        expect(await listFiles(imagesRoot)).toEqual(
          [firstOutput, secondOutput].sort((left, right) =>
            left.localeCompare(right, 'zh-CN')
          )
        )
        expect(
          Object.fromEntries(
            summary.results.map((result) => [
              result.sourcePath,
              result.outputPath
            ])
          )
        ).toEqual({
          [await realpath(firstImage)]: firstOutput,
          [await realpath(secondImage)]: secondOutput
        })
        for (const output of [firstOutput, secondOutput]) {
          const inspected = await inspectImage(output)
          expect(inspected.subject.exactCount).toBe(1)
          expect(inspected.subject.state).toBe('compliant')
        }
      } finally {
        await service.dispose()
        await recovery.clear().catch(() => undefined)
      }
    },
    120_000
  )

  it(
    '多张图片直接平铺到 images，跨平台重名时只给重复文件追加序号',
    async () => {
      const root = await makeTemporaryRoot('ai-label-flat-output-e2e-')
      const firstDirectory = join(root, '第一组')
      const secondDirectory = join(root, '第二组')
      const outputParent = join(root, 'output')
      const firstDuplicate = join(firstDirectory, '主图.png')
      const secondDuplicate = join(secondDirectory, '主图.PNG')
      const unique = join(secondDirectory, '细节图.jpg')
      const legacyPartialName = `照片.partial-${process.pid}.png`
      const legacyPartialCollision = join(firstDirectory, legacyPartialName)
      const legacyPartialBase = join(secondDirectory, '照片.png')
      await Promise.all([
        mkdir(firstDirectory, { recursive: true }),
        mkdir(secondDirectory, { recursive: true }),
        mkdir(outputParent, { recursive: true })
      ])
      await Promise.all([
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), firstDuplicate),
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), secondDuplicate),
        copyFile(join(IMAGE_FIXTURES, '07-未标记.jpg'), unique),
        copyFile(
          join(IMAGE_FIXTURES, '01-未标记.png'),
          legacyPartialCollision
        ),
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), legacyPartialBase)
      ])
      const { service, recovery } = await createService(
        join(root, 'flat-output-service')
      )

      try {
        const preflight = await service.preflight(
          {
            mode: 'add',
            recursive: true,
            inputs: [
              { id: 'first-duplicate', path: firstDuplicate, kind: 'file' },
              {
                id: 'second-duplicate',
                path: secondDuplicate,
                kind: 'file'
              },
              { id: 'unique', path: unique, kind: 'file' },
              {
                id: 'legacy-partial-collision',
                path: legacyPartialCollision,
                kind: 'file'
              },
              {
                id: 'legacy-partial-base',
                path: legacyPartialBase,
                kind: 'file'
              }
            ],
            outputParent
          },
          discardEvent
        )
        expect(selectedReadyFiles(preflight)).toHaveLength(5)

        const summary = await service.process(
          {
            batchId: preflight.batchId,
            mode: 'add',
            selectedFileIds: selectedReadyFiles(preflight),
            outputParent
          },
          discardEvent
        )
        const imagesRoot = join(summary.outputDirectory, 'images')
        const outputNames = (await readdir(imagesRoot)).sort((left, right) =>
          left.localeCompare(right, 'zh-CN')
        )

        expect(summary.succeeded).toBe(5)
        expect(outputNames).toEqual(
          [
            '主图.png',
            '主图 (2).PNG',
            '细节图.jpg',
            legacyPartialName,
            '照片.png'
          ].sort((left, right) => left.localeCompare(right, 'zh-CN'))
        )
        for (const entry of await readdir(imagesRoot, {
          withFileTypes: true
        })) {
          expect(entry.isFile()).toBe(true)
        }
        expect(
          (await readdir(summary.outputDirectory)).filter((name) =>
            name.startsWith('.ai-labeler-temp-staging-')
          )
        ).toEqual([])
        for (const result of summary.results) {
          if (result.outcome !== 'passed' || !result.outputPath) continue
          expect(resolve(result.outputPath, '..')).toBe(resolve(imagesRoot))
          expect((await inspectImage(result.outputPath)).subject.exactCount).toBe(
            1
          )
        }
      } finally {
        await service.dispose()
        await recovery.clear().catch(() => undefined)
      }
    },
    120_000
  )

  it(
    '暂存目录清理失败时保留恢复记录，并允许后续安全清理',
    async () => {
      const root = await makeTemporaryRoot('ai-label-staging-recovery-')
      const input = join(root, '待处理.png')
      const outputParent = join(root, 'output')
      const appDataDirectory = join(root, 'app-data')
      await Promise.all([
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), input),
        mkdir(outputParent, { recursive: true }),
        mkdir(appDataDirectory, { recursive: true })
      ])
      const recovery = new RecoveryStore(appDataDirectory)
      const service = new BatchService({
        appDataDirectory,
        recovery,
        prepareInputs: prepareInputsForBatch,
        shouldCreateThumbnails: async () => false,
        removeStagingDirectory: async () => {
          throw new Error('simulated staging cleanup failure')
        }
      })

      try {
        const preflight = await service.preflight(
          {
            mode: 'add',
            recursive: true,
            inputs: [{ id: 'input', path: input, kind: 'file' }],
            outputParent
          },
          discardEvent
        )
        const summary = await service.process(
          {
            batchId: preflight.batchId,
            mode: 'add',
            selectedFileIds: selectedReadyFiles(preflight),
            outputParent
          },
          discardEvent
        )
        const record = await recovery.get()
        const stagingPath = record?.temporaryPaths?.find((path) =>
          path.includes('.ai-labeler-temp-staging-')
        )

        expect(summary.succeeded).toBe(1)
        expect(record?.reason).toMatch(/输出暂存目录清理失败/)
        expect(stagingPath).toBeTruthy()
        await expect(access(stagingPath!)).resolves.toBeUndefined()

        await recovery.clear()
        await expect(access(stagingPath!)).rejects.toThrow()
        expect(await recovery.get()).toBeUndefined()
      } finally {
        await service.dispose()
        await recovery.clear().catch(() => undefined)
      }
    },
    120_000
  )

  it(
    'ZIP 中的图片也直接平铺到同一个 images 文件夹',
    async () => {
      const root = await makeTemporaryRoot('ai-label-flat-archive-e2e-')
      const outputParent = join(root, 'output')
      await mkdir(outputParent, { recursive: true })
      const { service, recovery } = await createService(
        join(root, 'flat-archive-service')
      )

      try {
        const preflight = await service.preflight(
          {
            mode: 'add',
            recursive: true,
            inputs: [
              { id: 'normal-archive', path: NORMAL_ARCHIVE, kind: 'archive' }
            ],
            outputParent
          },
          discardEvent
        )
        expect(selectedReadyFiles(preflight)).toHaveLength(2)

        const summary = await service.process(
          {
            batchId: preflight.batchId,
            mode: 'add',
            selectedFileIds: selectedReadyFiles(preflight),
            outputParent
          },
          discardEvent
        )
        const imagesRoot = join(summary.outputDirectory, 'images')
        const entries = await readdir(imagesRoot, { withFileTypes: true })

        expect(summary.succeeded).toBe(2)
        expect(
          entries
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right, 'zh-CN'))
        ).toEqual(
          ['归档-已合规.png', '归档-未标记.png'].sort((left, right) =>
            left.localeCompare(right, 'zh-CN')
          )
        )
        expect(entries.every((entry) => entry.isFile())).toBe(true)
        expect(
          summary.results
            .filter((result) => result.outcome === 'passed')
            .every(
              (result) =>
                result.outputPath !== undefined &&
                isDirectChild(imagesRoot, result.outputPath)
            )
        ).toBe(true)
      } finally {
        await service.dispose()
        await recovery.clear().catch(() => undefined)
      }
    },
    120_000
  )

  it(
    '归档在预检后变化时仅让该归档已选且就绪的文件失败，后续直接文件继续处理',
    async () => {
      const root = await makeTemporaryRoot('ai-label-archive-change-e2e-')
      const inputDirectory = join(root, 'inputs')
      const outputParent = join(root, 'output')
      const archive = join(inputDirectory, '批次.zip')
      const direct = join(inputDirectory, '直接文件.png')
      await mkdir(inputDirectory, { recursive: true })
      await mkdir(outputParent, { recursive: true })
      await Promise.all([
        copyFile(NORMAL_ARCHIVE, archive),
        copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), direct)
      ])
      const directShaBefore = await sha256File(direct)
      const { service, recovery } = await createService(
        join(root, 'archive-change-service')
      )

      try {
        const preflight = await service.preflight(
          {
            mode: 'add',
            recursive: true,
            inputs: [
              { id: 'changed-archive', path: archive, kind: 'archive' },
              { id: 'direct-file', path: direct, kind: 'file' }
            ],
            outputParent
          },
          discardEvent
        )
        const archiveReady = preflight.files.filter(
          (file) =>
            file.sourceId === 'changed-archive' &&
            file.outcome === 'ready'
        )
        const directReady = preflight.files.filter(
          (file) =>
            file.sourceId === 'direct-file' &&
            file.outcome === 'ready'
        )
        expect(archiveReady).toHaveLength(2)
        expect(directReady).toHaveLength(1)

        await appendFile(archive, Buffer.from('archive-changed-after-preflight'))

        const summary = await service.process(
          {
            batchId: preflight.batchId,
            mode: 'add',
            selectedFileIds: selectedReadyFiles(preflight),
            outputParent
          },
          discardEvent
        )
        const archiveResults = summary.results.filter((result) =>
          archiveReady.some((file) => file.id === result.fileId)
        )
        const directResult = summary.results.find(
          (result) => result.fileId === directReady[0]?.id
        )

        expect(archiveResults).toHaveLength(archiveReady.length)
        for (const result of archiveResults) {
          expect(result).toMatchObject({
            outcome: 'failed',
            errorCode: 'SOURCE_CHANGED'
          })
          expect(result.outputPath).toBeUndefined()
        }
        expect(directResult).toMatchObject({
          outcome: 'passed',
          sourceType: 'direct-file',
          postVerifyState: 'compliant',
          outputPath: expect.any(String)
        })
        expect(directResult?.outputPath).toBeTruthy()
        expect(
          (await inspectImage(directResult!.outputPath!)).subject.exactCount
        ).toBe(1)
        expect(
          await listFiles(join(summary.outputDirectory, 'images'))
        ).toHaveLength(1)
        expect(await sha256File(direct)).toBe(directShaBefore)
        await expectReportArtifacts(summary.reportPath, summary.logPath)
      } finally {
        await service.dispose()
        await recovery.clear().catch(() => undefined)
      }
    },
    120_000
  )

  it('同步拒绝并发处理，并在首次处理开始后消费预检结果', async () => {
    const root = await makeTemporaryRoot('ai-label-single-flight-e2e-')
    const outputParent = join(root, 'output')
    const input = join(root, '输入.png')
    await mkdir(outputParent, { recursive: true })
    await copyFile(join(IMAGE_FIXTURES, '01-未标记.png'), input)
    const { service, recovery } = await createService(
      join(root, 'single-flight-service')
    )

    try {
      const preflight = await service.preflight(
        {
          mode: 'detect',
          recursive: true,
          inputs: [{ id: 'single-file', path: input, kind: 'file' }],
          outputParent
        },
        discardEvent
      )
      const request = {
        batchId: preflight.batchId,
        mode: 'detect' as const,
        selectedFileIds: selectedReadyFiles(preflight),
        outputParent
      }

      const first = service.process(request, discardEvent)
      await expect(service.process(request, discardEvent)).rejects.toThrow(
        /当前已有批次正在运行/
      )
      await expect(first).resolves.toMatchObject({ succeeded: 1 })
      await expect(service.process(request, discardEvent)).rejects.toThrow(
        /预检结果已失效/
      )
    } finally {
      await service.dispose()
      await recovery.clear().catch(() => undefined)
    }
  }, 120_000)
})
