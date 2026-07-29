import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArchiveError,
  cleanupArchiveTemp,
  extractArchive,
  getSevenZipExecutable,
  inspectArchive,
  parseSevenZipTechnicalListing,
  validateArchiveManifest
} from '../src/main/core/archive'

// Fixed, non-sensitive regression archives generated once with the official
// RARLAB RAR 6.12 CLI. The application does not bundle or invoke that tool;
// runtime extraction is exclusively through 7zip-bin-full.
const RAR4_SAMPLE_BASE64 =
  'UmFyIRoHAM+QcwAADQAAAAAAAADuRnQgkjoA1QAAANUAAAADWEhFKEYc/VwUMBUApIEAAOWwj+agty50eHQAXGAPN2gudAB4dACw9Cg9IyMKIyBIb3N0IERhdGFiYXNlCiMKIyBsb2NhbGhvc3QgaXMgdXNlZCB0byBjb25maWd1cmUgdGhlIGxvb3BiYWNrIGludGVyZmFjZQojIHdoZW4gdGhlIHN5c3RlbSBpcyBib290aW5nLiAgRG8gbm90IGNoYW5nZSB0aGlzIGVudHJ5LgojIwoxMjcuMC4wLjEJbG9jYWxob3N0CjI1NS4yNTUuMjU1LjI1NQlicm9hZGNhc3Rob3N0Cjo6MSAgICAgICAgICAgICBsb2NhbGhvc3QKxD17AEAHAA=='
const RAR5_SAMPLE_BASE64 =
  'UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAAUhanNKAIDC9UBBNUBpIMCWEhFKIAAAQrlsI/moLcudHh0CgMTNARpaon/4xcjIwojIEhvc3QgRGF0YWJhc2UKIwojIGxvY2FsaG9zdCBpcyB1c2VkIHRvIGNvbmZpZ3VyZSB0aGUgbG9vcGJhY2sgaW50ZXJmYWNlCiMgd2hlbiB0aGUgc3lzdGVtIGlzIGJvb3RpbmcuICBEbyBub3QgY2hhbmdlIHRoaXMgZW50cnkuCiMjCjEyNy4wLjAuMQlsb2NhbGhvc3QKMjU1LjI1NS4yNTUuMjU1CWJyb2FkY2FzdGhvc3QKOjoxICAgICAgICAgICAgIGxvY2FsaG9zdAodd1ZRAwUEAA=='

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function storedZip(
  entryName: string,
  contents: Buffer,
  options: { crc?: number; flags?: number; prefix?: Buffer } = {}
): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const crc = options.crc ?? crc32(contents)
  const flags = (options.flags ?? 0) | 0x0800

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x033f, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(options.prefix?.length ?? 0, 42)

  const directoryOffset =
    (options.prefix?.length ?? 0) + local.length + name.length + contents.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(directoryOffset, 16)

  return Buffer.concat([
    options.prefix ?? Buffer.alloc(0),
    local,
    name,
    contents,
    central,
    name,
    end
  ])
}

