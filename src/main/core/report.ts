import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  APP_VERSION,
  RULE_VERSION,
  type BatchSummary,
  type FileResult,
  type OperationMode
} from '../../shared/contracts'
import { atomicWrite } from './runtime-fs'

const CSV_COLUMNS = [
  '批次ID',
  '工具版本',
  '规则版本',
  '处理模式',
  '源文件路径',
  '输出文件路径',
  '来源类型',
  '原始标签状态',
  '执行动作',
  '二次校验状态',
  '处理结果',
  '源文件SHA-256',
  '输出文件SHA-256',
  '图像载荷SHA-256',
  '错误代码',
  '错误说明',
  '完成时间'
] as const

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function csvCell(value: unknown): string {
  const text = neutralizeSpreadsheetFormula(
    value === undefined || value === null ? '' : String(value)
  )
  return `"${text.replaceAll('"', '""')}"`
}

function modeLabel(mode: OperationMode): string {
  if (mode === 'detect') return '仅检测'
  if (mode === 'add') return '添加标签'
  return '移除标签'
}

function resultRow(
  batchId: string,
  mode: OperationMode,
  result: FileResult
): string {
  return [
    batchId,
    APP_VERSION,
    RULE_VERSION,
    modeLabel(mode),
    result.sourcePath,
    result.outputPath,
    result.sourceType,
    result.originalState,
    result.action,
    result.postVerifyState,
    result.outcome,
    result.sourceSha256,
    result.outputSha256,
    result.payloadSha256,
    result.errorCode,
    result.errorMessage,
    result.finishedAt
  ]
    .map(csvCell)
    .join(',')
}

export async function writeCsvReport(
  directory: string,
  summary: Omit<BatchSummary, 'reportPath' | 'logPath'>
): Promise<string> {
  const reportPath = join(directory, 'report.csv')
  const rows = [
    CSV_COLUMNS.map(csvCell).join(','),
    ...summary.results.map((result) =>
      resultRow(summary.batchId, summary.mode, result)
    )
  ]
  await atomicWrite(reportPath, `\uFEFF${rows.join('\r\n')}\r\n`)
  return reportPath
}

export class DiagnosticLogger {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.path = join(directory, 'diagnostic.log')
  }

  async initialize(context: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await atomicWrite(
      this.path,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        event: 'batch-start',
        appVersion: APP_VERSION,
        ruleVersion: RULE_VERSION,
        platform: process.platform,
        arch: process.arch,
        ...context
      })}\n`
    )
  }

  write(
    level: 'INFO' | 'WARN' | 'ERROR',
    event: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details
    })}\n`
    this.queue = this.queue.then(() => appendFile(this.path, line))
    return this.queue
  }

  async flush(): Promise<void> {
    await this.queue
  }
}

