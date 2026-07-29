import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/main/core/errors'
import {
  detectImageSignature,
  parseImageBuffer
} from '../src/main/core/image-format'

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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return output
}

function png(
  width = 2,
  height = 1,
  extras: readonly Buffer[] = []
): { buffer: Buffer; idat: Buffer } {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  // Container-level tests intentionally don't inflate IDAT. Keep the test
  // payload tiny even when exercising a very large declared IHDR boundary.
  const rows =
    width * height <= 1_000_000
      ? Buffer.alloc(height * (1 + width * 3))
      : Buffer.from([0, 0, 0, 0])
  const idat = deflateSync(rows)
  return {
    buffer: Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      ...extras,
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0))
    ]),
    idat
  }
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const output = Buffer.alloc(4 + data.length)
  output[0] = 0xff
  output[1] = marker
  output.writeUInt16BE(data.length + 2, 2)
  data.copy(output, 4)
  return output
}

function structuralJpeg(
  extras: readonly Buffer[] = []
): { buffer: Buffer; scan: Buffer } {
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
  return {
    scan,
    buffer: Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...extras,
      Buffer.from([
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01,
        0x11, 0x00
      ]),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      scan,
      Buffer.from([0xff, 0xd9])
    ])
  }
}

function expectCode(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code
}

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('parseImageBuffer', () => {
  it('parses a CRC-valid static PNG and creates a framed pixel-payload digest', () => {
    const image = png(2, 1)
    const parsed = parseImageBuffer(image.buffer, '商品图.PNG')
    expect(parsed).toMatchObject({
      format: 'png',
      width: 2,
      height: 1,
      pixels: 2
    })
    expect(parsed.payloadSha256).toMatch(/^[0-9a-f]{64}$/)
    const metadataOnlyVariant = png(2, 1, [
      pngChunk('tEXt', Buffer.from('Comment\u0000metadata only'))
    ])
    expect(
      parseImageBuffer(metadataOnlyVariant.buffer, '商品图.png').payloadSha256
    ).toBe(parsed.payloadSha256)
  })

  it('parses JPEG dimensions and creates a framed decoding-payload digest', () => {
    const image = structuralJpeg()
    const parsed = parseImageBuffer(image.buffer, '商品图.JpEg')
    expect(parsed).toMatchObject({
      format: 'jpeg',
      width: 3,
      height: 2,
      pixels: 6
    })
    expect(parsed.payloadSha256).toMatch(/^[0-9a-f]{64}$/)
    const metadataOnlyVariant = structuralJpeg([
      jpegSegment(0xe2, Buffer.from('metadata only'))
    ])
    expect(
      parseImageBuffer(metadataOnlyVariant.buffer, '商品图.jpg').payloadSha256
    ).toBe(parsed.payloadSha256)
  })

  it('changes the PNG payload digest when PLTE changes but IDAT does not', () => {
    const first = png(2, 1, [
      pngChunk('PLTE', Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]))
    ])
    const second = png(2, 1, [
      pngChunk('PLTE', Buffer.from([0x00, 0x00, 0x00, 0xff, 0x00, 0xff]))
    ])
    expect(second.idat).toEqual(first.idat)
    expect(parseImageBuffer(second.buffer, 'palette.png').payloadSha256).not.toBe(
      parseImageBuffer(first.buffer, 'palette.png').payloadSha256
    )
  })

  it('changes the JPEG payload digest when a DQT table changes', () => {
    const firstTable = Buffer.alloc(65, 1)
    const secondTable = Buffer.from(firstTable)
    firstTable[0] = 0
    secondTable[0] = 0
    secondTable[32] = 2
    const first = structuralJpeg([jpegSegment(0xdb, firstTable)])
    const second = structuralJpeg([jpegSegment(0xdb, secondTable)])
    expect(second.scan).toEqual(first.scan)
    expect(parseImageBuffer(second.buffer, 'quantized.jpg').payloadSha256).not.toBe(
      parseImageBuffer(first.buffer, 'quantized.jpg').payloadSha256
    )
  })

  it('rejects APNG chunks even when the file has a PNG extension', () => {
    const animationControl = Buffer.alloc(8)
    animationControl.writeUInt32BE(2, 0)
    animationControl.writeUInt32BE(0, 4)
    const image = png(1, 1, [pngChunk('acTL', animationControl)])
    expect(
      expectCode(
        captureError(() => parseImageBuffer(image.buffer, 'animation.png')),
        'ANIMATED_PNG'
      )
    ).toBe(true)
  })

  it('rejects a supported extension whose actual structure differs', () => {
    const image = png()
    expect(
      expectCode(
        captureError(() => parseImageBuffer(image.buffer, 'wrong.jpg')),
        'EXTENSION_MISMATCH'
      )
    ).toBe(true)
  })

  it('rejects supported image bytes hidden behind an unsupported extension', () => {
    const image = png()
    expect(
      expectCode(
        captureError(() => parseImageBuffer(image.buffer, 'hidden.dat')),
        'EXTENSION_MISMATCH'
      )
    ).toBe(true)
  })

  it('rejects a PNG whose declared pixel count exceeds the 100M boundary', () => {
    const image = png(10_001, 10_000)
    expect(
      expectCode(
        captureError(() => parseImageBuffer(image.buffer, 'huge.png')),
        'PIXEL_LIMIT_EXCEEDED'
      )
    ).toBe(true)
  })

  it('accepts exactly 100M declared pixels', () => {
    expect(parseImageBuffer(png(10_000, 10_000).buffer, 'limit.png')).toMatchObject(
      {
        pixels: 100_000_000
      }
    )
  })

  it('rejects a PNG chunk with a bad CRC', () => {
    const image = png()
    const lastIndex = image.buffer.length - 1
    image.buffer[lastIndex] = (image.buffer[lastIndex] ?? 0) ^ 0xff
    expect(
      expectCode(
        captureError(() => parseImageBuffer(image.buffer, 'corrupt.png')),
        'UNSUPPORTED_FORMAT'
      )
    ).toBe(true)
  })

  it('detects signatures without trusting extensions', () => {
    expect(detectImageSignature(png().buffer)).toBe('png')
    expect(detectImageSignature(structuralJpeg().buffer)).toBe('jpeg')
    expect(detectImageSignature(Buffer.from('not an image'))).toBeUndefined()
  })
})
