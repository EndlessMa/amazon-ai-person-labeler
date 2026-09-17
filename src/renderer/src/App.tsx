import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  FileImage,
  FilePlus2,
  FileSpreadsheet,
  FolderInput,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  ListFilter,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent
} from 'react'
import {
  TARGET_SUBJECT,
  type AppInfo,
  type AppPreferences,
  type BatchEvent,
  type BatchSummary,
  type InputKind,
  type InputSelection,
  type OperationMode,
  type PreflightSummary,
  type RecoveryRecord,
  type ScannedFile,
  type SubjectState
} from '../../shared/contracts'
import { desktopApi } from './demo'

type EditableMode = Exclude<OperationMode, 'detect'>

type Stage = 'setup' | 'preflighting' | 'review' | 'processing' | 'complete'
type FilterValue =
  | 'all'
  | SubjectState
  | 'error'
  | 'selected'
type ModalKind =
  | 'remove-confirm'
  | 'recovery-delete'
  | null
type Notice = { tone: 'info' | 'success' | 'warning' | 'danger'; text: string }
type PreflightRunOptions = {
  checkOutput?: boolean
  autoProcess?: boolean
}

const MODE_META: Record<
  EditableMode,
  {
    label: string
    short: string
    description: string
    Icon: typeof ScanSearch
  }
> = {
  add: {
    label: '添加标签',
    short: '添加',
    description: '为副本添加或规范目标标签',
    Icon: Tag
  },
  remove: {
    label: '移除标签',
    short: '移除',
    description: '从副本中移除全部精确目标标签',
    Icon: Trash2
  }
}

const SUBJECT_META: Record<
  SubjectState,
  { label: string; className: string }
> = {
  untagged: { label: '未标记', className: 'status-neutral' },
  compliant: { label: '已标记', className: 'status-success' },
  duplicate: { label: '已标记但需规范', className: 'status-warning' },
  similar: { label: '存在相似值', className: 'status-purple' },
  malformed: { label: '元数据异常', className: 'status-danger' }
}

const ACTION_LABELS = {
  'detect-only': '只读检测',
  'copy-unchanged': '原样复制',
  'add-standard': '新增标准标签',
  'normalize-duplicate': '规范为单个标签',
  'remove-standard': '移除标准标签',
  skip: '跳过'
} as const

const PHASE_LABELS: Record<string, string> = {
  scanning: '扫描输入',
  preflight: '预检元数据',
  extracting: '安全解压',
  processing: '处理副本',
  verifying: '独立二次校验',
  reporting: '整理结果',
  complete: '处理完成',
  cancelled: '已取消'
}

