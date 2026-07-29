import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ImageFormat } from '../../shared/contracts'
import { LIMITS } from '../../shared/contracts'
import { AppError } from './errors'

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf
])

const JPEG_STANDALONE_MARKERS = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9
])

const JPEG_DECODING_PARAMETER_MARKERS = new Set([
  0xc4, // DHT
  0xcc, // DAC
  0xdb, // DQT
  0xdc, // DNL
  0xdd, // DRI
  0xde, // DHP
  0xdf // EXP
])

export interface ImageStructure {
  format: ImageFormat
  width: number
  height: number
  pixels: number
  payloadSha256: string
}

export interface PngChunk {
  type: string
  data: Buffer
  offset: number
}

export interface JpegSegment {
  marker: number
  markerOffset: number
  data: Buffer
  scanData?: Buffer
}

interface ParsedPng {
  width: number
  height: number
  payloadSha256: string
  chunks: PngChunk[]
}

interface ParsedJpeg {
  width: number
  height: number
  payloadSha256: string
  segments: JpegSegment[]
}

let crcTable: Uint32Array | undefined

function getCrcTable(): Uint32Array {
  if (crcTable !== undefined) return crcTable

  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1
    }
    table[index] = value >>> 0
  }
  crcTable = table
  return table
}

function crc32(parts: readonly Buffer[]): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const part of parts) {
    for (const byte of part) {
      const lookup = (crc ^ byte) & 0xff
      crc = (table[lookup] ?? 0) ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function updateFramedHash(
  hash: ReturnType<typeof createHash>,
  kind: string,
  data: Buffer
): void {
  const kindBytes = Buffer.from(kind, 'ascii')
  const header = Buffer.alloc(6)
  header.writeUInt16BE(kindBytes.length, 0)
  header.writeUInt32BE(data.length, 2)
  hash.update(header)
  hash.update(kindBytes)
  hash.update(data)
}

function malformed(message: string, details?: Record<string, unknown>): never {
  throw new AppError('UNSUPPORTED_FORMAT', message, details)
}

function assertPixelLimit(width: number, height: number): number {
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels > LIMITS.maxPixels) {
    throw new AppError(
      'PIXEL_LIMIT_EXCEEDED',
      `图片像素数超过 ${LIMITS.maxPixels.toLocaleString('en-US')} 上限`,
      { width, height, pixels }
    )
  }
  return pixels
}

function extensionFormat(filePath: string): ImageFormat | undefined {
  switch (extname(filePath).toLocaleLowerCase('en-US')) {
    case '.jpg':
    case '.jpeg':
      return 'jpeg'
    case '.png':
      return 'png'
    default:
      return undefined
  }
}

export function detectImageSignature(buffer: Buffer): ImageFormat | undefined {
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return 'png'
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'jpeg'
  }
  return undefined
}

function assertExtensionMatches(
  filePath: string,
  actualFormat: ImageFormat | undefined
): asserts actualFormat is ImageFormat {
  const expectedFormat = extensionFormat(filePath)
  if (expectedFormat === undefined) {
    if (actualFormat !== undefined) {
      throw new AppError(
        'EXTENSION_MISMATCH',
        `文件内容是 ${actualFormat.toUpperCase()}，但扩展名不是受支持的 JPG/JPEG/PNG`,
        { filePath, actualFormat }
      )
    }
    throw new AppError('UNSUPPORTED_FORMAT', '仅支持 JPG、JPEG 和静态 PNG', {
      filePath
    })
  }
  if (actualFormat === undefined) {
    malformed('文件扩展名受支持，但内容不是有效的 JPEG 或 PNG', {
      filePath,
      expectedFormat
    })
  }
  if (actualFormat !== expectedFormat) {
    throw new AppError('EXTENSION_MISMATCH', '文件扩展名与实际图片结构不匹配', {
      filePath,
      expectedFormat,
      actualFormat
    })
  }
}

function legalPngBitDepth(bitDepth: number, colorType: number): boolean {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth)
    case 2:
    case 4:
    case 6:
      return [8, 16].includes(bitDepth)
    case 3:
      return [1, 2, 4, 8].includes(bitDepth)
    default:
      return false
  }
}

/**
 * Parses and CRC-validates the complete PNG container. The returned chunk data
 * are zero-copy slices of `buffer`; callers must not mutate either value.
 */
