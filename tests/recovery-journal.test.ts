import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecoveryJournal } from '../src/main/core/recovery-journal'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

describe('recovery journal', () => {
  it('keeps a durable ordered result stream until successful cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-labeler-journal-'))
    temporaryDirectories.push(directory)
    const journal = new RecoveryJournal(directory, 'batch-1')
    await journal.initialize('add', '/output')
    await Promise.all([
      journal.append({
        fileId: '1',
        sourcePath: '/input/1.jpg',
        sourceType: 'direct-file',
        action: 'add-standard',
        outcome: 'passed',
        finishedAt: '2026-07-29T00:00:01.000Z'
      }),
      journal.append({
        fileId: '2',
        sourcePath: '/input/2.jpg',
        sourceType: 'direct-file',
        action: 'skip',
        outcome: 'failed',
        errorCode: 'MALFORMED_METADATA',
        finishedAt: '2026-07-29T00:00:02.000Z'
      })
    ])
    await journal.flush()
    const lines = (await readFile(journal.path, 'utf8')).trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).fileId).slice(1)).toEqual([
      '1',
      '2'
    ])
    await journal.remove()
    await expect(readFile(journal.path, 'utf8')).rejects.toThrow()
  })
})