const { api, isDemo } = desktopApi()

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[index]}`
}

function formatDate(value: string | number): string {
  const date = new Date(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date)
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function inputKindLabel(kind: InputKind): string {
  if (kind === 'folder') return '文件夹'
  if (kind === 'archive') return '压缩包'
  return '图片'
}

function eligible(file: ScannedFile): boolean {
  return (
    Boolean(file.format) &&
    file.outcome !== 'failed' &&
    file.outcome !== 'skipped' &&
    file.outcome !== 'cancelled'
  )
}

function stateOf(file: ScannedFile): SubjectState {
  if (file.subject?.state) return file.subject.state
  return file.errorCode ? 'malformed' : 'untagged'
}

function actionFor(file: ScannedFile, mode: OperationMode): string {
  const state = stateOf(file)
  if (!eligible(file)) return '安全跳过'
  if (mode === 'detect') return '只读检测'
  if (mode === 'remove') {
    return file.subject?.exactCount ? '移除标准标签' : '原样复制'
  }
  if (state === 'compliant') return '原样复制'
  if (state === 'duplicate') return '规范为单个标签'
  return '新增标准标签'
}

function makeInput(path: string, kind: InputKind): InputSelection {
  return {
    id: `${kind}-${path.toLocaleLowerCase()}`,
    path,
    kind
  }
}

function Checkbox({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  onChange
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`checkbox${checked ? ' is-checked' : ''}${indeterminate ? ' is-indeterminate' : ''}`}
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onChange()
      }}
    >
      {checked && !indeterminate ? <Check size={13} strokeWidth={2.8} /> : null}
      {indeterminate ? <span /> : null}
    </button>
  )
}

function StatusPill({
  state,
  compact = false
}: {
  state: SubjectState
  compact?: boolean
}): React.JSX.Element {
  const meta = SUBJECT_META[state]
  return (
    <span className={`status-pill ${meta.className}${compact ? ' compact' : ''}`}>
      <i aria-hidden="true" />
      {meta.label}
    </span>
  )
}

function ConfirmModal({
  kind,
  selectedCount,
  onClose,
  onProcess,
  onDeleteRecovery
}: {
  kind: Exclude<ModalKind, null>
  selectedCount: number
  onClose: () => void
  onProcess: () => void
  onDeleteRecovery: () => void
}): React.JSX.Element {
  const recoveryDelete = kind === 'recovery-delete'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={17} />
        </button>
        <div
          className={`modal-icon ${recoveryDelete ? 'orange' : 'red'}`}
        >
          {recoveryDelete ? (
            <TriangleAlert size={24} />
          ) : (
            <Trash2 size={24} />
          )}
        </div>
        <h2 id="confirm-title">
          {recoveryDelete ? '删除恢复记录？' : '确认移除标签'}
        </h2>
        <p>
          {recoveryDelete
            ? '删除后，本工具不再提示这条未完成批次。已有输出文件不会被删除。'
            : `将处理已勾选的 ${selectedCount} 张图片，仅从副本中移除精确目标值。源文件保持只读，所有结果写入新的批次目录。`}
        </p>
        {!recoveryDelete ? (
          <div className="modal-rule">
            <span>将移除</span>
            <code>{TARGET_SUBJECT}</code>
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          {recoveryDelete ? (
            <button
              type="button"
              className="button danger"
              onClick={onDeleteRecovery}
            >
              删除记录
            </button>
          ) : (
            <button
              type="button"
              className="button danger"
              onClick={onProcess}
            >
              确认并开始处理
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function App(): React.JSX.Element {
  const [mode, setMode] = useState<EditableMode>('add')
  const [stage, setStage] = useState<Stage>('setup')
  const [inputs, setInputs] = useState<InputSelection[]>([])
  const [recursive, setRecursive] = useState(true)
  const [showThumbnails, setShowThumbnails] = useState(true)
  const [preflight, setPreflight] = useState<PreflightSummary>()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [focusedId, setFocusedId] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterValue>('all')
  const [outputParent, setOutputParent] = useState('')
  const [defaultOutputFolder, setDefaultOutputFolder] = useState('')
  const [checkedOutputParent, setCheckedOutputParent] = useState('')
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [phase, setPhase] = useState('等待开始')
  const [currentFile, setCurrentFile] = useState('')
  const [summary, setSummary] = useState<BatchSummary>()
  const [focusedResultId, setFocusedResultId] = useState<string>()
  const [modal, setModal] = useState<ModalKind>(null)
  const [notice, setNotice] = useState<Notice>()
  const [isDragging, setIsDragging] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo>()
  const [recovery, setRecovery] = useState<RecoveryRecord>()
  const noticeTimer = useRef<number | undefined>(undefined)

  const showNotice = useCallback((next: Notice) => {
    window.clearTimeout(noticeTimer.current)
    setNotice(next)
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), 5_000)
  }, [])

  useEffect(() => {
    let mounted = true
    void Promise.all([
      api.getPreferences(),
      api.getAppInfo(),
      api.getRecoveryRecord()
    ]).then(([preferences, info, recoveryRecord]) => {
      if (!mounted) return
      setRecursive(preferences.recursive)
      setShowThumbnails(preferences.showThumbnails)
      setDefaultOutputFolder(preferences.defaultOutputFolder)
      setOutputParent((current) => current || preferences.defaultOutputFolder)
      setAppInfo(info)
      setRecovery(recoveryRecord)
    })
    return () => {
      mounted = false
      window.clearTimeout(noticeTimer.current)
    }
  }, [])

  useEffect(() => {
    return api.onBatchEvent((event: BatchEvent) => {
      if (event.type === 'phase') {
        setPhase(event.message || PHASE_LABELS[event.phase] || event.phase)
      }
      if (event.type === 'progress') {
        setProgress({ completed: event.completed, total: event.total })
        setCurrentFile(event.currentFile ?? '')
      }
    })
  }, [])

  const savePreferences = useCallback(
    async (next: AppPreferences): Promise<boolean> => {
      try {
        await api.setPreferences(next)
        return true
      } catch {
        showNotice({
          tone: 'warning',
          text: '偏好未能保存，本次操作仍可继续。'
        })
        return false
      }
    },
    [showNotice]
  )

  const resetAnalysis = useCallback(() => {
    setPreflight(undefined)
    setSelectedIds(new Set())
    setFocusedId(undefined)
    setSummary(undefined)
    setFocusedResultId(undefined)
    setCheckedOutputParent('')
    setProgress({ completed: 0, total: 0 })
    setStage('setup')
  }, [])

  const addInputs = useCallback(
    (paths: string[], kind: InputKind) => {
      if (!paths.length) return
      const next = paths.map((path) => makeInput(path, kind))
      setInputs((current) => {
        const byId = new Map(current.map((item) => [item.id, item]))
        next.forEach((item) => byId.set(item.id, item))
        return Array.from(byId.values())
      })
      if (stage !== 'setup') resetAnalysis()
    },
    [resetAnalysis, stage]
  )

  const chooseFiles = async (): Promise<void> => {
    try {
      addInputs(await api.selectFiles(), 'file')
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const chooseOutput = async (
    saveAsDefault = false
  ): Promise<string | undefined> => {
    try {
      const path = await api.selectOutputFolder()
      if (!path) return undefined
      setOutputParent(path)
      if (path !== checkedOutputParent) setCheckedOutputParent('')
      if (saveAsDefault) {
        setDefaultOutputFolder(path)
        const saved = await savePreferences({
          recursive,
          showThumbnails,
          defaultOutputFolder: path
        })
        if (saved) {
          showNotice({ tone: 'success', text: '默认输出文件夹已保存。' })
        }
      }
      return path
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
      return undefined
    }
  }

  const executeProcess = async (
    preflightResult: PreflightSummary,
    fileIds: ReadonlySet<string>,
    targetOutput: string
  ): Promise<void> => {
    setModal(null)
    setStage('processing')
    setProgress({ completed: 0, total: fileIds.size })
    setPhase('正在核对源文件是否在预检后发生变化…')
    setIsCancelling(false)
    try {
      const result = await api.process({
        batchId: preflightResult.batchId,
        mode,
        selectedFileIds: Array.from(fileIds),
        outputParent: targetOutput
      })
      setSummary(result)
      setFocusedResultId(result.results[0]?.fileId)
      setStage('complete')
    } catch (error) {
      setStage('review')
      showNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsCancelling(false)
    }
  }

  const handleDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    setIsDragging(false)
    const dropped: InputSelection[] = []
    for (const item of Array.from(event.dataTransfer.items)) {
      const file = item.getAsFile()
      if (!file) continue
      const entry = (
        item as DataTransferItem & {
          webkitGetAsEntry?: () => { isDirectory?: boolean } | null
        }
      ).webkitGetAsEntry?.()
      const path = api.pathForFile(file)
      if (!path) continue
      const lower = path.toLocaleLowerCase()
      const kind: InputKind = entry?.isDirectory
        ? 'folder'
        : lower.endsWith('.zip') || lower.endsWith('.rar')
          ? 'archive'
          : 'file'
      dropped.push(makeInput(path, kind))
    }
    if (!dropped.length) {
      showNotice({
        tone: 'warning',
        text: '没有取得可用的本地路径，请改用上方选择按钮。'
      })
      return
    }
    setInputs((current) => {
      const byId = new Map(current.map((item) => [item.id, item]))
      dropped.forEach((item) => byId.set(item.id, item))
      return Array.from(byId.values())
    })
    if (stage !== 'setup') resetAnalysis()
  }

  const runPreflight = async ({
    checkOutput = false,
    autoProcess = false
  }: PreflightRunOptions = {}): Promise<void> => {
    if (!inputs.length) {
      showNotice({ tone: 'warning', text: '请先添加图片、文件夹或压缩包。' })
      return
    }
    const hasArchive = inputs.some((input) => input.kind === 'archive')
    const needsOutputCheck = checkOutput || autoProcess || hasArchive
    let targetOutputParent = outputParent
    if (needsOutputCheck && !targetOutputParent && autoProcess) {
      targetOutputParent = (await chooseOutput(true)) ?? ''
    }
    if (needsOutputCheck && !targetOutputParent) {
      showNotice({
        tone: 'warning',
        text: hasArchive
          ? '压缩包预检需要先选择输出位置，用于安全解压临时文件。'
          : '请先选择输出位置。'
      })
      return
    }
    const priorSelected = selectedIds
    setStage('preflighting')
    setProgress({ completed: 0, total: 0 })
    setCurrentFile('')
    setIsCancelling(false)
    setPhase(
      needsOutputCheck ? '正在预检并核对磁盘空间…' : '正在扫描输入…'
    )
    try {
      const request = {
        mode,
        recursive,
        inputs,
        ...(needsOutputCheck && targetOutputParent
          ? { outputParent: targetOutputParent }
          : {})
      }
      const result = await api.preflight(request)
      setPreflight(result)
      const availableFiles = result.files.filter(eligible)
      const defaultIds = new Set(availableFiles.map((file) => file.id))
      const nextSelectedIds =
        needsOutputCheck && priorSelected.size && !autoProcess
          ? new Set(
              Array.from(priorSelected).filter((id) =>
                defaultIds.has(id)
              )
            )
          : defaultIds
      setSelectedIds(nextSelectedIds)
      setFocusedId(availableFiles[0]?.id ?? result.files[0]?.id)
      setCheckedOutputParent(
        needsOutputCheck && result.availableBytes !== undefined
          ? targetOutputParent
          : ''
      )
      setStage('review')
      if (autoProcess) {
        if (!nextSelectedIds.size) {
          showNotice({
            tone: 'warning',
            text: '预检完成，但没有可安全输出的图片。请查看异常项目。'
          })
          return
        }
        const requiredBytes = availableFiles.reduce(
          (sum, file) => sum + file.bytes,
          0
        )
        if (
          result.availableBytes === undefined ||
          result.availableBytes <
            requiredBytes + Math.max(requiredBytes * 0.1, 2 * 1024 ** 3)
        ) {
          showNotice({
            tone: 'danger',
            text:
              result.availableBytes === undefined
                ? '未能确认输出位置的可用空间，请更换位置后重试。'
                : '输出位置可用空间不足，请更换位置后重试。'
          })
          return
        }
        await executeProcess(result, nextSelectedIds, targetOutputParent)
        return
      }
      if (needsOutputCheck) {
        showNotice({
          tone: 'success',
          text: checkOutput
            ? '重新预检与磁盘空间检查已完成，请核对后开始处理。'
            : '压缩包预检与磁盘空间检查已完成，请核对后开始处理。'
        })
      } else if (result.warnings.length) {
        showNotice({ tone: 'warning', text: result.warnings[0] ?? '预检完成' })
      } else {
        showNotice({ tone: 'success', text: '预检完成，未发现阻断问题。' })
      }
    } catch (error) {
      resetAnalysis()
      showNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const files = preflight?.files ?? []
  const counts = useMemo(() => {
    const count = (state: SubjectState) =>
      files.filter((file) => stateOf(file) === state).length
    return {
      total: files.length,
      untagged: count('untagged'),
      compliant: count('compliant'),
      duplicate: count('duplicate'),
      similar: count('similar'),
      error: files.filter(
        (file) => file.errorCode || stateOf(file) === 'malformed'
      ).length
    }
  }, [files])

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return files.filter((file) => {
      const matchesQuery =
        !normalized ||
        file.displayName.toLocaleLowerCase().includes(normalized) ||
        file.relativePath.toLocaleLowerCase().includes(normalized) ||
        file.sourcePath.toLocaleLowerCase().includes(normalized)
      if (!matchesQuery) return false
      if (filter === 'all') return true
      if (filter === 'selected') return selectedIds.has(file.id)
      if (filter === 'error') {
        return Boolean(file.errorCode) || stateOf(file) === 'malformed'
      }
      return stateOf(file) === filter
    })
  }, [files, filter, query, selectedIds])

  const visibleEligible = filteredFiles.filter(eligible)
  const visibleSelected = visibleEligible.filter((file) =>
    selectedIds.has(file.id)
  )
  const allVisibleSelected =
    visibleEligible.length > 0 && visibleSelected.length === visibleEligible.length
  const someVisibleSelected =
    visibleSelected.length > 0 && !allVisibleSelected
  const selectedBytes = files
    .filter((file) => selectedIds.has(file.id))
    .reduce((sum, file) => sum + file.bytes, 0)
  const selectedRequiredBytes = selectedBytes

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleVisible = (): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        visibleEligible.forEach((file) => next.delete(file.id))
      } else {
        visibleEligible.forEach((file) => next.add(file.id))
      }
      return next
    })
  }

  const requestProcess = (): void => {
    if (!selectedIds.size) {
      showNotice({
        tone: 'warning',
        text: '请至少勾选一张图片。'
      })
      return
    }
    if (!outputParent) {
      void chooseOutput(true)
      return
    }
    if (
      checkedOutputParent !== outputParent ||
      preflight?.availableBytes === undefined
    ) {
      void runPreflight({ checkOutput: true })
      return
    }
    if (
      preflight.availableBytes <
      selectedRequiredBytes +
        Math.max(selectedRequiredBytes * 0.1, 2 * 1024 ** 3)
    ) {
      showNotice({
        tone: 'danger',
        text: '输出位置可用空间不足，请更换位置后重新预检。'
      })
      return
    }
    if (mode === 'remove') setModal('remove-confirm')
    else if (preflight) void executeProcess(preflight, selectedIds, outputParent)
  }

  const startProcess = async (): Promise<void> => {
    if (!preflight || !outputParent) return
    await executeProcess(preflight, selectedIds, outputParent)
  }

  const cancelProcess = async (): Promise<void> => {
    setIsCancelling(true)
    setPhase(stage === 'preflighting' ? '正在取消预检…' : '正在安全停止；已完成并校验的输出会保留…')
    try {
      await api.cancel()
    } catch (error) {
      setIsCancelling(false)
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const changeMode = (nextMode: EditableMode): void => {
    if (stage === 'processing' || stage === 'preflighting') return
    if (nextMode === mode) return
    setMode(nextMode)
    resetAnalysis()
    setNotice(undefined)
  }

  const newBatch = (): void => {
    setInputs([])
    setOutputParent(defaultOutputFolder)
    setQuery('')
    setFilter('all')
    setNotice(undefined)
    resetAnalysis()
  }

  const exportRecovery = async (): Promise<void> => {
    try {
      const path = await api.exportRecoveryRecord()
      if (path) {
        showNotice({ tone: 'success', text: `恢复记录已导出：${path}` })
      }
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const deleteRecovery = async (): Promise<void> => {
    try {
      await api.clearRecoveryRecord()
      setRecovery(undefined)
      setModal(null)
      showNotice({ tone: 'success', text: '恢复记录已删除，已有输出未受影响。' })
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const elapsed =
    summary &&
    Math.max(
      0,
      new Date(summary.finishedAt).getTime() -
        new Date(summary.startedAt).getTime()
    )

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-mark">
          <Tag size={17} strokeWidth={2.4} />
        </div>
        <strong>AI人物标签</strong>
        <span>v{appInfo?.version ?? '0.1.0-beta.2'}</span>
        <div className="titlebar-spacer" />
        {isDemo ? <span className="demo-badge">浏览器演示</span> : null}
        <span className="offline-badge">
          <ShieldCheck size={14} />
          离线运行
        </span>
      </header>

      <div className="app-body">
        <section className="workspace">
          {recovery && stage !== 'processing' ? (
            <div className="recovery-banner">
              <TriangleAlert size={18} />
              <div>
                <strong>发现未完成批次的恢复记录</strong>
                <span>
                  {recovery.reason} · {formatDate(recovery.createdAt)}
                  {recovery.temporaryPaths?.length
                    ? ` · ${recovery.temporaryPaths.length} 个受控残留目录`
                    : ''}
                </span>
              </div>
              <button
                type="button"
                className="button secondary compact-button"
                onClick={() => void exportRecovery()}
              >
                <FileSpreadsheet size={15} />
                导出记录
              </button>
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => setModal('recovery-delete')}
              >
                删除
              </button>
            </div>
          ) : null}

          {stage === 'complete' && summary ? (
            <div className="complete-layout">
              <section className="complete-main">
                <div className="complete-hero">
                  <div
                    className={
                      summary.failed || summary.cancelled
                        ? 'complete-icon partial'
                        : 'complete-icon'
                    }
                  >
                    {summary.failed || summary.cancelled ? (
                      <CircleAlert size={25} />
                    ) : (
                      <CheckCircle2 size={25} />
                    )}
                  </div>
                  <div>
                    <span className="eyebrow">
                      批次 {summary.batchId}
                    </span>
                    <h1>
                      {summary.failed || summary.cancelled
                        ? '批次已完成，存在未通过项目'
                        : '批次处理完成'}
                    </h1>
                    <p>所有成功图片均已通过处理后二次校验并保存到批次文件夹。</p>
                  </div>
                </div>

                <div className="result-summary-strip">
                  <div>
                    <i className="dot success" />
                    <span>成功</span>
                    <strong>{summary.succeeded}</strong>
                  </div>
                  <div>
                    <i className="dot warning" />
                    <span>跳过</span>
                    <strong>{summary.skipped}</strong>
                  </div>
                  <div>
                    <i className="dot danger" />
                    <span>失败</span>
                    <strong>{summary.failed}</strong>
                  </div>
                  <div>
                    <i className="dot neutral" />
                    <span>已取消</span>
                    <strong>{summary.cancelled}</strong>
                  </div>
                  <div className="summary-total">
                    <span>总计</span>
                    <strong>{summary.total}</strong>
                  </div>
                </div>

                <div className="batch-toolbar">
                  <dl>
                    <div>
                      <dt>耗时</dt>
                      <dd>
                        {elapsed !== undefined
                          ? `${Math.floor(elapsed / 60_000)
                              .toString()
                              .padStart(2, '0')}:${Math.floor(
                              (elapsed % 60_000) / 1_000
                            )
                              .toString()
                              .padStart(2, '0')}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>输出位置</dt>
                      <dd title={summary.outputDirectory}>
                        {summary.outputDirectory}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void chooseOutput(true)}
                  >
                    <FolderInput size={16} />
                    更换文件夹
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={newBatch}
                  >
                    <RotateCcw size={16} />
                    新建批次
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => void api.openPath(summary.outputDirectory)}
                  >
                    <FolderOpen size={16} />
                    打开输出
                  </button>
                </div>

                <div className="result-table">
                  <div className="result-table-head">
                    <span>文件名</span>
                    <span>原始状态</span>
                    <span>执行动作</span>
                    <span>二次校验</span>
                    <span>图像载荷 SHA-256</span>
                    <span>错误</span>
                  </div>
                  <div className="result-table-body">
                    {summary.results.map((result) => {
                      const source = files.find(
                        (file) => file.id === result.fileId
                      )
                      const passed = result.outcome === 'passed'
                      return (
                        <button
                          type="button"
                          className={`result-row${focusedResultId === result.fileId ? ' selected' : ''}`}
                          key={result.fileId}
                          onClick={() => setFocusedResultId(result.fileId)}
                        >
                          <span className="result-file-cell">
                            {source?.thumbnailDataUrl ? (
                              <img src={source.thumbnailDataUrl} alt="" />
                            ) : (
                              <i>
                                <FileImage size={15} />
                              </i>
                            )}
                            <b>{source?.displayName ?? basename(result.sourcePath)}</b>
                          </span>
                          <span>
                            {result.originalState
                              ? SUBJECT_META[result.originalState].label
                              : '—'}
                          </span>
                          <span>{ACTION_LABELS[result.action]}</span>
                          <span
                            className={
                              passed ? 'passed-text' : 'failed-text'
                            }
                          >
                            {passed ? (
                              <CircleCheck size={14} />
                            ) : (
                              <CircleX size={14} />
                            )}
                            {passed ? '通过' : '失败'}
                          </span>
                          <code title={result.payloadSha256}>
                            {result.payloadSha256
                              ? `${result.payloadSha256.slice(0, 18)}…`
                              : '—'}
                          </code>
                          <span title={result.errorMessage}>
                            {result.errorMessage ?? '—'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </section>
              <footer className="complete-footer">
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    {summary.mode === 'detect' ? (
                      <>
                        源文件未修改；检测结果仅在当前页面显示
                      </>
                    ) : (
                      <>
                        源文件未修改；成功图片已直接保存到本批次文件夹
                      </>
                    )}
                  </span>
                </div>
              </footer>
            </div>
          ) : (
            <>
              <div className="workspace-heading">
                <div>
                  <span className="eyebrow">
                    {MODE_META[mode].short}模式
                  </span>
                  <h1>{MODE_META[mode].label}</h1>
                  <p>{MODE_META[mode].description}</p>
                </div>
                {preflight ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={stage === 'processing' || stage === 'preflighting'}
                    onClick={() =>
                      void runPreflight({ checkOutput: Boolean(outputParent) })
                    }
                  >
                    <RefreshCw size={15} />
                    重新预检
                  </button>
                ) : null}
              </div>

              <div className="content-grid">
                <main className="work-main">
                  <div className="input-toolbar">
                    <button
                      type="button"
                      className="button primary"
                      disabled={stage === 'processing' || stage === 'preflighting'}
                      onClick={() => void chooseFiles()}
                    >
                      <FilePlus2 size={17} />
                      添加图片
                    </button>
                    <label className="mode-select" aria-label="选择标签操作">
                      <select
                        value={mode}
                        disabled={stage === 'processing' || stage === 'preflighting'}
                        onChange={(event) =>
                          changeMode(event.currentTarget.value as EditableMode)
                        }
                      >
                        <option value="add">添加标签</option>
                        <option value="remove">移除标签</option>
                      </select>
                      <ChevronDown size={15} aria-hidden="true" />
                    </label>
                    <div className="switch-control">
                      <div className="recursive-help">
                        <button
                          type="button"
                          className="recursive-help-trigger"
                          aria-label="查看处理子文件夹的说明"
                          aria-describedby="recursive-help-tooltip"
                        >
                          <Info size={15} aria-hidden="true" />
                        </button>
                        <div
                          id="recursive-help-tooltip"
                          className="recursive-help-tooltip"
                          role="tooltip"
                        >
                          <strong>处理子文件夹说明</strong>
                          <p>
                            <b>勾选：</b>
                            扫描该文件夹以及里面所有层级的子文件夹。
                          </p>
                          <p>
                            <b>不勾选：</b>
                            只扫描当前文件夹第一层的图片。
                          </p>
                          <pre aria-label="文件夹结构示例">{`产品图/
├── 主图.jpg
└── 详情图/
    └── 细节.jpg`}</pre>
                          <p>
                            勾选后会处理两张；不勾选只处理
                            <code>主图.jpg</code>。
                          </p>
                          <p className="recursive-help-note">
                            它不会改变输出结构：成功图片仍会全部直接放在批次文件夹中。
                          </p>
                          <p className="recursive-help-note">
                            直接多选图片时，这个选项没有影响。
                          </p>
                        </div>
                      </div>
                      <label className="switch-toggle">
                        <span>同时处理子文件夹里的图片</span>
                        <input
                          type="checkbox"
                          checked={recursive}
                          disabled={stage === 'processing' || stage === 'preflighting'}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked
                            setRecursive(checked)
                            void savePreferences({
                              recursive: checked,
                              showThumbnails,
                              defaultOutputFolder
                            })
                            if (preflight) resetAnalysis()
                          }}
                        />
                        <i aria-hidden="true" />
                      </label>
                    </div>
                  </div>

                  <div className="action-bar top-action-bar">
                    <div className="output-label">
                      <HardDrive size={17} />
                      <span>
                        输出文件夹
                      </span>
                    </div>
                    <button
                      type="button"
                      className="output-path"
                      disabled={stage === 'processing' || stage === 'preflighting'}
                      onClick={() => void chooseOutput(true)}
                    >
                      <FolderOpen size={16} />
                      <span>
                        {outputParent || '点击选择默认输出文件夹'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={stage === 'processing' || stage === 'preflighting'}
                      onClick={() => void chooseOutput(true)}
                    >
                      更换文件夹
                    </button>
                    <div className="disk-status">
                      {preflight?.availableBytes !== undefined &&
                      checkedOutputParent === outputParent ? (
                        <>
                          <CircleCheck size={15} />
                          <span>
                            本次仍需 {formatBytes(selectedRequiredBytes)} ·
                            可用 {formatBytes(preflight.availableBytes)}
                          </span>
                        </>
                      ) : preflight && outputParent ? (
                        <>
                          <CircleAlert size={15} />
                          <span>需重新预检并检查空间</span>
                        </>
                      ) : (
                        <>
                          <Info size={15} />
                          <span>预检后检查磁盘空间</span>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="button primary action-primary"
                      disabled={
                        stage === 'processing' ||
                        stage === 'preflighting' ||
                        (stage === 'setup' && !inputs.length)
                      }
                      onClick={() => {
                        if (stage === 'setup') {
                          void runPreflight({ autoProcess: true })
                        }
                        else requestProcess()
                      }}
                    >
                      {stage === 'preflighting' ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : stage === 'setup' ? (
                        mode === 'add' ? (
                          <Tag size={16} />
                        ) : (
                          <Trash2 size={16} />
                        )
                      ) : checkedOutputParent !== outputParent ? (
                        <HardDrive size={16} />
                      ) : mode === 'remove' ? (
                        <Trash2 size={16} />
                      ) : (
                        <Tag size={16} />
                      )}
                      {stage === 'preflighting'
                        ? '正在预检'
                        : stage === 'setup'
                          ? '一键输出'
                          : !outputParent
                            ? '选择输出位置'
                            : checkedOutputParent !== outputParent
                              ? '检查空间'
                              : '开始处理'}
                    </button>
                  </div>

                  <button
                    type="button"
                    aria-label="添加图片；也可以将图片、文件夹或压缩包拖到这里"
                    className={`drop-zone${isDragging ? ' is-dragging' : ''}${stage !== 'setup' ? ' compact' : ''}`}
                    disabled={stage === 'processing' || stage === 'preflighting'}
                    onClick={() => void chooseFiles()}
                    onDragEnter={(event) => {
                      event.preventDefault()
                      setIsDragging(true)
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={(event) => {
                      if (event.currentTarget === event.target) {
                        setIsDragging(false)
                      }
                    }}
                    onDrop={(event) => void handleDrop(event)}
                  >
                    <UploadCloud size={preflight ? 24 : 30} />
                    <div>
                      <strong>
                        {isDragging
                          ? '松开即可加入本批次'
                          : '拖入图片、文件夹或压缩包，或左键选择图片'}
                      </strong>
                      <span>支持 JPG、JPEG、静态 PNG、ZIP、RAR</span>
                    </div>
                  </button>

                  {inputs.length ? (
                    <div className="input-list">
                      <span className="input-list-label">输入源</span>
                      <div className="input-chips">
                        {inputs.slice(0, 4).map((input) => (
                          <div className="input-chip" key={input.id}>
                            {input.kind === 'folder' ? (
                              <FolderOpen size={14} />
                            ) : input.kind === 'archive' ? (
                              <PackageOpen size={14} />
                            ) : (
                              <FileImage size={14} />
                            )}
                            <span title={input.path}>{basename(input.path)}</span>
                            <small>{inputKindLabel(input.kind)}</small>
                            <button
                              type="button"
                              aria-label={`移除 ${basename(input.path)}`}
                              disabled={
                                stage === 'processing' ||
                                stage === 'preflighting'
                              }
                              onClick={() => {
                                setInputs((current) =>
                                  current.filter((item) => item.id !== input.id)
                                )
                                if (preflight) resetAnalysis()
                              }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                        {inputs.length > 4 ? (
                          <span className="more-inputs">
                            另有 {inputs.length - 4} 个
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={stage === 'processing' || stage === 'preflighting'}
                        onClick={() => {
                          setInputs([])
                          resetAnalysis()
                        }}
                      >
                        清空
                      </button>
                    </div>
                  ) : null}

                  {stage === 'setup' ? null : stage === 'preflighting' ? (
                    <div className="loading-state">
                      <LoaderCircle className="spin" size={24} />
                      <strong>{phase}</strong>
                      <span>
                        正在只读检查文件；此阶段不会写入或修改任何图片。
                      </span>
                      {progress.total > 0 ? (
                        <span role="status">已检查 {progress.completed} / {progress.total} 个文件</span>
                      ) : null}
                      {currentFile ? <span className="preflight-current-file" title={currentFile}>{currentFile}</span> : null}
                      <div className={`loading-track${progress.total > 0 ? ' determinate' : ''}`}>
                        <i style={progress.total > 0 ? { width: `${Math.min(100, progress.completed / progress.total * 100)}%` } : undefined} />
                      </div>
                      <button type="button" className="button secondary" disabled={isCancelling} onClick={() => void cancelProcess()}>
                        {isCancelling ? '正在取消…' : '取消预检'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="count-strip" aria-label="预检汇总">
                        <button
                          type="button"
                          className={filter === 'all' ? 'active' : ''}
                          onClick={() => setFilter('all')}
                        >
                          <ListFilter size={15} />
                          <span>全部</span>
                          <strong>{counts.total}</strong>
                        </button>
                        <button
                          type="button"
                          className={filter === 'untagged' ? 'active' : ''}
                          onClick={() => setFilter('untagged')}
                        >
                          <i className="dot neutral" />
                          <span>未标记</span>
                          <strong>{counts.untagged}</strong>
                        </button>
                        <button
                          type="button"
                          className={filter === 'compliant' ? 'active' : ''}
                          onClick={() => setFilter('compliant')}
                        >
                          <i className="dot success" />
                          <span>已标记</span>
                          <strong>{counts.compliant}</strong>
                        </button>
                        <button
                          type="button"
                          className={filter === 'duplicate' ? 'active' : ''}
                          onClick={() => setFilter('duplicate')}
                        >
                          <i className="dot warning" />
                          <span>需规范</span>
                          <strong>{counts.duplicate}</strong>
                        </button>
                        <button
                          type="button"
                          className={filter === 'similar' ? 'active' : ''}
                          onClick={() => setFilter('similar')}
                        >
                          <i className="dot purple" />
                          <span>相似值</span>
                          <strong>{counts.similar}</strong>
                        </button>
                        <button
                          type="button"
                          className={filter === 'error' ? 'active' : ''}
                          onClick={() => setFilter('error')}
                        >
                          <i className="dot danger" />
                          <span>异常</span>
                          <strong>{counts.error}</strong>
                        </button>
                      </div>

                      <div className="file-tools">
                        <label className="search-box">
                          <Search size={16} />
                          <input
                            type="search"
                            value={query}
                            placeholder="搜索文件名或相对路径"
                            onChange={(event) => setQuery(event.currentTarget.value)}
                          />
                          {query ? (
                            <button
                              type="button"
                              aria-label="清空搜索"
                              onClick={() => setQuery('')}
                            >
                              <X size={14} />
                            </button>
                          ) : null}
                        </label>
                        <label className="select-control">
                          <ListFilter size={15} />
                          <select
                            value={filter}
                            onChange={(event) =>
                              setFilter(event.currentTarget.value as FilterValue)
                            }
                          >
                            <option value="all">全部状态</option>
                            <option value="untagged">未标记</option>
                            <option value="compliant">已标记</option>
                            <option value="duplicate">已标记但需规范</option>
                            <option value="similar">存在相似值</option>
                            <option value="error">异常</option>
                            <option value="selected">仅已勾选</option>
                          </select>
                          <ChevronDown size={14} />
                        </label>
                        <label className="thumbnail-toggle">
                          <input
                            type="checkbox"
                            checked={showThumbnails}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked
                              setShowThumbnails(checked)
                              void savePreferences({
                                recursive,
                                showThumbnails: checked,
                                defaultOutputFolder
                              })
                            }}
                          />
                          <ImageIcon size={15} />
                          缩略图
                        </label>
                      </div>

                      <div
                        className={`file-table${showThumbnails ? '' : ' no-thumbnails'}${stage === 'processing' ? ' is-processing' : ''}`}
                      >
                        <div className="file-table-head">
                          <span>
                            <Checkbox
                              checked={allVisibleSelected}
                              indeterminate={someVisibleSelected}
                              disabled={
                                !visibleEligible.length || stage === 'processing'
                              }
                              label="勾选当前筛选结果"
                              onChange={toggleVisible}
                            />
                          </span>
                          <span>文件名</span>
                          <span>相对路径</span>
                          <span>标签状态</span>
                          <span>处理动作</span>
                          <span>大小</span>
                        </div>
                        <div className="file-table-body">
                          {filteredFiles.length ? (
                            filteredFiles.map((file) => {
                              const selected = selectedIds.has(file.id)
                              return (
                                <div
                                  tabIndex={0}
                                  className={`file-row${focusedId === file.id ? ' focused' : ''}${selected ? ' checked' : ''}${!eligible(file) ? ' unavailable' : ''}`}
                                  key={file.id}
                                  onClick={() => setFocusedId(file.id)}
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === 'Enter' ||
                                      event.key === ' '
                                    ) {
                                      event.preventDefault()
                                      setFocusedId(file.id)
                                    }
                                  }}
                                >
                                  <span>
                                    <Checkbox
                                      checked={selected}
                                      disabled={
                                        !eligible(file) || stage === 'processing'
                                      }
                                      label={`选择 ${file.displayName}`}
                                      onChange={() => toggleSelected(file.id)}
                                    />
                                  </span>
                                  <span className="file-name-cell">
                                    {showThumbnails ? (
                                      file.thumbnailDataUrl ? (
                                        <img
                                          src={file.thumbnailDataUrl}
                                          alt=""
                                          loading="lazy"
                                        />
                                      ) : (
                                        <i>
                                          <FileImage size={16} />
                                        </i>
                                      )
                                    ) : null}
                                    <b title={file.displayName}>
                                      {file.displayName}
                                    </b>
                                  </span>
                                  <span title={file.relativePath}>
                                    {file.relativePath}
                                  </span>
                                  <span>
                                    <StatusPill state={stateOf(file)} compact />
                                  </span>
                                  <span>{actionFor(file, mode)}</span>
                                  <span>{formatBytes(file.bytes)}</span>
                                </div>
                              )
                            })
                          ) : (
                            <div className="empty-table">
                              <Search size={21} />
                              <strong>没有匹配的文件</strong>
                              <span>请调整搜索词或状态筛选。</span>
                            </div>
                          )}
                        </div>
                        <div className="table-footer">
                          <span>
                            已勾选 <strong>{selectedIds.size}</strong> 张（
                            {formatBytes(selectedBytes)}）
                          </span>
                          <span>
                            显示 {filteredFiles.length} / {files.length}
                          </span>
                        </div>
                      </div>
                    </>
                  )}

                  {stage === 'processing' ? (
                    <div className="processing-panel">
                      <div className="processing-heading">
                        <div className="processing-icon">
                          <LoaderCircle className="spin" size={20} />
                        </div>
                        <div>
                          <strong>{phase}</strong>
                          <span title={currentFile}>
                            {currentFile || '正在准备文件…'}
                          </span>
                        </div>
                        <b>
                          {progress.completed} / {progress.total}
                        </b>
                      </div>
                      <div className="progress-track">
                        <i
                          style={{
                            width: `${progress.total ? Math.min(100, (progress.completed / progress.total) * 100) : 2}%`
                          }}
                        />
                      </div>
                      <div className="processing-foot">
                        <span>
                          <ShieldCheck size={14} />
                          成功输出会逐张校验后保留
                        </span>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={isCancelling}
                          onClick={() => void cancelProcess()}
                        >
                          {isCancelling ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <CircleX size={15} />
                          )}
                          {isCancelling ? '正在取消' : '取消批次'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </main>

              </div>

            </>
          )}
        </section>
      </div>

      {notice ? (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.tone === 'success' ? (
            <CircleCheck size={17} />
          ) : notice.tone === 'danger' ? (
            <CircleX size={17} />
          ) : notice.tone === 'warning' ? (
            <TriangleAlert size={17} />
          ) : (
            <Info size={17} />
          )}
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setNotice(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {modal ? (
        <ConfirmModal
          kind={modal}
          selectedCount={selectedIds.size}
          onClose={() => setModal(null)}
          onProcess={() => void startProcess()}
          onDeleteRecovery={() => void deleteRecovery()}
        />
      ) : null}

    </div>
  )
}

export default App
