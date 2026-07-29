import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  prepareInputs,
  probeSupportedImage
} from '../src/main/core/scanner'
import type { InputPreparer } from '../src/main/core/batch-service'

const batchServiceCompatiblePreparer: InputPreparer = prepareInputs
void batchServiceCompatiblePreparer

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9])

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function staticPng(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('IDAT'),
    pngChunk('IEND')
  ])
}

function animatedPng(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('acTL', Buffer.alloc(8)),
    pngChunk('IDAT'),
    pngChunk('IEND')
  ])
}

describe('图片结构探测', () => {
  it('接受 JPG/JPEG 和静态 PNG，拒绝 APNG 与扩展名错配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-probe-'))
    const jpeg = join(root, '人物.JPG')
    const png = join(root, '人物.png')
    const apng = join(root, '动画.png')
    const mismatch = join(root, '伪装.jpg')
    await writeFile(jpeg, JPEG)
    await writeFile(png, staticPng())
    await writeFile(apng, animatedPng())
    await writeFile(mismatch, staticPng())

    await expect(probeSupportedImage(jpeg, JPEG.length)).resolves.toEqual({
      format: 'jpeg'
    })
    await expect(
      probeSupportedImage(png, staticPng().length)
    ).resolves.toEqual({ format: 'png' })
    await expect(
      probeSupportedImage(apng, animatedPng().length)
    ).resolves.toMatchObject({ errorCode: 'ANIMATED_PNG' })
    await expect(
      probeSupportedImage(mismatch, staticPng().length)
    ).resolves.toMatchObject({ errorCode: 'EXTENSION_MISMATCH' })
  })

  it('在读取完整大文件前按 500 MB 上限拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-large-'))
    const large = join(root, 'large.jpg')
    await writeFile(large, JPEG)
    await truncate(large, 500 * 1024 ** 2 + 1)

    await expect(
      probeSupportedImage(large, 500 * 1024 ** 2 + 1)
    ).resolves.toMatchObject({
      format: 'jpeg',
      errorCode: 'IMAGE_TOO_LARGE'
    })
  })
})

