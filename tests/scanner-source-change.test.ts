import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const CHANGING_FILE = '01-changing.jpg'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (basename(String(args[0])) !== CHANGING_FILE) return handle

      let statCalls = 0
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (
              options?: Parameters<typeof target.stat>[0]
            ): Promise<Awaited<ReturnType<typeof target.stat>>> => {
              const result = await target.stat(options as never)
              statCalls += 1
              if (statCalls < 2) return result
              return new Proxy(result, {
                get(statTarget, statProperty) {
                  if (statProperty === 'mtimeMs') {
                    return Number(statTarget.mtimeMs) + 1
                  }
                  const value = Reflect.get(
                    statTarget,
                    statProperty,
                    statTarget
                  )
                  return typeof value === 'function'
                    ? value.bind(statTarget)
                    : value
                }
              })
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

import { prepareInputs } from '../src/main/core/scanner'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9])

describe('scanner source-change isolation', () => {
  it('records one changing file and continues scanning the rest of its folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-changing-file-'))
    const input = join(root, 'input')
    await mkdir(input)
    await writeFile(join(input, CHANGING_FILE), JPEG)
    await writeFile(join(input, '02-stable.jpg'), JPEG)

    const prepared = await prepareInputs(
      [{ id: 'folder', path: input, kind: 'folder' }],
      { recursive: true, tempRoot: join(root, 'temp') }
    )

    expect(
      prepared.candidates.find((candidate) =>
        candidate.displayName === '02-stable.jpg'
      )
    ).toMatchObject({ format: 'jpeg' })
    expect(
      prepared.candidates.find((candidate) =>
        candidate.displayName === CHANGING_FILE
      )
    ).toMatchObject({
      errorCode: 'SOURCE_CHANGED'
    })
  })
})
