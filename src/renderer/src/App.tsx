import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardCheck,
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
  type BatchEvent,
  type BatchSummary,
  type FileResult,
  type InputKind,
  type InputSelection,
  type OperationMode,
  type PreflightSummary,
  type RecoveryRecord,
  type ScannedFile,
  type SubjectState
} from '../../shared/contracts'
import { desktopApi } from './demo'

type Stage = 'setup' | 'preflighting' | 'review' | 'processing' | 'complete'
type FilterValue =
  | 'all'
  | SubjectState
  | 'error'
  | 'selected'
type ModalKind =
  | 'add-confirm'
  | 'remove-confirm'
  | 'recovery-delete'
  | null
type Notice = { tone: 'info' | 'success' | 'warning' | 'danger'; text: string }

const MODE_META: Record<
  OperationMode,
  {
    label: string
    short: string
    description: string
    Icon: typeof ScanSearch
  }
> = {
  detect: {
    label: '仅检测',
    short: '检测',
    description: '只读检查 XMP 标签，不生成图片副本',
    Icon: ScanSearch
  },
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
  reporting: '生成报告',
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

function EmptyDetail(): React.JSX.Element {
  return (
    <aside className="detail-panel empty-detail">
      <div className="empty-detail-icon">
        <ClipboardCheck size={24} />
      </div>
      <h2>XMP 详情</h2>
      <p>预检后选择一张图片，这里会显示全部 dc:subject 值和精确匹配结果。</p>
      <div className="rule-preview">
        <span>固定目标值</span>
        <code>{TARGET_SUBJECT}</code>
      </div>
    </aside>
  )
}

function FileDetail({ file }: { file: ScannedFile }): React.JSX.Element {
  const subject = file.subject
  const state = stateOf(file)
  return (
    <aside className="detail-panel">
      <div className="detail-heading">
        <div>
          <span className="eyebrow">只读检查</span>
          <h2>XMP 详情</h2>
        </div>
        <StatusPill state={state} compact />
      </div>

      <div className="detail-file">
        {file.thumbnailDataUrl ? (
          <img src={file.thumbnailDataUrl} alt="" />
        ) : (
          <span className="thumb-placeholder">
            <ImageIcon size={19} />
          </span>
        )}
        <div>
          <strong title={file.displayName}>{file.displayName}</strong>
          <span title={file.relativePath}>{file.relativePath}</span>
        </div>
      </div>

      <dl className="detail-facts">
        <div>
          <dt>文件大小</dt>
          <dd>{formatBytes(file.bytes)}</dd>
        </div>
        <div>
          <dt>图像尺寸</dt>
          <dd>
            {file.width && file.height ? `${file.width} × ${file.height}` : '—'}
          </dd>
        </div>
        <div>
          <dt>修改时间</dt>
          <dd>{formatDate(file.modifiedMs)}</dd>
        </div>
        <div>
          <dt>精确匹配数量</dt>
          <dd className={subject?.exactCount ? 'detail-emphasis' : ''}>
            {subject?.exactCount ?? 0}
          </dd>
        </div>
      </dl>

      <div className="subject-section">
        <div className="subject-title">
          <span>dc:subject 全部值</span>
          <small>{subject?.values.length ?? 0} 项</small>
        </div>
        {subject?.values.length ? (
          <ol className="subject-values">
            {subject.values.map((value, index) => {
              const exact = value === TARGET_SUBJECT
              const similar = subject.similarValues.includes(value)
              return (
                <li key={`${value}-${index}`}>
                  <code title={value}>{value}</code>
                  {exact ? <b className="value-exact">精确</b> : null}
                  {similar ? <b className="value-similar">相似</b> : null}
                </li>
              )
            })}
          </ol>
        ) : (
          <div className="empty-values">未找到 dc:subject 值</div>
        )}
      </div>

      {subject?.similarValues.length ? (
        <div className="inline-warning">
          <TriangleAlert size={15} />
          <span>相似值会原样保留，不视为合规标签。</span>
        </div>
      ) : null}
      {file.errorMessage ? (
        <div className="inline-error">
          <CircleX size={15} />
          <span>{file.errorMessage}</span>
        </div>
      ) : null}
    </aside>
  )
}

function ResultDetail({
  result,
  file
}: {
  result: FileResult
  file?: ScannedFile
}): React.JSX.Element {
  const passed = result.outcome === 'passed'
  return (
    <aside className="detail-panel result-detail">
      <div className="detail-heading">
        <div>
          <span className="eyebrow">处理记录</span>
          <h2>处理详情</h2>
        </div>
        <span
          className={`result-badge ${passed ? 'result-success' : 'result-danger'}`}
        >
          {passed ? <CircleCheck size={14} /> : <CircleX size={14} />}
          {passed ? '通过' : '失败'}
        </span>
      </div>

      <div className="detail-file">
        {file?.thumbnailDataUrl ? (
          <img src={file.thumbnailDataUrl} alt="" />
        ) : (
          <span className="thumb-placeholder">
            <FileImage size={19} />
          </span>
        )}
        <div>
          <strong>{file?.displayName ?? basename(result.sourcePath)}</strong>
          <span>{file?.relativePath ?? result.sourcePath}</span>
        </div>
      </div>

      <dl className="result-facts">
        <div>
          <dt>原始状态</dt>
          <dd>
            {result.originalState
              ? SUBJECT_META[result.originalState].label
              : '—'}
          </dd>
        </div>
        <div>
          <dt>执行动作</dt>
          <dd>{ACTION_LABELS[result.action]}</dd>
        </div>
        <div>
          <dt>二次校验</dt>
          <dd className={passed ? 'passed-text' : 'failed-text'}>
            {passed ? '通过' : result.errorMessage ?? '失败'}
          </dd>
        </div>
        <div>
          <dt>完成时间</dt>
          <dd>{formatDate(result.finishedAt)}</dd>
        </div>
      </dl>

      {result.payloadSha256 ? (
        <div className="hash-block">
          <span>图像载荷 SHA-256</span>
          <code>{result.payloadSha256}</code>
          <small>{passed ? '图像像素数据保持字节一致' : '未通过校验'}</small>
        </div>
      ) : null}

      {result.outputPath ? (
        <div className="output-file-block">
          <span>输出位置</span>
          <button
            type="button"
            title={result.outputPath}
            onClick={() => void api.openPath(result.outputPath!)}
          >
            {result.outputPath}
          </button>
        </div>
      ) : null}
    </aside>
  )
}

function ConfirmModal({
  kind,
  selectedCount,
  mode,
  onClose,
  onProcess,
  onDeleteRecovery
}: {
  kind: Exclude<ModalKind, null>
  selectedCount: number
  mode: OperationMode
  onClose: () => void
  onProcess: () => void
  onDeleteRecovery: () => void
}): React.JSX.Element {
  const add = kind === 'add-confirm'
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
          className={`modal-icon ${add ? 'blue' : recoveryDelete ? 'orange' : 'red'}`}
        >
          {add ? (
            <Tag size={24} />
          ) : recoveryDelete ? (
            <TriangleAlert size={24} />
          ) : (
            <Trash2 size={24} />
          )}
        </div>
        <h2 id="confirm-title">
          {add
            ? '确认添加与规范标签'
            : recoveryDelete
              ? '删除恢复记录？'
              : '确认移除标签'}
        </h2>
        <p>
          {add
            ? `将处理已勾选的 ${selectedCount} 张图片。源文件保持只读，所有结果写入新的批次目录。`
            : recoveryDelete
              ? '删除后，本工具不再提示这条未完成批次。已有输出文件不会被删除。'
              : `将处理已勾选的 ${selectedCount} 张图片，仅从副本中移除精确目标值。源文件保持只读，所有结果写入新的批次目录。`}
        </p>
        {!recoveryDelete ? (
          <div className="modal-rule">
            <span>{mode === 'remove' ? '将移除' : '固定写入值'}</span>
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
              className={`button ${add ? 'primary' : 'danger'}`}
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
  const [mode, setMode] = useState<OperationMode>('detect')
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
    (nextRecursive: boolean, nextThumbnails: boolean) => {
      void api
        .setPreferences({
          recursive: nextRecursive,
          showThumbnails: nextThumbnails
        })
        .catch(() => {
          showNotice({
            tone: 'warning',
            text: '偏好未能保存，本次操作仍可继续。'
          })
        })
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

  const chooseFolder = async (): Promise<void> => {
    try {
      addInputs(await api.selectFolder(), 'folder')
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const chooseArchive = async (): Promise<void> => {
    try {
      addInputs(await api.selectArchive(), 'archive')
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const chooseOutput = async (): Promise<void> => {
    try {
      const path = await api.selectOutputFolder()
      if (!path) return
      setOutputParent(path)
      if (path !== checkedOutputParent) setCheckedOutputParent('')
    } catch (error) {
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
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

  const runPreflight = async (checkOutput = false): Promise<void> => {
    if (!inputs.length) {
      showNotice({ tone: 'warning', text: '请先添加图片、文件夹或压缩包。' })
      return
    }
    const hasArchive = inputs.some((input) => input.kind === 'archive')
    const needsOutputCheck = checkOutput || hasArchive
    if (needsOutputCheck && !outputParent) {
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
    setPhase(
      needsOutputCheck ? '正在预检并核对磁盘空间…' : '正在扫描输入…'
    )
    try {
      const request = {
        mode,
        recursive,
        inputs,
        ...(needsOutputCheck && outputParent ? { outputParent } : {})
      }
      const result = await api.preflight(request)
      setPreflight(result)
      const availableFiles = result.files.filter(eligible)
      const defaultIds = new Set(availableFiles.map((file) => file.id))
      if (needsOutputCheck && priorSelected.size) {
        const allowed = new Set(availableFiles.map((file) => file.id))
        setSelectedIds(
          new Set(Array.from(priorSelected).filter((id) => allowed.has(id)))
        )
      } else {
        setSelectedIds(defaultIds)
      }
      setFocusedId(availableFiles[0]?.id ?? result.files[0]?.id)
      setCheckedOutputParent(
        needsOutputCheck && result.availableBytes !== undefined
          ? outputParent
          : ''
      )
      setStage('review')
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
      setStage(preflight ? 'review' : 'setup')
      showNotice({
        tone: 'danger',
        text: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const files = preflight?.files ?? []
  const focusedFile = files.find((file) => file.id === focusedId)
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
  const selectedRequiredBytes =
    mode === 'detect' ? 32 * 1024 ** 2 : selectedBytes

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
      void chooseOutput()
      return
    }
    if (
      checkedOutputParent !== outputParent ||
      preflight?.availableBytes === undefined
    ) {
      void runPreflight(true)
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
    if (mode === 'detect') {
      void startProcess()
      return
    }
    setModal(mode === 'remove' ? 'remove-confirm' : 'add-confirm')
  }

  const startProcess = async (): Promise<void> => {
    if (!preflight || !outputParent) return
    setModal(null)
    setStage('processing')
    setProgress({ completed: 0, total: selectedIds.size })
    setPhase('正在核对源文件是否在预检后发生变化…')
    setIsCancelling(false)
    try {
      const result = await api.process({
        batchId: preflight.batchId,
        mode,
        selectedFileIds: Array.from(selectedIds),
        outputParent
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

  const cancelProcess = async (): Promise<void> => {
    setIsCancelling(true)
    setPhase('正在安全停止；已完成并校验的输出会保留…')
    try {
      await api.cancel()
    } catch (error) {
      setIsCancelling(false)
      showNotice({ tone: 'danger', text: String(error) })
    }
  }

  const changeMode = (nextMode: OperationMode): void => {
    if (stage === 'processing') return
    if (nextMode === mode) return
    setMode(nextMode)
    resetAnalysis()
    setNotice(undefined)
  }

  const newBatch = (): void => {
    setInputs([])
    setOutputParent('')
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

  const focusedResult = summary?.results.find(
    (result) => result.fileId === focusedResultId
  )
  const focusedResultFile = files.find(
    (file) => file.id === focusedResult?.fileId
  )
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
        <strong>AI 人物标签工具</strong>
        <span>v{appInfo?.version ?? '0.1.0-beta.2'}</span>
        <div className="titlebar-spacer" />
        {isDemo ? <span className="demo-badge">浏览器演示</span> : null}
        <span className="offline-badge">
          <ShieldCheck size={14} />
          离线运行
        </span>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <nav aria-label="处理模式">
            {(Object.keys(MODE_META) as OperationMode[]).map((item) => {
              const meta = MODE_META[item]
              const Icon = meta.Icon
              return (
                <button
                  key={item}
                  type="button"
                  className={mode === item ? 'active' : ''}
                  disabled={stage === 'processing'}
                  onClick={() => changeMode(item)}
                >
                  <Icon size={19} strokeWidth={2} />
                  <span>{meta.label}</span>
                </button>
              )
            })}
          </nav>
          <div className="sidebar-bottom">
            <div className="privacy-note">
              <HardDrive size={15} />
              <span>文件仅在本机处理</span>
            </div>
            <div className="version-rule" title={appInfo?.ruleVersion}>
              规则版本
              <span>{appInfo?.ruleVersion ?? 'amazon-ai-person-xmp-v1'}</span>
            </div>
          </div>
        </aside>

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
                    <p>已生成报告；所有成功图片均已通过处理后二次校验。</p>
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
                    className="button primary"
                    onClick={() => void api.openPath(summary.outputDirectory)}
                  >
                    <FolderOpen size={16} />
                    打开输出
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void api.openPath(summary.reportPath)}
                  >
                    <FileSpreadsheet size={16} />
                    导出报告
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
              {focusedResult ? (
                <ResultDetail
                  result={focusedResult}
                  {...(focusedResultFile ? { file: focusedResultFile } : {})}
                />
              ) : (
                <EmptyDetail />
              )}
              <footer className="complete-footer">
                <div>
                  <ShieldCheck size={18} />
                  <span>
                    {summary.mode === 'detect' ? (
                      <>
                        源文件未修改；检测模式仅生成 <code>report.csv</code>{' '}
                        与诊断日志
                      </>
                    ) : (
                      <>
                        源文件未修改；仅通过校验的图片进入{' '}
                        <code>images/</code> 目录
                      </>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={newBatch}
                >
                  <RotateCcw size={16} />
                  新建批次
                </button>
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
                    onClick={() => void runPreflight(Boolean(outputParent))}
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
                    <button
                      type="button"
                      className="button secondary"
                      disabled={stage === 'processing' || stage === 'preflighting'}
                      onClick={() => void chooseFolder()}
                    >
                      <FolderInput size={17} />
                      添加文件夹
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={stage === 'processing' || stage === 'preflighting'}
                      onClick={() => void chooseArchive()}
                    >
                      <Archive size={17} />
                      添加 ZIP / RAR
                    </button>
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
                            它不会改变输出结构：成功图片仍会全部放在同一个
                            <code>images/</code> 文件夹中。
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
                            savePreferences(checked, showThumbnails)
                            if (preflight) resetAnalysis()
                          }}
                        />
                        <i aria-hidden="true" />
                      </label>
                    </div>
                  </div>

                  <div
                    className={`drop-zone${isDragging ? ' is-dragging' : ''}${preflight ? ' compact' : ''}`}
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
                          : '将图片、文件夹或压缩包拖到这里'}
                      </strong>
                      <span>支持 JPG、JPEG、静态 PNG、ZIP、RAR</span>
                    </div>
                  </div>

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

                  {stage === 'setup' ? (
                    <div className="setup-state">
                      <div className="setup-guidance">
                        <div>
                          <ShieldCheck size={19} />
                          <span>
                            <strong>源文件始终只读</strong>
                            预检只读取文件结构、XMP 与校验信息
                          </span>
                        </div>
                        <div>
                          <ScanSearch size={19} />
                          <span>
                            <strong>先预检再处理</strong>
                            逐张核对状态后再选择输出位置
                          </span>
                        </div>
                        <div>
                          <FileSpreadsheet size={19} />
                          <span>
                            <strong>每批均有报告</strong>
                            文件级结果可用 Excel 打开
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="button primary preflight-button"
                        disabled={!inputs.length}
                        onClick={() => void runPreflight(false)}
                      >
                        <ScanSearch size={17} />
                        开始预检
                      </button>
                    </div>
                  ) : stage === 'preflighting' ? (
                    <div className="loading-state">
                      <LoaderCircle className="spin" size={24} />
                      <strong>{phase}</strong>
                      <span>
                        正在只读检查文件；此阶段不会写入或修改任何图片。
                      </span>
                      <div className="loading-track">
                        <i />
                      </div>
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
                              savePreferences(recursive, checked)
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

                {focusedFile ? <FileDetail file={focusedFile} /> : <EmptyDetail />}
              </div>

              <footer className="action-bar">
                <div className="output-label">
                  <HardDrive size={17} />
                  <span>输出位置</span>
                </div>
                <button
                  type="button"
                  className="output-path"
                  disabled={stage === 'processing' || stage === 'preflighting'}
                  onClick={() => void chooseOutput()}
                >
                  <FolderOpen size={16} />
                  <span>
                    {outputParent || '选择批次输出父文件夹（不会覆盖源文件）'}
                  </span>
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={stage === 'processing' || stage === 'preflighting'}
                  onClick={() => void chooseOutput()}
                >
                  更改
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
                    if (stage === 'setup') void runPreflight(false)
                    else requestProcess()
                  }}
                >
                  {stage === 'preflighting' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : stage === 'setup' ? (
                    <ScanSearch size={16} />
                  ) : checkedOutputParent !== outputParent ? (
                    <HardDrive size={16} />
                  ) : mode === 'detect' ? (
                    <ScanSearch size={16} />
                  ) : mode === 'remove' ? (
                    <Trash2 size={16} />
                  ) : (
                    <Tag size={16} />
                  )}
                  {stage === 'preflighting'
                    ? '正在预检'
                    : stage === 'setup'
                      ? '开始预检'
                      : !outputParent
                        ? '选择输出位置'
                        : checkedOutputParent !== outputParent
                          ? '检查空间'
                          : mode === 'detect'
                            ? '生成检测报告'
                            : '开始处理'}
                </button>
              </footer>
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
          mode={mode}
          onClose={() => setModal(null)}
          onProcess={() => void startProcess()}
          onDeleteRecovery={() => void deleteRecovery()}
        />
      ) : null}
    </div>
  )
}

export default App
