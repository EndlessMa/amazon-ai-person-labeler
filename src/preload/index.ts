import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  type AppPreferences,
  type BatchEvent,
  type DesktopApi,
  type PreflightRequest,
  type ProcessRequest
} from '../shared/contracts'

const desktopApi: DesktopApi = {
  pathForFile: (file: unknown) =>
    webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  selectFiles: () => ipcRenderer.invoke(IPC_CHANNELS.selectFiles),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectFolder),
  selectArchive: () => ipcRenderer.invoke(IPC_CHANNELS.selectArchive),
  selectOutputFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectOutputFolder),
  preflight: (request: PreflightRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.preflight, request),
  process: (request: ProcessRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.process, request),
  cancel: () => ipcRenderer.invoke(IPC_CHANNELS.cancel),
  openPath: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  getPreferences: () => ipcRenderer.invoke(IPC_CHANNELS.getPreferences),
  setPreferences: (preferences: AppPreferences) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPreferences, preferences),
  getRecoveryRecord: () => ipcRenderer.invoke(IPC_CHANNELS.getRecoveryRecord),
  exportRecoveryRecord: () =>
    ipcRenderer.invoke(IPC_CHANNELS.exportRecoveryRecord),
  clearRecoveryRecord: () =>
    ipcRenderer.invoke(IPC_CHANNELS.clearRecoveryRecord),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  onBatchEvent: (listener: (event: BatchEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, batchEvent: BatchEvent) =>
      listener(batchEvent)
    ipcRenderer.on(IPC_CHANNELS.event, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler)
  }
}

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
