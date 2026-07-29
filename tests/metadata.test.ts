import { mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { AppError } from '../src/main/core/errors'
import {
  closeMetadataTools,
  inspectImage,
  mutateTargetSubject,
  sha256File,
  verifyMutatedImage
} from '../src/main/core/metadata'
import { TARGET_SUBJECT } from '../src/shared/contracts'

// 1×1 baseline JPEG with a valid EXIF Artist value. Kept inline so the
// regression test is cross-platform and does not depend on an image encoder.
const ONE_PIXEL_JPEG = Buffer.from(
  [
    '/9j/4QA6RXhpZgAATU0AKgAAAAgAAgE7AAIAAAAMAAAAJgITAAMAAAABAAEAAAAAAABQcmVzZXJ2ZSBt',
    'ZQD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA',
    'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol',
    'JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ',
    'mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8Q',
    'AHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx',
    'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RV',
    'VldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE',
    'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYI',
    'BgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJ',
    'CxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oA',
    'DAMBAAIRAxEAPwD91KKKK0Mz/9k='
  ].join(''),
  'base64'
)

function jpegWithEmptyExif(): Buffer {
  const originalApp1Length = ONE_PIXEL_JPEG.readUInt16BE(4)
  const originalApp1End = 4 + originalApp1Length
  const emptyExifPayload = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ])
  const app1 = Buffer.alloc(4 + emptyExifPayload.length)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(emptyExifPayload.length + 2, 2)
  emptyExifPayload.copy(app1, 4)

  return Buffer.concat([
    ONE_PIXEL_JPEG.subarray(0, 2),
    app1,
    ONE_PIXEL_JPEG.subarray(originalApp1End)
  ])
}

let crcTable: Uint32Array | undefined

function crc32(data: Buffer): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1
    }
    return value >>> 0
  })
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type)
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return output
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmp(values: readonly string[]): string {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">保留标题</rdf:li></rdf:Alt></dc:title>',
    '<dc:subject><rdf:Bag>',
    ...values.map((value) => `<rdf:li>${xmlEscape(value)}</rdf:li>`),
    '</rdf:Bag></dc:subject>',
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  ].join('')
}

function testPng(
  values?: readonly string[],
  malformedXmp?: string,
  extraChunks: readonly Buffer[] = []
): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const chunks = [chunk('IHDR', ihdr), ...extraChunks]
  const packet = malformedXmp ?? (values === undefined ? undefined : xmp(values))
  if (packet !== undefined) {
    chunks.push(
      chunk(
        'iTXt',
        Buffer.concat([
          Buffer.from('XML:com.adobe.xmp\u0000'),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from(packet)
        ])
      )
    )
  }
  chunks.push(
    chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 40, 50, 60]))),
    chunk('IEND', Buffer.alloc(0))
  )
  return Buffer.concat([signature, ...chunks])
}

async function tempImage(
  basename: string,
  values?: readonly string[],
  malformedXmp?: string
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-label-metadata-test-'))
  const filePath = join(directory, basename)
  await writeFile(filePath, testPng(values, malformedXmp))
  return filePath
}

afterAll(async () => {
  await closeMetadataTools()
})

