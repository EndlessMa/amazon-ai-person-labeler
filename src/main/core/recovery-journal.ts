import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileResult, OperationMode } from '../../shared/contracts'
import { atomicWrite } from './runtime-fs'

export class RecoveryJournal {
  readonly directory: string
  readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(
    appDataDirectory: string,
    private readonly batchId: string
  ) {
    this.directory = join(appDataDirectory, 'recovery-journals', batchId)
    this.path = join(this.directory, 'batch-results.jsonl')
  }

  async initialize(mode: OperationMode, outputDirectory: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await atomicWrite(
      this.path,
      `${JSON.stringify({
        type: 'batch',
        batchId: this.batchId,
        mode,
        outputDirectory,
        startedAt: new Date().toISOString()
      })}\n`
    )
  }

  append(result: FileResult): Promise<void> {
    const line = `${JSON.stringify({ type: 'file-result', ...result })}\n`
    this.queue = this.queue.then(() => appendFile(this.path, line))
    return this.queue
  }

  async flush(): Promise<void> {
    await this.queue
  }

  async remove(): Promise<void> {
    await this.flush()
    await rm(this.directory, { recursive: true, force: true })
  }
}

