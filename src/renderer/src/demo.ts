import {
  TARGET_SUBJECT,
  type AppPreferences,
  type BatchEvent,
  type BatchSummary,
  type DesktopApi,
  type FileResult,
  type PreflightRequest,
  type PreflightSummary,
  type RecoveryRecord,
  type ScannedFile,
  type SubjectAnalysis,
  type SubjectState
} from '../../shared/contracts'

const listeners = new Set<(event: BatchEvent) => void>()
let lastPreflight: PreflightSummary | undefined
let cancelled = false

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

function demoThumbnail(primary: string, secondary: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="64" viewBox="0 0 88 64">
    <rect width="88" height="64" fill="${primary}"/>
    <circle cx="45" cy="23" r="11" fill="${secondary}"/>
    <path d="M24 64c2-17 10-26 21-26s20 9 22 26" fill="${secondary}"/>
    <path d="M0 51 17 35l14 13 11-9 19 25H0Z" fill="#fff" opacity=".25"/>
  </svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

const demoRows: Array<{
  name: string
  state: SubjectState
  values: string[]
  bytes: number
  primary: string
  secondary: string
  error?: string
}> = [
  {
    name: 'A00123.jpg',
    state: 'compliant',
    values: ['portrait', 'adult', TARGET_SUBJECT],
    bytes: 2_568_132,
    primary: '#bfd4e8',
    secondary: '#3b5872'
  },
  {
    name: 'A00124.jpg',
    state: 'compliant',
    values: ['business person', 'man', TARGET_SUBJECT],
    bytes: 3_268_547,
    primary: '#d7c9bd',
    secondary: '#253a52'
  },
  {
    name: 'A00125.jpg',
    state: 'untagged',
    values: ['lifestyle', 'smiling'],
    bytes: 1_982_513,
    primary: '#d8dfc6',
    secondary: '#6f7658'
  },
  {
    name: 'A00126.jpg',
    state: 'duplicate',
    values: [TARGET_SUBJECT, 'studio', TARGET_SUBJECT],
    bytes: 2_154_918,
    primary: '#c8d6dd',
    secondary: '#2f414b'
  },
  {
    name: 'A00127.jpg',
    state: 'similar',
    values: ['Contains-Synthetic-Performer', 'portrait'],
    bytes: 952_882,
    primary: '#d9c5cc',
    secondary: '#65444f'
  },
  {
    name: 'A00128.png',
    state: 'untagged',
    values: [],
    bytes: 2_711_043,
    primary: '#cddcce',
    secondary: '#4b6651'
  },
  {
    name: 'A00129.jpg',
    state: 'compliant',
    values: [TARGET_SUBJECT],
    bytes: 2_361_932,
    primary: '#d8ccd0',
    secondary: '#5d4650'
  },
  {
    name: 'A00130.jpg',
    state: 'compliant',
    values: ['product', TARGET_SUBJECT],
    bytes: 3_052_284,
    primary: '#c4d1d7',
    secondary: '#263b47'
  },
  {
    name: 'A00131.jpg',
    state: 'untagged',
    values: ['outdoor'],
    bytes: 2_205_612,
    primary: '#d9d2bd',
    secondary: '#615b46'
  },
  {
    name: 'A00132.jpg',
    state: 'malformed',
    values: [],
    bytes: 1_845_003,
    primary: '#d7d7d7',
    secondary: '#5d6065',
    error: 'XMP 数据结构损坏，已安全跳过'
  },
  {
    name: 'A00133.png',
    state: 'similar',
    values: [`${TARGET_SUBJECT} `],
    bytes: 4_182_719,
    primary: '#c8d6e4',
    secondary: '#425873'
  },
  {
    name: 'A00134.jpg',
    state: 'untagged',
    values: ['catalog'],
    bytes: 1_547_284,
    primary: '#e0d0c2',
    secondary: '#70523e'
  }
]

function subjectFor(
  state: SubjectState,
  values: string[]
): SubjectAnalysis {
  return {
    state,
    values,
    exactCount: values.filter((value) => value === TARGET_SUBJECT).length,
    similarValues: values.filter(
      (value) =>
        value !== TARGET_SUBJECT &&
        value.trim().toLowerCase() === TARGET_SUBJECT
    )
  }
}

function makeDemoFiles(): ScannedFile[] {
  return demoRows.map((row, index) => {
    const failed = row.state === 'malformed'
    return {
      id: `demo-${index + 1}`,
      sourceId: 'demo-folder',
      sourceType: 'folder',
      sourcePath: `/示例素材/images/2024/05/${row.name}`,
      canonicalPath: `/示例素材/images/2024/05/${row.name}`,
      displayName: row.name,
      relativePath: `images/2024/05/${row.name}`,
      format: row.name.endsWith('.png') ? 'png' : 'jpeg',
      bytes: row.bytes,
      width: 2400,
      height: 3000,
      modifiedMs: Date.now() - index * 86_400_000,
      selected: !failed,
      outcome: failed ? 'failed' : 'ready',
      subject: subjectFor(row.state, row.values),
      fingerprint: {
        size: row.bytes,
        modifiedMs: Date.now() - index * 86_400_000,
        sourceSha256: `${String(index + 1).repeat(8)}b8f1c3d47e6a9b2c`.padEnd(
          64,
          String(index)
        )
      },
      ...(row.error
        ? {
            errorCode: 'MALFORMED_METADATA' as const,
            errorMessage: row.error
          }
        : {}),
      thumbnailDataUrl: demoThumbnail(row.primary, row.secondary)
    }
  })
}

function actionFor(state: SubjectState, mode: PreflightRequest['mode']) {
  if (mode === 'detect') return 'detect-only' as const
  if (mode === 'remove') {
    return state === 'untagged' || state === 'similar'
      ? ('copy-unchanged' as const)
      : ('remove-standard' as const)
  }
  if (state === 'compliant') return 'copy-unchanged' as const
  if (state === 'duplicate') return 'normalize-duplicate' as const
  return 'add-standard' as const
}

function postStateFor(
  state: SubjectState,
  mode: PreflightRequest['mode']
): SubjectState {
  if (mode === 'detect') return state
  if (mode === 'remove') return state === 'similar' ? 'similar' : 'untagged'
  return 'compliant'
}

const demoApi: DesktopApi = {
  pathForFile(file: unknown) {
    const candidate = file as { name?: string; path?: string }
    return candidate.path ?? `/拖放输入/${candidate.name ?? '未知文件'}`
  },
  async selectFiles() {
    return ['/示例素材/A00123.jpg', '/示例素材/A00124.png']
  },
  async selectFolder() {
    return ['/示例素材/牛油果收纳盒', '/示例素材/沙拉罐图片']
  },
  async selectArchive() {
    return ['/示例素材/待处理批次.zip']
  },
  async selectOutputFolder() {
    return '/示例输出/AI人物标签工具'
  },
  async preflight(request) {
    listeners.forEach((listener) =>
      listener({
        type: 'phase',
        phase: 'scanning',
        message: '正在读取文件和压缩包索引…'
      })
    )
    await wait(280)
    const files = makeDemoFiles()
    lastPreflight = {
      batchId: `DEMO-${new Date()
        .toISOString()
        .replace(/\D/g, '')
        .slice(0, 14)}`,
      startedAt: new Date().toISOString(),
      files,
      totalScannedEntries: files.length + 3,
      supportedImages: files.length,
      totalSupportedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      estimatedPeakBytes: 2_642_411_520,
      ...(request.outputParent ? { availableBytes: 42_949_672_960 } : {}),
      warnings: ['1 个文件的 XMP 结构损坏，处理时将安全跳过。']
    }
    return lastPreflight
  },
  async process(request) {
    cancelled = false
    const sourceFiles = lastPreflight?.files ?? makeDemoFiles()
    const selected = sourceFiles.filter((file) =>
      request.selectedFileIds.includes(file.id)
    )
    const results: FileResult[] = []
    listeners.forEach((listener) =>
      listener({
        type: 'phase',
        phase: 'processing',
        message: '正在写入副本并保护原始图像数据…'
      })
    )

    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index]
      if (!file) continue
      if (cancelled) {
        const originalState = file.subject?.state
        results.push({
          fileId: file.id,
          sourcePath: file.sourcePath,
          sourceType: file.sourceType,
          ...(originalState ? { originalState } : {}),
          action: actionFor(file.subject?.state ?? 'untagged', request.mode),
          outcome: 'cancelled',
          errorCode: 'CANCELLED',
          errorMessage: '用户取消',
          finishedAt: new Date().toISOString()
        })
        continue
      }
      await wait(95)
      const simulatedFailure = index === Math.min(6, selected.length - 1)
      const state = file.subject?.state ?? 'untagged'
      const sourceSha256 = file.fingerprint?.sourceSha256
      const result: FileResult = {
        fileId: file.id,
        sourcePath: file.sourcePath,
        ...(request.mode === 'detect'
          ? {}
          : {
              outputPath: `${request.outputParent}/demo-batch/images/${file.relativePath}`
            }),
        sourceType: file.sourceType,
        originalState: state,
        action: actionFor(state, request.mode),
        outcome: simulatedFailure ? 'failed' : 'passed',
        postVerifyState: simulatedFailure
          ? state
          : postStateFor(state, request.mode),
        ...(sourceSha256 ? { sourceSha256 } : {}),
        outputSha256: `${String(index + 3).repeat(7)}aa4d67f8c012`.padEnd(
          64,
          'e'
        ),
        payloadSha256: `${String(index + 8).repeat(6)}19bc40f57a`.padEnd(
          64,
          '7'
        ),
        ...(simulatedFailure
          ? {
              errorCode: 'SOURCE_CHANGED' as const,
              errorMessage: '源文件在预检后发生变化'
            }
          : {}),
        finishedAt: new Date().toISOString()
      }
      results.push(result)
      listeners.forEach((listener) => {
        listener({ type: 'file-result', result })
        listener({
          type: 'progress',
          completed: index + 1,
          total: selected.length,
          currentFile: file.displayName
        })
      })
    }

    listeners.forEach((listener) =>
      listener({
        type: 'phase',
        phase: 'verifying',
        message: '正在进行独立 XMP 与图像载荷校验…'
      })
    )
    await wait(220)
    const succeeded = results.filter((item) => item.outcome === 'passed').length
    const failed = results.filter((item) => item.outcome === 'failed').length
    const cancelledCount = results.filter(
      (item) => item.outcome === 'cancelled'
    ).length
    const summary: BatchSummary = {
      batchId: request.batchId,
      mode: request.mode,
      outputDirectory: `${request.outputParent}/demo-batch`,
      startedAt: lastPreflight?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: results.length,
      succeeded,
      skipped: 0,
      failed,
      cancelled: cancelledCount,
      reportPath: `${request.outputParent}/demo-batch/report.csv`,
      logPath: `${request.outputParent}/demo-batch/diagnostic.log`,
      results
    }
    listeners.forEach((listener) =>
      listener({
        type: 'phase',
        phase: cancelled ? 'cancelled' : 'complete',
        message: cancelled ? '批次已取消' : '批次处理与二次校验完成'
      })
    )
    return summary
  },
  async cancel() {
    cancelled = true
  },
  async openPath() {
    return
  },
  async getPreferences(): Promise<AppPreferences> {
    const stored = window.localStorage.getItem('demo-preferences')
    return stored
      ? (JSON.parse(stored) as AppPreferences)
      : { recursive: true, showThumbnails: true }
  },
  async setPreferences(preferences) {
    window.localStorage.setItem('demo-preferences', JSON.stringify(preferences))
  },
  async getRecoveryRecord(): Promise<RecoveryRecord | undefined> {
    if (!window.location.search.includes('recovery')) return undefined
    return {
      batchId: 'RECOVERY-20240512',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      outputDirectory: '/离线恢复/RECOVERY-20240512',
      reportDraftPath: '/离线恢复/RECOVERY-20240512/report-draft.csv',
      reason: '上次处理时输出共享盘连接中断',
      temporaryPaths: [
        '/离线恢复/.ai-labeler-temp-RECOVERY-20240512',
        '/离线恢复/.ai-labeler-temp-RECOVERY-20240512-archive'
      ]
    }
  },
  async exportRecoveryRecord() {
    return '/示例输出/recovery-report.csv'
  },
  async clearRecoveryRecord() {
    return
  },
  async getAppInfo() {
    return {
      name: 'AI 人物标签工具',
      version: '0.1.0-beta.2',
      ruleVersion: 'amazon-ai-person-xmp-v1',
      platform: 'darwin',
      arch: 'arm64'
    }
  },
  onBatchEvent(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

export function desktopApi(): { api: DesktopApi; isDemo: boolean } {
  const nativeApi = (window as Window & { desktopApi?: DesktopApi }).desktopApi
  return nativeApi ? { api: nativeApi, isDemo: false } : { api: demoApi, isDemo: true }
}