describe.sequential('metadata mutation and verification', () => {
  it('inspects a static image and exposes a stable fingerprint', async () => {
    const file = await tempImage('检查.png', ['其他关键词'])
    const inspected = await inspectImage(file)
    expect(inspected).toMatchObject({
      format: 'png',
      width: 2,
      height: 1,
      bytes: (await readFile(file)).length,
      subject: {
        state: 'untagged',
        exactCount: 0,
        values: ['其他关键词']
      }
    })
    expect(inspected.fingerprint.sourceSha256).toBe(await sha256File(file))
  })

  it('adds exactly one target and independently verifies payload/metadata preservation', async () => {
    const file = await tempImage('添加.png', [
      '其他关键词',
      ` ${TARGET_SUBJECT} `
    ])
    const before = await inspectImage(file)
    const result = await mutateTargetSubject(file, 'add')
    expect(result).toMatchObject({
      action: 'add-standard',
      postVerified: true,
      payloadUnchanged: true,
      nonTargetMetadataEqual: true,
      subject: {
        state: 'compliant',
        exactCount: 1
      }
    })
    expect(result.subject.values).toEqual(
      expect.arrayContaining([
        '其他关键词',
        ` ${TARGET_SUBJECT} `,
        TARGET_SUBJECT
      ])
    )
    expect(result.payloadSha256).toBe(before.payloadSha256)
  })

  it('normalizes duplicate exact values to one without removing other values', async () => {
    const file = await tempImage('规范.png', [
      TARGET_SUBJECT,
      '保留',
      TARGET_SUBJECT
    ])
    const result = await mutateTargetSubject(file, 'add')
    expect(result).toMatchObject({
      action: 'normalize-duplicate',
      postVerified: true,
      subject: { state: 'compliant', exactCount: 1 }
    })
    expect(result.subject.values).toContain('保留')
  })

  it('writes a real JPEG while preserving scan data and existing APP metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-label-jpeg-test-'))
    const file = join(directory, '真实JPEG.jpg')
    await writeFile(file, ONE_PIXEL_JPEG)
    const before = await inspectImage(file)
    expect(before).toMatchObject({ format: 'jpeg', width: 1, height: 1 })

    const result = await mutateTargetSubject(file, 'add')
    expect(result).toMatchObject({
      action: 'add-standard',
      payloadUnchanged: true,
      nonTargetMetadataEqual: true,
      postVerified: true,
      subject: { exactCount: 1, state: 'compliant' }
    })
    expect(result.payloadSha256).toBe(before.payloadSha256)
  })

  it('accepts a valid JPEG that only lacks EXIF YCbCrPositioning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-label-ycbcr-test-'))
    const file = join(directory, '缺少YCbCrPositioning.jpg')
    await writeFile(file, jpegWithEmptyExif())

    const before = await inspectImage(file)
    expect(before).toMatchObject({ format: 'jpeg', width: 1, height: 1 })

    const result = await mutateTargetSubject(file, 'add')
    expect(result).toMatchObject({
      action: 'add-standard',
      payloadUnchanged: true,
      nonTargetMetadataEqual: true,
      postVerified: true,
      subject: { exactCount: 1, state: 'compliant' }
    })
    expect(result.payloadSha256).toBe(before.payloadSha256)
  })

  it('removes every exact target while preserving similar and unrelated values', async () => {
    const source = await tempImage('源.png', [
      TARGET_SUBJECT,
      '保留',
      ` ${TARGET_SUBJECT} `,
      TARGET_SUBJECT
    ])
    const output = await tempImage('输出.png', [
      TARGET_SUBJECT,
      '保留',
      ` ${TARGET_SUBJECT} `,
      TARGET_SUBJECT
    ])
    const result = await mutateTargetSubject(output, 'remove')
    expect(result).toMatchObject({
      action: 'remove-standard',
      postVerified: true,
      subject: { exactCount: 0, state: 'similar' }
    })
    expect(result.subject.values).toEqual(
      expect.arrayContaining(['保留', ` ${TARGET_SUBJECT} `])
    )

    const verification = await verifyMutatedImage(source, output, 'remove')
    expect(verification).toMatchObject({
      payloadUnchanged: true,
      nonTargetMetadataEqual: true,
      subjectExpectationMet: true,
      postVerified: true
    })
  })

  it('leaves an already compliant add-mode copy byte-for-byte unchanged', async () => {
    const file = await tempImage('已合规.png', [TARGET_SUBJECT])
    const beforeSha = await sha256File(file)
    const result = await mutateTargetSubject(file, 'add')
    expect(result.action).toBe('copy-unchanged')
    expect(await sha256File(file)).toBe(beforeSha)
  })

  it('fails safe on malformed XMP and does not alter the copy', async () => {
    const file = await tempImage(
      '畸形.png',
      undefined,
      '<rdf:RDF><dc:subject></rdf:RDF>'
    )
    const beforeSha = await sha256File(file)
    await expect(mutateTargetSubject(file, 'add')).rejects.toMatchObject({
      code: 'MALFORMED_METADATA'
    } satisfies Partial<AppError>)
    expect(await sha256File(file)).toBe(beforeSha)
  })

  it('fails safe when ExifTool validates malformed embedded EXIF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-label-bad-exif-test-'))
    const file = join(directory, '畸形EXIF.png')
    await writeFile(
      file,
      testPng(undefined, undefined, [chunk('eXIf', Buffer.from('not-a-tiff'))])
    )
    await expect(inspectImage(file)).rejects.toMatchObject({
      code: 'MALFORMED_METADATA'
    } satisfies Partial<AppError>)
  })

  it('rejects an over-500MB file from stat before reading its contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-label-size-test-'))
    const file = join(directory, '超限.png')
    await writeFile(file, Buffer.alloc(1))
    await truncate(file, 500 * 1024 ** 2 + 1)
    await expect(inspectImage(file)).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    } satisfies Partial<AppError>)
  })
})
