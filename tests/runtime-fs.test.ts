import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../src/main/core/errors'
import {
  assertPathsDoNotNest,
  createBatchId,
  createUniqueBatchDirectory,
  isPathInside,
  publishFileNoClobber,
  requiredDiskBytes
} from '../src/main/core/runtime-fs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ai-labeler-runtime-'))
  temporaryDirectories.push(path)
  return path
}

describe('runtime filesystem helpers', () => {
  it('creates stable shaped batch IDs and unique directories', async () => {
    const parent = await temporaryDirectory()
    const batchId = createBatchId(new Date('2026-07-29T01:02:03.000Z'))
    expect(batchId).toMatch(/^20260729010203-[A-F0-9]{6}$/)

    const first = await createUniqueBatchDirectory(parent, batchId)
    const second = await createUniqueBatchDirectory(parent, batchId)
    expect(first).not.toBe(second)
    expect(second).toMatch(/-2$/)
  })

  it('detects nesting in either direction', async () => {
    const root = await temporaryDirectory()
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    await mkdir(output)

    expect(isPathInside(root, input)).toBe(true)
    expect(() => assertPathsDoNotNest([input], output)).not.toThrow()
    expect(() =>
      assertPathsDoNotNest([input], join(input, 'generated'))
    ).toThrowError(AppError)
    expect(() => assertPathsDoNotNest([root], output)).toThrowError(
      /不能互相包含/
    )
  })

  it('adds the larger of ten percent and two GiB as reserve', () => {
    expect(requiredDiskBytes(1024)).toBe(1024 + 2 * 1024 ** 3)
    const peak = 30 * 1024 ** 3
    expect(requiredDiskBytes(peak)).toBe(33 * 1024 ** 3)
  })

  it('publishes staged files without overwriting an existing destination', async () => {
    const root = await temporaryDirectory()
    const staged = join(root, 'staged.jpg')
    const destination = join(root, 'output.jpg')
    await writeFile(staged, 'new')
    await writeFile(destination, 'existing')

    await expect(
      publishFileNoClobber(staged, destination)
    ).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' })
    expect(await readFile(destination, 'utf8')).toBe('existing')
    expect(await readFile(staged, 'utf8')).toBe('new')

    await rm(destination)
    await publishFileNoClobber(staged, destination)
    expect(await readFile(destination, 'utf8')).toBe('new')
    await expect(access(staged)).rejects.toThrow()
  })
})