function storedZip64(entryName: string, contents: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const checksum = crc32(contents)
  const flags = 0x0800

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(45, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(0xffffffff, 18)
  local.writeUInt32LE(0xffffffff, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(20, 28)
  const localExtra = Buffer.alloc(20)
  localExtra.writeUInt16LE(0x0001, 0)
  localExtra.writeUInt16LE(16, 2)
  localExtra.writeBigUInt64LE(BigInt(contents.length), 4)
  localExtra.writeBigUInt64LE(BigInt(contents.length), 12)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(45, 4)
  central.writeUInt16LE(45, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(0xffffffff, 20)
  central.writeUInt32LE(0xffffffff, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(28, 30)
  central.writeUInt32LE(0xffffffff, 42)
  const centralExtra = Buffer.alloc(28)
  centralExtra.writeUInt16LE(0x0001, 0)
  centralExtra.writeUInt16LE(24, 2)
  centralExtra.writeBigUInt64LE(BigInt(contents.length), 4)
  centralExtra.writeBigUInt64LE(BigInt(contents.length), 12)
  centralExtra.writeBigUInt64LE(0n, 20)

  const directoryOffset =
    local.length + name.length + localExtra.length + contents.length
  const directorySize = central.length + name.length + centralExtra.length
  const zip64EndOffset = directoryOffset + directorySize
  const zip64End = Buffer.alloc(56)
  zip64End.writeUInt32LE(0x06064b50, 0)
  zip64End.writeBigUInt64LE(44n, 4)
  zip64End.writeUInt16LE(45, 12)
  zip64End.writeUInt16LE(45, 14)
  zip64End.writeBigUInt64LE(1n, 24)
  zip64End.writeBigUInt64LE(1n, 32)
  zip64End.writeBigUInt64LE(BigInt(directorySize), 40)
  zip64End.writeBigUInt64LE(BigInt(directoryOffset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8)
  locator.writeUInt32LE(1, 16)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)

  return Buffer.concat([
    local,
    name,
    localExtra,
    contents,
    central,
    name,
    centralExtra,
    zip64End,
    locator,
    end
  ])
}

async function run7z(args: string[]): Promise<{ code: number; output: string }> {
  const executable = await getSevenZipExecutable()
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { output += chunk })
    child.on('error', rejectPromise)
    child.on('close', (code) =>
      resolvePromise({ code: code ?? 2, output })
    )
  })
}

describe('7-Zip 技术列表', () => {
  it('解析条目属性并保留包含等号的文件名', () => {
    const listing = parseSevenZipTechnicalListing(`
Path = sample.zip
Type = zip
Physical Size = 123

----------
Path = 图=片.jpg
Folder = -
Size = 4
Packed Size = 4
Modified = 2026-07-29 00:00:00
CRC = 1234ABCD
Encrypted = -
`)
    expect(listing.header.Type).toBe('zip')
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]).toMatchObject({
      path: '图=片.jpg',
      normalizedPath: '图=片.jpg',
      size: 4,
      crc: '1234ABCD',
      isEncrypted: false
    })
  })

  it.each([
    ['', '缺失'],
    ['CRC = NOT-A-CRC', '非法']
  ])('拒绝普通文件 CRC %s 的技术列表', (crcLine) => {
    expect(() =>
      parseSevenZipTechnicalListing(`
Path = sample.zip
Type = zip
Physical Size = 123

----------
Path = image.jpg
Folder = -
Size = 4
Packed Size = 4
${crcLine}
Encrypted = -
`)
    ).toThrowError(
      expect.objectContaining({
        code: 'ARCHIVE_INDEX_CORRUPT',
        entryPath: 'image.jpg'
      })
    )
  })

  it('纯清单校验拒绝跳转、链接、加密、嵌套和冲突', () => {
    const baseEntry = {
      size: 1,
      isDirectory: false,
      isEncrypted: false,
      isSymlink: false,
      isHardlink: false,
      properties: {}
    }
    expect(() =>
      validateArchiveManifest({
        archivePath: 'sample.zip',
        header: { Type: 'zip' },
        entries: [
          {
            ...baseEntry,
            path: 'inner.zip',
            normalizedPath: 'inner.zip'
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_NESTED' }))
    expect(() =>
      validateArchiveManifest({
        archivePath: 'sample.zip',
        header: { Type: 'zip' },
        entries: [
          {
            ...baseEntry,
            path: 'a.jpg',
            normalizedPath: 'a.jpg'
          },
          {
            ...baseEntry,
            path: 'A.JPG',
            normalizedPath: 'A.JPG'
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: 'OUTPUT_COLLISION' }))
    expect(() =>
      validateArchiveManifest({
        archivePath: 'sample.zip',
        header: { Type: 'zip' },
        entries: [
          {
            ...baseEntry,
            path: 'ß',
            normalizedPath: 'ß'
          },
          {
            ...baseEntry,
            path: 'ss/child.jpg',
            normalizedPath: 'ss/child.jpg'
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: 'OUTPUT_COLLISION' }))
    expect(() =>
      validateArchiveManifest({
        archivePath: 'sample.zip',
        header: { Type: 'zip' },
        entries: [
          {
            ...baseEntry,
            path: 'link.jpg',
            normalizedPath: 'link.jpg',
            isSymlink: true
          }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: 'ARCHIVE_PATH_UNSAFE' }))
  })
})

describe('ZIP 安全检查与解压', () => {
  it('检查并解压普通 Unicode ZIP，随后安全清理临时目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-archive-'))
    const source = join(root, 'source')
    const tempRoot = join(root, 'temp')
    const archivePath = join(root, '日常批次.zip')
    await mkdir(source)
    await writeFile(join(source, '人物图.jpg'), Buffer.from('image-bytes'))
    const created = await run7z([
      'a',
      '-tzip',
      archivePath,
      join(source, '人物图.jpg'),
      '-y'
    ])
    expect(created.code, created.output).toBe(0)

    const inspection = await inspectArchive(archivePath)
    expect(inspection.format).toBe('zip')
    expect(inspection.entries).toHaveLength(1)
    const extraction = await extractArchive(inspection, tempRoot)
    expect(extraction.failures).toEqual([])
    expect(await readFile(extraction.files[0]!.extractedPath, 'utf8')).toBe(
      'image-bytes'
    )

    await cleanupArchiveTemp(extraction.tempDirectory, tempRoot)
    await expect(stat(extraction.tempDirectory)).rejects.toThrow()
  })

  it('实际检查并解压 ZIP64 中央目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-zip64-'))
    const archivePath = join(root, 'zip64.zip')
    const tempRoot = join(root, 'temp')
    await writeFile(
      archivePath,
      storedZip64('ZIP64-小样.txt', Buffer.from('zip64-data'))
    )

    const inspection = await inspectArchive(archivePath)
    expect(inspection.format).toBe('zip')
    expect(inspection.entries[0]).toMatchObject({
      path: 'ZIP64-小样.txt',
      size: 10
    })
    const extraction = await extractArchive(inspection, tempRoot)
    expect(extraction.failures).toEqual([])
    expect(
      await readFile(extraction.files[0]!.extractedPath, 'utf8')
    ).toBe('zip64-data')
    await cleanupArchiveTemp(extraction.tempDirectory, tempRoot)
  })

  it('在解压前拒绝压缩包路径穿越', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-traversal-'))
    const archivePath = join(root, 'unsafe.zip')
    await writeFile(
      archivePath,
      storedZip('../escape.jpg', Buffer.from('bad'))
    )
    await expect(inspectArchive(archivePath)).rejects.toMatchObject({
      code: 'ARCHIVE_PATH_UNSAFE'
    })
  })

  it('把单条 CRC 错误记录为条目失败，不把其他条目伪报成功', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-crc-'))
    const tempRoot = join(root, 'temp')
    const archivePath = join(root, 'crc.zip')
    await writeFile(
      archivePath,
      storedZip('broken.jpg', Buffer.from('broken-data'), { crc: 0x12345678 })
    )

    const inspection = await inspectArchive(archivePath)
    const extraction = await extractArchive(inspection, tempRoot)
    expect(extraction.files).toEqual([])
    expect(extraction.failures).toEqual([
      expect.objectContaining({
        entryPath: 'broken.jpg',
        errorCode: 'ARCHIVE_CRC_FAILED'
      })
    ])
    await cleanupArchiveTemp(extraction.tempDirectory, tempRoot)
  })

  it('拒绝加密、损坏索引和带前置程序的 SFX ZIP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labeler-invalid-archive-'))
    const encrypted = join(root, 'encrypted.zip')
    const corrupt = join(root, 'corrupt.zip')
    const sfx = join(root, 'sfx.zip')
    await writeFile(
      encrypted,
      storedZip('secret.jpg', Buffer.from('x'), { flags: 1 })
    )
    await writeFile(corrupt, Buffer.from('not-an-archive'))
    await writeFile(
      sfx,
      storedZip('a.jpg', Buffer.from('x'), { prefix: Buffer.from('MZstub') })
    )

    await expect(inspectArchive(encrypted)).rejects.toMatchObject({
      code: 'ARCHIVE_ENCRYPTED'
    })
    await expect(inspectArchive(corrupt)).rejects.toMatchObject({
      code: 'ARCHIVE_INDEX_CORRUPT'
    })
    await expect(inspectArchive(sfx)).rejects.toMatchObject({
      code: 'ARCHIVE_SFX'
    })
  })

  it.skipIf(process.platform === 'win32')(
    '拒绝 ZIP 中真实的符号链接条目',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'labeler-archive-link-'))
      const source = join(root, 'source.jpg')
      const link = join(root, 'link.jpg')
      const archivePath = join(root, 'link.zip')
      await writeFile(source, Buffer.from('source'))
      await symlink(source, link)
      const created = await run7z([
        'a',
        '-tzip',
        '-snl',
        archivePath,
        link,
        '-y'
      ])
      expect(created.code, created.output).toBe(0)
      await expect(inspectArchive(archivePath)).rejects.toMatchObject({
        code: 'ARCHIVE_PATH_UNSAFE'
      })
    }
  )

  it('当前完整引擎声明 RAR4/RAR5 解码能力', async () => {
    const result = await run7z(['i'])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toMatch(/\bRar\b/)
    expect(result.output).toMatch(/\bRar5\b/)
  })

  it.each([
    ['rar4', RAR4_SAMPLE_BASE64, 'rar4'],
    ['rar5', RAR5_SAMPLE_BASE64, 'rar5']
  ] as const)(
    '实际检查、解压并校验固定 %s 回归包',
    async (label, encoded, expectedFormat) => {
      const root = await mkdtemp(join(tmpdir(), `labeler-${label}-`))
      const archivePath = join(root, `${label}.rar`)
      const tempRoot = join(root, 'temp')
      await writeFile(archivePath, Buffer.from(encoded, 'base64'))

      const inspection = await inspectArchive(archivePath)
      expect(inspection.format).toBe(expectedFormat)
      expect(inspection.entries).toHaveLength(1)
      expect(inspection.entries[0]?.path).toBe('小样.txt')
      const extraction = await extractArchive(inspection, tempRoot)
      expect(extraction.failures).toEqual([])
      expect(
        await readFile(extraction.files[0]!.extractedPath, 'utf8')
      ).toContain('Host Database')
      await cleanupArchiveTemp(extraction.tempDirectory, tempRoot)
    }
  )
})
