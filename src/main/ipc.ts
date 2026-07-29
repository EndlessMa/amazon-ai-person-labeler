import { resolve } from 'node:path'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions
} from 'electron'
import {
  APP_NAME,
  APP_VERSION,
  IPC_CHANNELS,
  RULE_VERSION,
  type AppPreferences,
  type BatchEvent,
  type BatchSummary,
  type PreflightRequest,
  type PreflightSummary,
  type ProcessRequest
} from '../shared/contracts'
import type { PreferencesStore } from './core/preferences'
import type { RecoveryStore } from './core/recovery'

export interface BatchServiceApi {
  preflight(
    request: PreflightRequest,
    emit: (event: BatchEvent) => void
  ): Promise<PreflightSummary>
  process(
    request: ProcessRequest,
    emit: (event: BatchEvent) => void
  ): Promise<BatchSummary>
  cancel(): void
}

interface IpcDependencies {
  window: BrowserWindow
  service: BatchServiceApi
  preferences: PreferencesStore
  recovery: RecoveryStore
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) {
    throw new TypeError(`${field} 无效`)
  }
}

function validatePreflightRequest(value: unknown): PreflightRequest {
  if (!value || typeof value !== 'object') {
    throw new TypeError('预检参数无效')
  }
  const request = value as Partial<PreflightRequest>
  if (!['detect', 'add', 'remove'].includes(request.mode ?? '')) {
    throw new TypeError('处理模式无效')
  }
  if (typeof request.recursive !== 'boolean' || !Array.isArray(request.inputs)) {
    throw new TypeError('预检参数不完整')
  }
  if (request.inputs.length === 0 || request.inputs.length > 20_000) {
    throw new TypeError('输入数量超出范围')
  }
  for (const input of request.inputs) {
    assertString(input.id, '输入 ID')
    assertString(input.path, '输入路径')
    if (!['file', 'folder', 'archive'].includes(input.kind)) {
      throw new TypeError('输入类型无效')
    }
  }
  if (request.outputParent !== undefined) {
    assertString(request.outputParent, '输出路径')
  }
  return request as PreflightRequest
}

function validateProcessRequest(value: unknown): ProcessRequest {
  if (!value || typeof value !== 'object') {
    throw new TypeError('处理参数无效')
  }
  const request = value as Partial<ProcessRequest>
  assertString(request.batchId, '批次 ID')
  assertString(request.outputParent, '输出路径')
  if (!['detect', 'add', 'remove'].includes(request.mode ?? '')) {
    throw new TypeError('处理模式无效')
  }
  if (
    !Array.isArray(request.selectedFileIds) ||
    request.selectedFileIds.length > 10_000 ||
    request.selectedFileIds.some(
      (id) => typeof id !== 'string' || id.length === 0
    )
  ) {
    throw new TypeError('文件选择无效')
  }
  return request as ProcessRequest
}

function validatePreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== 'object') {
    throw new TypeError('设置无效')
  }
  const preferences = value as Partial<AppPreferences>
  if (
    typeof preferences.recursive !== 'boolean' ||
    typeof preferences.showThumbnails !== 'boolean'
  ) {
    throw new TypeError('设置无效')
  }
  return preferences as AppPreferences
}

async function selectPaths(
  window: BrowserWindow,
  options: OpenDialogOptions
): Promise<string[]> {
  const result = await dialog.showOpenDialog(window, options)
  return result.canceled ? [] : result.filePaths
}

export function registerIpcHandlers({
  window,
  service,
  preferences,
  recovery
}: IpcDependencies): () => void {
  const selectedOutputParents = new Set<string>()
  const allowedOpenPaths = new Set<string>()
  const handlers = Object.values(IPC_CHANNELS).filter(
    (channel) => channel !== IPC_CHANNELS.event
  )
  for (const channel of handlers) ipcMain.removeHandler(channel)

  const handle = (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender.id !== window.webContents.id) {
        throw new TypeError('拒绝来自非主窗口的 IPC 调用')
      }
      return listener(...args)
    })
  }
  const rememberAllowedOpenPaths = (paths: string[]): void => {
    for (const path of paths) allowedOpenPaths.add(resolve(path))
  }
  const rememberSelectedOutputParents = (paths: string[]): string[] => {
    for (const path of paths) selectedOutputParents.add(resolve(path))
    return paths
  }
  const assertSelectedOutputParent = (path: string): void => {
    if (!selectedOutputParents.has(resolve(path))) {
      throw new TypeError('输出位置必须由系统文件夹选择器确认')
    }
  }
  const emit = (event: BatchEvent): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event)
  }

  handle(IPC_CHANNELS.selectFiles, async () =>
    selectPaths(window, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的图片',
          extensions: ['jpg', 'jpeg', 'png']
        }
      ]
    })
  )

  handle(IPC_CHANNELS.selectFolder, async () =>
    selectPaths(window, {
      title: '选择文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
  )

  handle(IPC_CHANNELS.selectArchive, async () =>
    selectPaths(window, {
      title: '选择 ZIP 或 RAR 压缩包',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的压缩包',
          extensions: ['zip', 'rar']
        }
      ]
    })
  )

  handle(IPC_CHANNELS.selectOutputFolder, async () => {
    const paths = rememberSelectedOutputParents(
      await selectPaths(window, {
        title: '选择输出位置',
        properties: ['openDirectory', 'createDirectory']
      })
    )
    return paths[0]
  })

  handle(IPC_CHANNELS.preflight, async (rawRequest) => {
    const request = validatePreflightRequest(rawRequest)
    if (request.outputParent) {
      assertSelectedOutputParent(request.outputParent)
    }
    return service.preflight(request, emit)
  })

  handle(IPC_CHANNELS.process, async (rawRequest) => {
    const request = validateProcessRequest(rawRequest)
    assertSelectedOutputParent(request.outputParent)
    const summary = await service.process(request, emit)
    rememberAllowedOpenPaths([
      summary.outputDirectory,
      summary.reportPath,
      summary.logPath,
      ...summary.results.flatMap((result) =>
        result.outcome === 'passed' && result.outputPath
          ? [result.outputPath]
          : []
      )
    ])
    return summary
  })

  handle(IPC_CHANNELS.cancel, () => service.cancel())

  handle(IPC_CHANNELS.openPath, async (rawPath) => {
    assertString(rawPath, '打开路径')
    const path = resolve(rawPath)
    if (!allowedOpenPaths.has(path)) {
      throw new TypeError('该路径不在当前批次的允许范围内')
    }
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })

  handle(IPC_CHANNELS.getPreferences, () => preferences.get())
  handle(IPC_CHANNELS.setPreferences, (rawPreferences) =>
    preferences.set(validatePreferences(rawPreferences))
  )
  handle(IPC_CHANNELS.getRecoveryRecord, () => recovery.get())
  handle(IPC_CHANNELS.exportRecoveryRecord, async () => {
    const paths = await selectPaths(window, {
      title: '选择恢复记录导出位置',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!paths[0]) return undefined
    return recovery.exportTo(paths[0])
  })
  handle(IPC_CHANNELS.clearRecoveryRecord, () => recovery.clear())
  handle(IPC_CHANNELS.getAppInfo, () => ({
    name: APP_NAME,
    version: APP_VERSION,
    ruleVersion: RULE_VERSION,
    platform: process.platform,
    arch: process.arch
  }))

  return () => {
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}