export function parsePngChunks(buffer: Buffer): PngChunk[] {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    malformed('PNG 签名无效')
  }

  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  let sawIend = false

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      malformed('PNG 块头被截断', { offset })
    }

    const length = buffer.readUInt32BE(offset)
    const typeBuffer = buffer.subarray(offset + 4, offset + 8)
    const type = typeBuffer.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) {
      malformed('PNG 块类型无效', { offset, type })
    }

    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (
      dataEnd < dataStart ||
      chunkEnd < dataEnd ||
      chunkEnd > buffer.length
    ) {
      malformed('PNG 块长度越界', { offset, type, length })
    }

    const data = buffer.subarray(dataStart, dataEnd)
    const expectedCrc = buffer.readUInt32BE(dataEnd)
    const actualCrc = crc32([typeBuffer, data])
    if (expectedCrc !== actualCrc) {
      malformed('PNG 块 CRC 校验失败', {
        offset,
        type,
        expectedCrc,
        actualCrc
      })
    }

    chunks.push({ type, data, offset })
    offset = chunkEnd

    if (type === 'IEND') {
      sawIend = true
      if (length !== 0) malformed('PNG IEND 块长度必须为 0')
      if (offset !== buffer.length) {
        malformed('PNG IEND 块后存在非标准尾随数据')
      }
      break
    }
  }

  if (!sawIend) malformed('PNG 缺少 IEND 块')
  return chunks
}

function parsePng(buffer: Buffer): ParsedPng {
  const chunks = parsePngChunks(buffer)
  const first = chunks[0]
  if (first?.type !== 'IHDR' || first.data.length !== 13) {
    malformed('PNG 首块必须是长度为 13 的 IHDR')
  }

  const width = first.data.readUInt32BE(0)
  const height = first.data.readUInt32BE(4)
  const bitDepth = first.data[8] ?? -1
  const colorType = first.data[9] ?? -1
  const compression = first.data[10] ?? -1
  const filter = first.data[11] ?? -1
  const interlace = first.data[12] ?? -1

  if (width === 0 || height === 0) malformed('PNG 图片尺寸不能为 0')
  if (!legalPngBitDepth(bitDepth, colorType)) {
    malformed('PNG 位深与颜色类型组合无效', { bitDepth, colorType })
  }
  if (compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
    malformed('PNG IHDR 使用了不支持或无效的方法', {
      compression,
      filter,
      interlace
    })
  }

  const payloadHash = createHash('sha256')
  payloadHash.update('AI-LABELER-PNG-PIXEL-PAYLOAD-V2\u0000', 'ascii')
  let sawIdat = false
  let idatSequenceEnded = false
  for (const chunk of chunks) {
    if (['acTL', 'fcTL', 'fdAT'].includes(chunk.type)) {
      throw new AppError('ANIMATED_PNG', '不支持 APNG 动画图片')
    }
    if (chunk !== first && chunk.type === 'IHDR') {
      malformed('PNG 包含重复 IHDR 块')
    }
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT'].includes(chunk.type)) {
      updateFramedHash(payloadHash, chunk.type, chunk.data)
    }
    if (chunk.type === 'IDAT') {
      if (idatSequenceEnded) malformed('PNG IDAT 块必须连续')
      sawIdat = true
    } else if (sawIdat) {
      idatSequenceEnded = true
    }
  }

  if (!sawIdat) malformed('PNG 缺少 IDAT 图像数据')

  return {
    width,
    height,
    payloadSha256: payloadHash.digest('hex'),
    chunks
  }
}

function readJpegMarker(buffer: Buffer, offset: number): {
  marker: number
  markerOffset: number
  afterMarker: number
} {
  if (buffer[offset] !== 0xff) {
    malformed('JPEG 标记前缀无效', { offset })
  }
  const markerOffset = offset
  let cursor = offset
  while (buffer[cursor] === 0xff) cursor += 1
  if (cursor >= buffer.length) malformed('JPEG 标记被截断', { offset })

  const marker = buffer[cursor]
  if (marker === undefined || marker === 0x00 || marker === 0xff) {
    malformed('JPEG 标记无效', { offset, marker })
  }
  return { marker, markerOffset, afterMarker: cursor + 1 }
}

