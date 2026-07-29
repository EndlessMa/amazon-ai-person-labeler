import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeImage,
  session,
  type Event
} from 'electron'
import { BatchService } from './core/batch-service'
import { closeMetadataTools } from './core/metadata'
import { PreferencesStore } from './core/preferences'
import { RecoveryStore } from './core/recovery'
import { prepareInputsForBatch } from './input-adapter'
import { registerIpcHandlers } from './ipc'

let mainWindow: BrowserWindow | undefined
let batchService: BatchService | undefined
let removeIpcHandlers: (() => void) | undefined
let allowQuit = false
let shutdownPromise: Promise<void> | undefined

function developmentRendererUrl(): string | undefined {
  const raw = process.env.ELECTRON_RENDERER_URL
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return parsed.toString()
    }
  } catch {
    // An invalid development URL is ignored; production loading stays local.
  }
  return undefined
}

function installNetworkBoundary(): void {
  const allowedDevelopmentUrl = developmentRendererUrl()
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (
        allowedDevelopmentUrl &&
        details.url.startsWith(allowedDevelopmentUrl)
      ) {
        callback({ cancel: false })
      } else {
        callback({ cancel: true })
      }
    }
  )
}

function createThumbnail(path: string): Promise<string | undefined> {
  return Promise.resolve().then(() => {
    const source = nativeImage.createFromPath(path)
    if (source.isEmpty()) return undefined
    const size = source.getSize()
    const resized = source.resize({
      width: 48,
      height: 48,
      quality: 'good'
    })
    if (resized.isEmpty() || size.width <= 0 || size.height <= 0) {
      return undefined
    }
    return resized.toDataURL()
  })
}

function createWindow(
  preferences: PreferencesStore,
  recovery: RecoveryStore
): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    title: 'AI 人物标签工具',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false
    }
  })
  mainWindow = window

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  if (!batchService) {
    batchService = new BatchService({
      appDataDirectory: app.getPath('userData'),
      recovery,
      prepareInputs: prepareInputsForBatch,
      createThumbnail,
      shouldCreateThumbnails: async () =>
        (await preferences.get()).showThumbnails
    })
  }
  removeIpcHandlers?.()
  removeIpcHandlers = registerIpcHandlers({
    window,
    service: batchService,
    preferences,
    recovery
  })

  const rendererUrl = developmentRendererUrl()
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function shutdown(): Promise<void> {
  removeIpcHandlers?.()
  removeIpcHandlers = undefined
  await batchService?.dispose().catch(() => undefined)
  await closeMetadataTools().catch(() => undefined)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.internal.amazon-ai-person-labeler')
    installNetworkBoundary()
    const appDataDirectory = app.getPath('userData')
    const preferences = new PreferencesStore(appDataDirectory)
    const recovery = new RecoveryStore(appDataDirectory)
    createWindow(preferences, recovery)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(preferences, recovery)
      }
    })
  })
}

app.on('before-quit', (event: Event) => {
  if (allowQuit) return
  event.preventDefault()
  shutdownPromise ??= shutdown().finally(() => {
    allowQuit = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error)
})
process.on('unhandledRejection', (error) => {
  console.error('[unhandledRejection]', error)
})

