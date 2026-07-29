import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileResult } from '../src/shared/contracts'
import { DiagnosticLogger, writeCsvReport } from '../src/main/core/report'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ai-labeler-report-'))
  temporaryDirectories.push(path)
  return path
}

describe('batch reports', () => {
  it('writes UTF-8 BOM CSV and neutralizes spreadsheet formulas', async () => {
    const directory = await temporaryDirectory()
    const result: FileResult = {
      fileId: '1',
      sourcePath: '=HYPERLINK("bad")',
      sourceType: 'direct-file',
      action: 'detect-only',
      outcome: 'passed',
      finishedAt: '2026-07-29T00:00:00.000Z'
    }
    const reportPath = await writeCsvReport(directory, {
      batchId: 'batch-1',
      mode: 'detect',
      outputDirectory: directory,
      startedAt: '2026-07-29T00:00:00.000Z',
      finishedAt: '2026-07-29T00:00:01.000Z',
      total: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      results: [result]
    })
    const csv = await readFile(reportPath, 'utf8')
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain(`"'=HYPERLINK(""bad"")"`)
    expect(csv).toContain('"amazon-ai-person-xmp-v1"')
  })

  it('serializes diagnostic writes without dropping events', async () => {
    const directory = await temporaryDirectory()
    const logger = new DiagnosticLogger(directory)
    await logger.initialize({ batchId: 'batch-1' })
    await Promise.all([
      logger.write('INFO', 'one'),
      logger.write('WARN', 'two'),
      logger.write('ERROR', 'three')
    ])
    await logger.flush()
    const lines = (await readFile(logger.path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'batch-start',
      'one',
      'two',
      'three'
    ])
  })
})

