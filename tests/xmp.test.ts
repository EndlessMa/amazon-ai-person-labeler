import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/main/core/errors'
import {
  analyzeSubjectValues,
  inspectEmbeddedXmp,
  parseSubjectValuesFromXmp
} from '../src/main/core/xmp'
import { TARGET_SUBJECT } from '../src/shared/contracts'

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

function xmp(values: readonly string[], prefix = 'dc'): string {
  const escaped = values.map((value) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  )
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<r:Description xmlns:${prefix}="http://purl.org/dc/elements/1.1/">`,
    `<${prefix}:subject><r:Bag>`,
    ...escaped.map((value) => `<r:li>${value}</r:li>`),
    `</r:Bag></${prefix}:subject>`,
    '</r:Description></r:RDF></x:xmpmeta>'
  ].join('')
}

function pngWithXmp(xml: string, compressed = false): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const keyword = Buffer.from('XML:com.adobe.xmp\u0000')
  const text = Buffer.from(xml)
  const itxt = Buffer.concat([
    keyword,
    Buffer.from([compressed ? 1 : 0, 0, 0, 0]),
    compressed ? deflateSync(text) : text
  ])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('iTXt', itxt),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const output = Buffer.alloc(4 + data.length)
  output[0] = 0xff
  output[1] = marker
  output.writeUInt16BE(data.length + 2, 2)
  data.copy(output, 4)
  return output
}

function jpegWithSegments(segments: readonly Buffer[]): Buffer {
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments,
    Buffer.from([
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01,
      0x11, 0x00
    ]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    scan,
    Buffer.from([0xff, 0xd9])
  ])
}

function jpegXmpPayload(xml: string): Buffer {
  return Buffer.concat([
    Buffer.from('http://ns.adobe.com/xap/1.0/\u0000', 'ascii'),
    Buffer.from(xml, 'utf8')
  ])
}

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('XMP dc:subject parsing', () => {
  it('resolves namespaces rather than depending on literal prefixes', () => {
    expect(
      parseSubjectValuesFromXmp(xmp([TARGET_SUBJECT, '其他值'], 'custom'))
    ).toEqual([TARGET_SUBJECT, '其他值'])
  })

  it('does not count an unrelated namespace that happens to use subject/Bag/li', () => {
    const xml = [
      '<root xmlns:e="urn:evil" xmlns:r="urn:not-rdf">',
      '<e:subject><r:Bag><r:li>',
      TARGET_SUBJECT,
      '</r:li></r:Bag></e:subject></root>'
    ].join('')
    expect(parseSubjectValuesFromXmp(xml)).toEqual([])
  })

  it('preserves whitespace and case while identifying similar values', () => {
    const values = [
      TARGET_SUBJECT,
      ` ${TARGET_SUBJECT} `,
      TARGET_SUBJECT.toUpperCase(),
      'contains-synthetic-performe'
    ]
    const analysis = analyzeSubjectValues(values)
    expect(analysis.exactCount).toBe(1)
    expect(analysis.state).toBe('compliant')
    expect(analysis.similarValues).toEqual(values.slice(1))
  })

  it('classifies duplicate exact values as requiring normalization', () => {
    expect(analyzeSubjectValues([TARGET_SUBJECT, TARGET_SUBJECT])).toMatchObject({
      state: 'duplicate',
      exactCount: 2
    })
  })

  it('reads compressed PNG iTXt XMP', () => {
    const analysis = inspectEmbeddedXmp(
      pngWithXmp(xmp([TARGET_SUBJECT]), true),
      'png'
    )
    expect(analysis).toMatchObject({
      state: 'compliant',
      exactCount: 1,
      values: [TARGET_SUBJECT]
    })
  })

  it('combines values from every embedded PNG XMP packet', () => {
    const first = pngWithXmp(xmp([TARGET_SUBJECT]))
    const secondData = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp\u0000'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from(xmp([TARGET_SUBJECT]))
    ])
    const iendOffset = first.lastIndexOf(Buffer.from('IEND')) - 4
    const combined = Buffer.concat([
      first.subarray(0, iendOffset),
      chunk('iTXt', secondData),
      first.subarray(iendOffset)
    ])
    expect(inspectEmbeddedXmp(combined, 'png')).toMatchObject({
      state: 'duplicate',
      exactCount: 2
    })
  })

  it('reads XMP only from a real top-level JPEG APP1 segment', () => {
    const image = jpegWithSegments([
      jpegSegment(0xe1, jpegXmpPayload(xmp([TARGET_SUBJECT])))
    ])
    expect(inspectEmbeddedXmp(image, 'jpeg')).toMatchObject({
      state: 'compliant',
      exactCount: 1,
      values: [TARGET_SUBJECT]
    })
  })

  it('ignores marker-like fake APP1 bytes nested inside another JPEG segment', () => {
    const fakeApp1Bytes = jpegSegment(
      0xe1,
      jpegXmpPayload(xmp([TARGET_SUBJECT]))
    )
    const image = jpegWithSegments([
      jpegSegment(
        0xe2,
        Buffer.concat([
          Buffer.from('ordinary APP2 payload\u0000'),
          fakeApp1Bytes,
          Buffer.from('\u0000tail')
        ])
      )
    ])
    expect(inspectEmbeddedXmp(image, 'jpeg')).toMatchObject({
      state: 'untagged',
      exactCount: 0,
      values: []
    })
  })

  it('fails safe on malformed XML instead of treating it as untagged', () => {
    expect(
      captureError(() =>
        inspectEmbeddedXmp(
          pngWithXmp('<rdf:RDF><dc:subject></rdf:RDF>'),
          'png'
        )
      )
    ).toMatchObject({
      code: 'MALFORMED_METADATA'
    } satisfies Partial<AppError>)
  })

  it('rejects DTD/entity declarations', () => {
    expect(
      captureError(() =>
        parseSubjectValuesFromXmp(
          '<!DOCTYPE x [<!ENTITY a "x">]><x>&a;</x>'
        )
      )
    ).toMatchObject({
      code: 'MALFORMED_METADATA'
    } satisfies Partial<AppError>)
  })
})