describe('prepareInputs', () => {
  it('支持文件和递归文件夹，真实路径只处理一次且不按内容去重', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-scan-'))
    const input = join(root, '素材')
    const nested = join(input, '子目录')
    const tempRoot = join(root, 'temp')
    const first = join(input, '同内容-A.jpg')
    const second = join(input, '同内容-B.jpg')
    const nestedPng = join(nested, '人物图.png')
    await mkdir(nested, { recursive: true })
    await writeFile(first, JPEG)
    await writeFile(second, JPEG)
    await writeFile(nestedPng, staticPng())
    await writeFile(join(input, '说明.txt'), 'not image')
    await writeFile(
      join(input, 'Finder替身'),
      Buffer.from([
        0x62, 0x6f, 0x6f, 0x6b, 0x00, 0x00, 0x00, 0x00,
        0x6d, 0x61, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x00
      ])
    )
    let createdSymlink = true
    try {
      await symlink(first, join(input, '链接.jpg'))
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        createdSymlink = false
      } else {
        throw error
      }
    }

    const prepared = await prepareInputs(
      [
        { id: 'direct', path: first, kind: 'file' },
        { id: 'folder', path: input, kind: 'folder' }
      ],
      { recursive: true, tempRoot }
    )
    expect(prepared.candidates.filter((item) =>
      item.displayName === '同内容-A.jpg'
    )).toHaveLength(1)
    expect(prepared.candidates.map((item) => item.displayName)).toEqual(
      expect.arrayContaining(['同内容-A.jpg', '同内容-B.jpg', '人物图.png', '说明.txt'])
    )
    if (createdSymlink) {
      expect(prepared.candidates.some((item) =>
        item.displayName === '链接.jpg'
      )).toBe(false)
    }
    expect(prepared.candidates.some((item) =>
      item.displayName === 'Finder替身'
    )).toBe(false)
    expect(prepared.supportedImages).toBe(3)
    expect(prepared.candidates.find((item) =>
      item.displayName === '说明.txt'
    )).toMatchObject({ errorCode: 'UNSUPPORTED_FORMAT' })
    await prepared.cleanup()
  })

  it('递归关闭时不进入子目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-flat-scan-'))
    const input = join(root, 'input')
    const nested = join(input, 'nested')
    await mkdir(nested, { recursive: true })
    await writeFile(join(input, 'top.jpg'), JPEG)
    await writeFile(join(nested, 'deep.jpg'), JPEG)

    const prepared = await prepareInputs(
      [{ id: 'folder', path: input, kind: 'folder' }],
      { recursive: false, tempRoot: join(root, 'temp') }
    )
    expect(prepared.candidates.map((item) => item.displayName)).toEqual([
      'top.jpg'
    ])
  })

  it.skipIf(process.platform === 'win32')(
    '递归扫描不会跟随指向所选根目录外的目录链接',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'labeler-root-boundary-'))
      const input = join(root, 'input')
      const outside = join(root, 'outside')
      await mkdir(input)
      await mkdir(outside)
      await writeFile(join(outside, '不应读取.jpg'), JPEG)
      await symlink(outside, join(input, '外部目录'))

      const prepared = await prepareInputs(
        [{ id: 'folder', path: input, kind: 'folder' }],
        { recursive: true, tempRoot: join(root, 'temp') }
      )
      expect(prepared.candidates).toEqual([])
      expect(
        prepared.candidates.some((item) => item.displayName === '不应读取.jpg')
      ).toBe(false)
    }
  )

  it('展开 ZIP 为临时候选，并由 cleanup 删除临时目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-zip-scan-'))
    const input = join(root, 'input')
    const archive = join(root, '批次.zip')
    const tempRoot = join(root, 'temp')
    await mkdir(input)
    await writeFile(join(input, '主图.jpg'), JPEG)

    const { getSevenZipExecutable } = await import('../src/main/core/archive')
    const { spawn } = await import('node:child_process')
    const executable = await getSevenZipExecutable()
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        executable,
        ['a', '-tzip', archive, join(input, '主图.jpg'), '-y'],
        { stdio: 'ignore' }
      )
      child.on('error', rejectPromise)
      child.on('close', (code) => {
        if (code === 0) resolvePromise()
        else rejectPromise(new Error(`7-Zip exited ${String(code)}`))
      })
    })

    const prepared = await prepareInputs(
      [{ id: 'archive', path: archive, kind: 'archive' }],
      { recursive: true, tempRoot }
    )
    expect(prepared.candidates).toHaveLength(1)
    expect(prepared.candidates[0]).toMatchObject({
      sourceType: 'zip',
      displayName: '主图.jpg',
      format: 'jpeg'
    })
    expect(prepared.archiveSourceFingerprints).toEqual([
      expect.objectContaining({
        sourceId: 'archive',
        sourcePath: archive,
        canonicalPath: expect.any(String),
        bytes: expect.any(Number),
        modifiedMs: expect.any(Number)
      })
    ])
    const [archiveTemp] = prepared.archiveTemps
    expect(archiveTemp).toBeTruthy()
    await prepared.cleanup()
    await expect(access(archiveTemp!)).rejects.toThrow()
  })

  it('把损坏压缩包和不存在输入转换成可报告错误候选，不阻断其他文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-error-candidates-'))
    const valid = join(root, 'valid.jpg')
    const corruptArchive = join(root, 'broken.zip')
    const missing = join(root, 'missing.jpg')
    await writeFile(valid, JPEG)
    await writeFile(corruptArchive, 'not-an-archive')

    const prepared = await prepareInputs(
      [
        { id: 'valid', path: valid, kind: 'file' },
        { id: 'archive', path: corruptArchive, kind: 'archive' },
        { id: 'missing', path: missing, kind: 'file' }
      ],
      { recursive: true, tempRoot: join(root, 'temp') }
    )
    expect(prepared.candidates.find((item) =>
      item.sourceId === 'valid'
    )).toMatchObject({ format: 'jpeg' })
    expect(prepared.candidates.find((item) =>
      item.sourceId === 'archive'
    )).toMatchObject({ errorCode: 'ARCHIVE_INDEX_CORRUPT' })
    expect(prepared.candidates.find((item) =>
      item.sourceId === 'missing'
    )).toMatchObject({ errorCode: 'SOURCE_READ_FAILED' })
  })

  it('把归档内单条 CRC 失败转换成 CSV 可消费的错误候选', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-crc-candidate-'))
    const source = join(root, 'broken.jpg')
    const archive = join(root, 'crc.zip')
    await writeFile(source, JPEG)

    const { getSevenZipExecutable } = await import('../src/main/core/archive')
    const { spawn } = await import('node:child_process')
    const executable = await getSevenZipExecutable()
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        executable,
        ['a', '-tzip', '-mx=0', archive, source, '-y'],
        { stdio: 'ignore' }
      )
      child.on('error', rejectPromise)
      child.on('close', (code) => {
        if (code === 0) resolvePromise()
        else rejectPromise(new Error(`7-Zip exited ${String(code)}`))
      })
    })
    const bytes = await readFile(archive)
    const payloadOffset = bytes.indexOf(JPEG)
    expect(payloadOffset).toBeGreaterThanOrEqual(0)
    bytes[payloadOffset + 3] = (bytes[payloadOffset + 3] ?? 0) ^ 0xff
    await writeFile(archive, bytes)

    const prepared = await prepareInputs(
      [{ id: 'archive', path: archive, kind: 'archive' }],
      { recursive: true, tempRoot: join(root, 'temp') }
    )
    expect(prepared.candidates).toEqual([
      expect.objectContaining({
        sourceId: 'archive',
        displayName: 'broken.jpg',
        errorCode: 'ARCHIVE_CRC_FAILED'
      })
    ])
    expect(prepared.archiveEntryFailures).toHaveLength(1)
    await prepared.cleanup()
  })
})
