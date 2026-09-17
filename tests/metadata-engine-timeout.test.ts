import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  version: vi.fn(),
  readRaw: vi.fn(),
  end: vi.fn(async () => undefined),
  created: vi.fn()
}))
vi.mock('exiftool-vendored', () => ({
  ExifTool: class {
    constructor() { engine.created() }
    version = engine.version
    readRaw = engine.readRaw
    end = engine.end
  }
}))
import { closeMetadataTools, prepareMetadataTools, readMetadataSnapshot } from '../src/main/core/metadata'

afterEach(() => vi.useRealTimers())
afterAll(closeMetadataTools)

describe('metadata engine liveness', () => {
  it('bounds startup even when ExifTool never dequeues a task, then permits retry', async () => {
    vi.useFakeTimers()
    engine.version.mockImplementationOnce(() => new Promise(() => {}))
    const result = expect(prepareMetadataTools(new AbortController().signal))
      .rejects.toThrow('元数据引擎启动超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await result
    expect(engine.end).toHaveBeenCalledWith(false)
    engine.version.mockResolvedValue('13.53')
    await prepareMetadataTools(new AbortController().signal)
    expect(engine.created).toHaveBeenCalledTimes(2)
  })

  it('cancels an in-flight metadata read and restarts for the next batch', async () => {
    engine.readRaw.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = readMetadataSnapshot('/images/test.jpg', controller.signal)
    const result = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await Promise.resolve()
    controller.abort()
    await result
    await prepareMetadataTools(new AbortController().signal)
    engine.readRaw.mockResolvedValue({ 'EXIF:Artist': 'preserved' })
    await expect(readMetadataSnapshot('/images/test.jpg')).resolves.toEqual({ 'EXIF:Artist': 'preserved' })
  })

  it('bounds queued reads and does not classify a hung engine as malformed image metadata', async () => {
    vi.useFakeTimers()
    engine.readRaw.mockImplementationOnce(() => new Promise(() => {}))
    const result = expect(readMetadataSnapshot('/images/stalled.jpg'))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: expect.stringContaining('元数据检查超时') })
    await vi.advanceTimersByTimeAsync(300_000)
    await result
    await expect(readMetadataSnapshot('/images/next.jpg')).rejects.toThrow('元数据引擎已停止')
  })
})