function parseJpeg(buffer: Buffer): ParsedJpeg {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    malformed('JPEG SOI 签名无效')
  }

  const payloadHash = createHash('sha256')
  payloadHash.update('AI-LABELER-JPEG-PIXEL-PAYLOAD-V2\u0000', 'ascii')
  const segments: JpegSegment[] = []
  let offset = 2
  let width: number | undefined
  let height: number | undefined
  let sawScan = false
  let sawEoi = false

  while (offset < buffer.length) {
    const { marker, markerOffset, afterMarker } = readJpegMarker(buffer, offset)
    offset = afterMarker

    if (marker === 0xd9) {
      sawEoi = true
      break
    }
    if (marker === 0xd8) malformed('JPEG 包含重复 SOI 标记')
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      segments.push({
        marker,
        markerOffset,
        data: Buffer.alloc(0)
      })
      continue
    }

    if (offset + 2 > buffer.length) {
      malformed('JPEG 段长度被截断', { marker, markerOffset })
    }
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2) {
      malformed('JPEG 段长度无效', { marker, markerOffset, segmentLength })
    }
    const segmentDataStart = offset + 2
    const segmentEnd = offset + segmentLength
    if (segmentEnd > buffer.length) {
      malformed('JPEG 段越过文件末尾', {
        marker,
        markerOffset,
        segmentLength
      })
    }
    const segmentData = buffer.subarray(segmentDataStart, segmentEnd)

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) malformed('JPEG SOF 段过短')
      const nextHeight = buffer.readUInt16BE(segmentDataStart + 1)
      const nextWidth = buffer.readUInt16BE(segmentDataStart + 3)
      if (nextWidth === 0 || nextHeight === 0) {
        malformed('JPEG 图片尺寸不能为 0')
      }
      if (
        (width !== undefined && width !== nextWidth) ||
        (height !== undefined && height !== nextHeight)
      ) {
        malformed('JPEG 包含相互矛盾的 SOF 尺寸')
      }
      width = nextWidth
      height = nextHeight
    }

    if (marker !== 0xda) {
      segments.push({
        marker,
        markerOffset,
        data: segmentData
      })
      if (
        JPEG_SOF_MARKERS.has(marker) ||
        JPEG_DECODING_PARAMETER_MARKERS.has(marker)
      ) {
        updateFramedHash(
          payloadHash,
          `JPEG-${marker.toString(16).padStart(2, '0').toUpperCase()}`,
          segmentData
        )
      }
      offset = segmentEnd
      continue
    }

    sawScan = true
    const scanDataStart = segmentEnd
    let cursor = scanDataStart
    let boundary = -1
    while (cursor < buffer.length - 1) {
      if (buffer[cursor] !== 0xff) {
        cursor += 1
        continue
      }

      let codeOffset = cursor + 1
      while (buffer[codeOffset] === 0xff) codeOffset += 1
      if (codeOffset >= buffer.length) break
      const code = buffer[codeOffset]
      if (code === 0x00 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) {
        cursor = codeOffset + 1
        continue
      }
      boundary = cursor
      break
    }

    if (boundary < 0) malformed('JPEG 扫描数据没有结束标记')
    const scanData = buffer.subarray(scanDataStart, boundary)
    segments.push({
      marker,
      markerOffset,
      data: segmentData,
      scanData
    })
    updateFramedHash(payloadHash, 'JPEG-SOS-HEADER', segmentData)
    updateFramedHash(payloadHash, 'JPEG-SOS-ENTROPY', scanData)
    offset = boundary
  }

  if (!sawEoi) malformed('JPEG 缺少 EOI 结束标记')
  if (!sawScan) malformed('JPEG 缺少 SOS 扫描数据')
  if (width === undefined || height === undefined) {
    malformed('JPEG 缺少可识别的 SOF 尺寸')
  }

  return {
    width,
    height,
    payloadSha256: payloadHash.digest('hex'),
    segments
  }
}

/**
 * Returns only structurally parsed JPEG segments. In particular, marker-like
 * bytes inside APP payloads or entropy-coded scan data are never surfaced as
 * top-level segments.
 */
export function parseJpegSegments(buffer: Buffer): JpegSegment[] {
  return parseJpeg(buffer).segments
}

export function parseImageBuffer(
  buffer: Buffer,
  filePath: string
): ImageStructure {
  const actualFormat = detectImageSignature(buffer)
  assertExtensionMatches(filePath, actualFormat)

  const parsed = actualFormat === 'jpeg' ? parseJpeg(buffer) : parsePng(buffer)
  return {
    format: actualFormat,
    width: parsed.width,
    height: parsed.height,
    pixels: assertPixelLimit(parsed.width, parsed.height),
    payloadSha256: parsed.payloadSha256
  }
}

export async function inspectImageStructure(
  filePath: string
): Promise<ImageStructure & { bytes: number }> {
  const fileStat = await stat(filePath).catch((error: unknown) => {
    throw new AppError('SOURCE_READ_FAILED', `无法读取图片：${filePath}`, {
      cause: error instanceof Error ? error.message : String(error)
    })
  })
  if (!fileStat.isFile()) {
    throw new AppError('SOURCE_READ_FAILED', '所选路径不是普通文件', {
      filePath
    })
  }
  if (fileStat.size > LIMITS.maxImageBytes) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `单张图片超过 ${LIMITS.maxImageBytes} 字节上限`,
      { filePath, bytes: fileStat.size }
    )
  }

  const buffer = await readFile(filePath).catch((error: unknown) => {
    throw new AppError('SOURCE_READ_FAILED', `无法读取图片：${filePath}`, {
      cause: error instanceof Error ? error.message : String(error)
    })
  })
  return { ...parseImageBuffer(buffer, filePath), bytes: buffer.length }
}

export async function imagePayloadSha256(filePath: string): Promise<string> {
  return (await inspectImageStructure(filePath)).payloadSha256
}
