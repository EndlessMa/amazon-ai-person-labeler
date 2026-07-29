export const APP_NAME = 'AI 人物标签工具'
export const APP_VERSION = '0.1.0-beta.2'
export const RULE_VERSION = 'amazon-ai-person-xmp-v1'
export const TARGET_SUBJECT = 'contains-synthetic-performer'

export const LIMITS = {
  maxScannedEntries: 20_000,
  maxSupportedImages: 10_000,
  maxTotalUncompressedBytes: 50 * 1024 ** 3,
  maxImageBytes: 500 * 1024 ** 2,
  maxPixels: 100_000_000
} as const

export type OperationMode = 'detect' | 'add' | 'remove'
export type InputKind = 'file' | 'folder' | 'archive'
export type SourceType = 'direct-file' | 'folder' | 'zip' | 'rar'
export type ImageFormat = 'jpeg' | 'png'

export type SubjectState =
  | 'untagged'
  | 'compliant'
  | 'duplicate'
  | 'similar'
  | 'malformed'

export type FileOutcome =
  | 'pending'
  | 'ready'
  | 'passed'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EXTENSION_MISMATCH'
  | 'ANIMATED_PNG'
  | 'IMAGE_TOO_LARGE'
  | 'PIXEL_LIMIT_EXCEEDED'
  | 'MALFORMED_METADATA'
  | 'SOURCE_CHANGED'
  | 'ARCHIVE_ENCRYPTED'
  | 'ARCHIVE_SPLIT'
  | 'ARCHIVE_NESTED'
  | 'ARCHIVE_SFX'
  | 'ARCHIVE_PATH_UNSAFE'
  | 'ARCHIVE_INDEX_CORRUPT'
  | 'ARCHIVE_CRC_FAILED'
  | 'ENTRY_LIMIT_EXCEEDED'
  | 'IMAGE_LIMIT_EXCEEDED'
  | 'TOTAL_SIZE_LIMIT_EXCEEDED'
  | 'OUTPUT_NESTED_WITH_INPUT'
  | 'OUTPUT_COLLISION'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'SOURCE_READ_FAILED'
  | 'OUTPUT_WRITE_FAILED'
  | 'POST_VERIFY_FAILED'
  | 'PAYLOAD_CHANGED'
  | 'METADATA_CHANGED'
  | 'CANCELLED'
  | 'INTERNAL_ERROR'

export interface InputSelection {
  id: string
  path: string
  kind: InputKind
}

export interface SubjectAnalysis {
  state: SubjectState
  values: string[]
  exactCount: number
  similarValues: string[]
}

export interface FileFingerprint {
  size: number
  modifiedMs: number
  sourceSha256: string
}

export interface ScannedFile {
  id: string
  sourceId: string
  sourceType: SourceType
  sourcePath: string
  canonicalPath: string
  displayName: string
  relativePath: string
  format?: ImageFormat
  bytes: number
  width?: number
  height?: number
  modifiedMs: number
  selected: boolean
  outcome: FileOutcome
  subject?: SubjectAnalysis
  fingerprint?: FileFingerprint
  errorCode?: ErrorCode
  errorMessage?: string
  thumbnailDataUrl?: string
}

export interface PreflightRequest {
  mode: OperationMode
  recursive: boolean
  inputs: InputSelection[]
  outputParent?: string
}

export interface PreflightSummary {
  batchId: string
  startedAt: string
  files: ScannedFile[]
  totalScannedEntries: number
  supportedImages: number
  totalSupportedBytes: number
  estimatedPeakBytes: number
  availableBytes?: number
  warnings: string[]
}

export type BatchAction =
  | 'detect-only'
  | 'copy-unchanged'
  | 'add-standard'
  | 'normalize-duplicate'
  | 'remove-standard'
  | 'skip'

export interface ProcessRequest {
  batchId: string
  mode: OperationMode
  selectedFileIds: string[]
  outputParent: string
}

export interface FileResult {
  fileId: string
  sourcePath: string
  outputPath?: string
  sourceType: SourceType
  originalState?: SubjectState
  action: BatchAction
  outcome: FileOutcome
  postVerifyState?: SubjectState
  sourceSha256?: string
  outputSha256?: string
  payloadSha256?: string
  errorCode?: ErrorCode
  errorMessage?: string
  finishedAt: string
}

export interface BatchSummary {
  batchId: string
  mode: OperationMode
  outputDirectory: string
  startedAt: string
  finishedAt: string
  total: number
  succeeded: number
  skipped: number
  failed: number
  cancelled: number
  reportPath: string
  logPath: string
  results: FileResult[]
}

export type BatchEvent =
  | {
      type: 'phase'
      phase:
        | 'scanning'
        | 'preflight'
        | 'extracting'
        | 'processing'
        | 'verifying'
        | 'reporting'
        | 'complete'
        | 'cancelled'
      message: string
    }
  | {
      type: 'progress'
      completed: number
      total: number
      currentFile?: string
    }
  | {
      type: 'file-result'
      result: FileResult
    }

export interface AppPreferences {
  recursive: boolean
  showThumbnails: boolean
}

export interface RecoveryRecord {
  batchId: string
  createdAt: string
  outputDirectory: string
  reportDraftPath?: string
  temporaryPaths?: string[]
  reason: string
}

export interface AppInfo {
  name: string
  version: string
  ruleVersion: string
  platform:
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
  arch: string
}

export interface DesktopApi {
  pathForFile(file: unknown): string
  selectFiles(): Promise<string[]>
  selectFolder(): Promise<string[]>
  selectArchive(): Promise<string[]>
  selectOutputFolder(): Promise<string | undefined>
  preflight(request: PreflightRequest): Promise<PreflightSummary>
  process(request: ProcessRequest): Promise<BatchSummary>
  cancel(): Promise<void>
  openPath(path: string): Promise<void>
  getPreferences(): Promise<AppPreferences>
  setPreferences(preferences: AppPreferences): Promise<void>
  getRecoveryRecord(): Promise<RecoveryRecord | undefined>
  exportRecoveryRecord(): Promise<string | undefined>
  clearRecoveryRecord(): Promise<void>
  getAppInfo(): Promise<AppInfo>
  onBatchEvent(listener: (event: BatchEvent) => void): () => void
}

export const IPC_CHANNELS = {
  selectFiles: 'dialog:select-files',
  selectFolder: 'dialog:select-folder',
  selectArchive: 'dialog:select-archive',
  selectOutputFolder: 'dialog:select-output-folder',
  preflight: 'batch:preflight',
  process: 'batch:process',
  cancel: 'batch:cancel',
  event: 'batch:event',
  openPath: 'system:open-path',
  getPreferences: 'preferences:get',
  setPreferences: 'preferences:set',
  getRecoveryRecord: 'recovery:get',
  exportRecoveryRecord: 'recovery:export',
  clearRecoveryRecord: 'recovery:clear',
  getAppInfo: 'app:info'
} as const
