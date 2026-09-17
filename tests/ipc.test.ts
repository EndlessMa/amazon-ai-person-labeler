import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IPC_CHANNELS,
  type BatchSummary,
  type PreflightRequest,
  type ProcessRequest
} from '../src/shared/contracts'

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: { sender: { id: number } }, ...args: unknown[]) => unknown
  >()
  return {
    handlers,
    showOpenDialog: vi.fn(),
    openPath: vi.fn(async () => '')
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: { id: number } },
        ...args: unknown[]
      ) => unknown
    ) => {
      electronMocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      electronMocks.handlers.delete(channel)
    }
  },
  shell: {
    openPath: electronMocks.openPath
  }
}))

import { registerIpcHandlers } from '../src/main/ipc'

const trustedSender = { id: 17 }

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel)
  if (!handler) throw new Error(`missing IPC handler: ${channel}`)
  return await handler({ sender: trustedSender }, ...args)
}

describe('IPC sender and local-path authorization', () => {
  const service = {
    preflight: vi.fn(),
    process: vi.fn(),
    cancel: vi.fn()
  }
  const preferences = {
    get: vi.fn(async () => ({
      recursive: true,
      showThumbnails: true,
      defaultOutputFolder: ''
    })),
    set: vi.fn()
  }
  const recovery = {
    get: vi.fn(),
    exportTo: vi.fn(),
    clear: vi.fn()
  }
  const window = {
    webContents: {
      id: trustedSender.id,
      send: vi.fn()
    },
    isDestroyed: vi.fn(() => false)
  }

  beforeEach(() => {
    electronMocks.handlers.clear()
    electronMocks.showOpenDialog.mockReset()
    electronMocks.openPath.mockClear()
    service.preflight.mockReset()
    service.process.mockReset()
    service.cancel.mockReset()
    preferences.get.mockReset()
    preferences.get.mockResolvedValue({
      recursive: true,
      showThumbnails: true,
      defaultOutputFolder: ''
    })
    preferences.set.mockReset()
    registerIpcHandlers({
      window: window as never,
      service,
      preferences: preferences as never,
      recovery: recovery as never
    })
  })

  it('rejects calls from any renderer other than the registered main window', async () => {
    const handler = electronMocks.handlers.get(IPC_CHANNELS.getAppInfo)!
    await expect(
      Promise.resolve().then(() => handler({ sender: { id: 999 } }))
    ).rejects.toThrow('非主窗口')
  })

  it('returns every folder selected by the native picker', async () => {
    const folders = [
      resolve('/tmp/first-folder'),
      resolve('/tmp/second-folder')
    ]
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: folders
    })

    await expect(invoke(IPC_CHANNELS.selectFolder)).resolves.toEqual(folders)
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(window, {
      title: '选择文件夹',
      properties: ['openDirectory', 'multiSelections']
    })

    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: folders
    })
    await expect(invoke(IPC_CHANNELS.selectFolder)).resolves.toEqual([])
  })

  it('accepts arbitrary read-only inputs but requires a native-selected output', async () => {
    const input = resolve('/tmp/dragged-image.jpg')
    const output = resolve('/tmp/chosen-output')
    const request: PreflightRequest = {
      mode: 'detect',
      recursive: true,
      inputs: [{ id: 'dragged', path: input, kind: 'file' }]
    }
    service.preflight.mockResolvedValue({ batchId: 'preflight' })

    await expect(invoke(IPC_CHANNELS.preflight, request)).resolves.toEqual({
      batchId: 'preflight'
    })
    expect(service.preflight).toHaveBeenCalledOnce()
    await expect(invoke(IPC_CHANNELS.openPath, input)).rejects.toThrow(
      '允许范围'
    )

    await expect(
      invoke(IPC_CHANNELS.preflight, { ...request, outputParent: output })
    ).rejects.toThrow('系统文件夹选择器')

    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [output]
    })
    await expect(
      invoke(IPC_CHANNELS.selectOutputFolder)
    ).resolves.toBe(output)
    await expect(
      invoke(IPC_CHANNELS.preflight, { ...request, outputParent: output })
    ).resolves.toEqual({ batchId: 'preflight' })
  })

  it('restores a persisted default output and only saves picker-approved folders', async () => {
    const savedOutput = resolve('/tmp/saved-output')
    const unapprovedOutput = resolve('/tmp/unapproved-output')
    preferences.get.mockResolvedValue({
      recursive: true,
      showThumbnails: true,
      defaultOutputFolder: savedOutput
    })
    service.preflight.mockResolvedValue({ batchId: 'preflight' })

    await expect(invoke(IPC_CHANNELS.getPreferences)).resolves.toMatchObject({
      defaultOutputFolder: savedOutput
    })
    await expect(
      invoke(IPC_CHANNELS.preflight, {
        mode: 'add',
        recursive: true,
        inputs: [
          { id: 'dragged', path: '/tmp/dragged.jpg', kind: 'file' }
        ],
        outputParent: savedOutput
      })
    ).resolves.toEqual({ batchId: 'preflight' })

    await expect(
      invoke(IPC_CHANNELS.setPreferences, {
        recursive: true,
        showThumbnails: true,
        defaultOutputFolder: unapprovedOutput
      })
    ).rejects.toThrow('系统文件夹选择器')

    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [unapprovedOutput]
    })
    await invoke(IPC_CHANNELS.selectOutputFolder)
    await expect(
      invoke(IPC_CHANNELS.setPreferences, {
        recursive: true,
        showThumbnails: true,
        defaultOutputFolder: unapprovedOutput
      })
    ).resolves.toBeUndefined()
    expect(preferences.set).toHaveBeenCalledWith({
      recursive: true,
      showThumbnails: true,
      defaultOutputFolder: unapprovedOutput
    })
  })

  it('opens only successful batch artifacts, never request paths or failed outputs', async () => {
    const input = resolve('/tmp/dragged-image.jpg')
    const outputParent = resolve('/tmp/chosen-output')
    const outputDirectory = resolve(outputParent, 'AI人物标签-batch')
    const passedImage = resolve(outputDirectory, 'passed.jpg')
    const failedImage = resolve(outputDirectory, 'failed.jpg')
    const summary: BatchSummary = {
      batchId: 'batch',
      mode: 'add',
      outputDirectory,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      total: 2,
      succeeded: 1,
      skipped: 0,
      failed: 1,
      cancelled: 0,
      results: [
        {
          fileId: 'passed',
          sourcePath: input,
          outputPath: passedImage,
          sourceType: 'direct-file',
          action: 'add-standard',
          outcome: 'passed',
          finishedAt: new Date(1).toISOString()
        },
        {
          fileId: 'failed',
          sourcePath: input,
          outputPath: failedImage,
          sourceType: 'direct-file',
          action: 'add-standard',
          outcome: 'failed',
          finishedAt: new Date(1).toISOString()
        }
      ]
    }
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [outputParent]
    })
    service.process.mockResolvedValue(summary)
    await invoke(IPC_CHANNELS.selectOutputFolder)

    const processRequest: ProcessRequest = {
      batchId: 'batch',
      mode: 'add',
      selectedFileIds: ['passed', 'failed'],
      outputParent
    }
    await expect(
      invoke(IPC_CHANNELS.process, processRequest)
    ).resolves.toEqual(summary)

    await expect(invoke(IPC_CHANNELS.openPath, input)).rejects.toThrow(
      '允许范围'
    )
    await expect(invoke(IPC_CHANNELS.openPath, failedImage)).rejects.toThrow(
      '允许范围'
    )
    for (const artifact of [outputDirectory, passedImage]) {
      await expect(
        invoke(IPC_CHANNELS.openPath, artifact)
      ).resolves.toBeUndefined()
    }
    expect(electronMocks.openPath).toHaveBeenCalledTimes(2)
  })
})
