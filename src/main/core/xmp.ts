import { inflateSync } from 'node:zlib'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { ImageFormat, SubjectAnalysis } from '../../shared/contracts'
import { TARGET_SUBJECT } from '../../shared/contracts'
import { AppError } from './errors'
import { parseJpegSegments, parsePngChunks } from './image-format'

const JPEG_XMP_HEADER = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\u0000',
  'ascii'
)
const JPEG_EXTENDED_XMP_HEADER = Buffer.from(
  'http://ns.adobe.com/xmp/extension/\u0000',
  'ascii'
)
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp'
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/'
const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

export interface EmbeddedXmpPacket {
  source: 'jpeg-app1' | 'jpeg-extended-app1' | 'png-itxt'
  xml: string
}

type OrderedXmlNode = Record<string, unknown>
type NamespaceMap = ReadonlyMap<string, string>

function malformedXmp(
  message: string,
  details?: Record<string, unknown>
): never {
  throw new AppError('MALFORMED_METADATA', message, details)
}

function decodeUtf8(buffer: Buffer, context: string): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return decoded.replace(/^\uFEFF/u, '').replace(/\u0000+$/u, '')
  } catch (error) {
    malformedXmp(`${context} 不是有效的 UTF-8`, {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
}

function jpegApp1Payloads(buffer: Buffer, header: Buffer): Buffer[] {
  return parseJpegSegments(buffer)
    .filter(
      (segment) =>
        segment.marker === 0xe1 &&
        segment.data.length >= header.length &&
        segment.data.subarray(0, header.length).equals(header)
    )
    .map((segment) => segment.data.subarray(header.length))
}

function extractJpegPackets(buffer: Buffer): EmbeddedXmpPacket[] {
  const packets: EmbeddedXmpPacket[] = jpegApp1Payloads(
    buffer,
    JPEG_XMP_HEADER
  ).map((payload) => ({
    source: 'jpeg-app1',
    xml: decodeUtf8(payload, 'JPEG XMP 数据')
  }))

  const extendedGroups = new Map<
    string,
    { totalLength: number; chunks: Array<{ offset: number; data: Buffer }> }
  >()
  for (const payload of jpegApp1Payloads(buffer, JPEG_EXTENDED_XMP_HEADER)) {
    if (payload.length < 40) {
      malformedXmp('JPEG 扩展 XMP APP1 段过短')
    }
    const guid = payload.subarray(0, 32).toString('ascii')
    if (!/^[0-9A-Fa-f]{32}$/.test(guid)) {
      malformedXmp('JPEG 扩展 XMP GUID 无效', { guid })
    }
    const totalLength = payload.readUInt32BE(32)
    const offset = payload.readUInt32BE(36)
    const data = payload.subarray(40)
    if (
      totalLength === 0 ||
      totalLength > buffer.length ||
      offset > totalLength ||
      data.length > totalLength - offset
    ) {
      malformedXmp('JPEG 扩展 XMP 分块范围无效', {
        guid,
        totalLength,
        offset,
        chunkLength: data.length
      })
    }

    const existing = extendedGroups.get(guid)
    if (existing !== undefined && existing.totalLength !== totalLength) {
      malformedXmp('JPEG 扩展 XMP 分块总长度不一致', { guid })
    }
    const group = existing ?? { totalLength, chunks: [] }
    group.chunks.push({ offset, data })
    extendedGroups.set(guid, group)
  }

  for (const [guid, group] of extendedGroups) {
    const ordered = [...group.chunks].sort((left, right) => left.offset - right.offset)
    const output = Buffer.alloc(group.totalLength)
    let expectedOffset = 0
    for (const chunk of ordered) {
      if (chunk.offset !== expectedOffset) {
        malformedXmp('JPEG 扩展 XMP 分块缺失、重叠或重复', {
          guid,
          expectedOffset,
          actualOffset: chunk.offset
        })
      }
      chunk.data.copy(output, chunk.offset)
      expectedOffset += chunk.data.length
    }
    if (expectedOffset !== group.totalLength) {
      malformedXmp('JPEG 扩展 XMP 数据不完整', {
        guid,
        expectedLength: group.totalLength,
        actualLength: expectedOffset
      })
    }
    packets.push({
      source: 'jpeg-extended-app1',
      xml: decodeUtf8(output, 'JPEG 扩展 XMP 数据')
    })
  }

  return packets
}

function readNullTerminated(
  data: Buffer,
  start: number,
  fieldName: string
): { value: Buffer; next: number } {
  const end = data.indexOf(0, start)
  if (end < 0) malformedXmp(`PNG XMP iTXt 缺少 ${fieldName} 结束符`)
  return { value: data.subarray(start, end), next: end + 1 }
}

function extractPngPackets(buffer: Buffer): EmbeddedXmpPacket[] {
  const packets: EmbeddedXmpPacket[] = []
  for (const chunk of parsePngChunks(buffer)) {
    if (chunk.type !== 'iTXt') continue

    const keywordPart = readNullTerminated(chunk.data, 0, '关键字')
    const keyword = keywordPart.value.toString('latin1')
    if (keyword !== PNG_XMP_KEYWORD) continue

    const compressionFlag = chunk.data[keywordPart.next]
    const compressionMethod = chunk.data[keywordPart.next + 1]
    if (
      compressionFlag === undefined ||
      compressionMethod === undefined ||
      ![0, 1].includes(compressionFlag) ||
      compressionMethod !== 0
    ) {
      malformedXmp('PNG XMP iTXt 压缩字段无效', {
        compressionFlag,
        compressionMethod
      })
    }

    const language = readNullTerminated(
      chunk.data,
      keywordPart.next + 2,
      '语言标签'
    )
    const translated = readNullTerminated(
      chunk.data,
      language.next,
      '翻译关键字'
    )
    const encodedText = chunk.data.subarray(translated.next)
    let xmlBytes: Buffer
    try {
      xmlBytes =
        compressionFlag === 1 ? inflateSync(encodedText) : encodedText
    } catch (error) {
      malformedXmp('PNG XMP iTXt 解压失败', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    packets.push({
      source: 'png-itxt',
      xml: decodeUtf8(xmlBytes, 'PNG XMP 数据')
    })
  }
  return packets
}

export function extractEmbeddedXmpPackets(
  buffer: Buffer,
  format: ImageFormat
): EmbeddedXmpPacket[] {
  return format === 'jpeg'
    ? extractJpegPackets(buffer)
    : extractPngPackets(buffer)
}

function namespaceContext(
  parent: NamespaceMap,
  attributes: unknown
): NamespaceMap {
  if (
    attributes === null ||
    typeof attributes !== 'object' ||
    Array.isArray(attributes)
  ) {
    return parent
  }

  let next: Map<string, string> | undefined
  for (const [key, rawValue] of Object.entries(attributes)) {
    const prefix =
      key === '@_xmlns'
        ? ''
        : key.startsWith('@_xmlns:')
          ? key.slice('@_xmlns:'.length)
          : undefined
    if (prefix === undefined || typeof rawValue !== 'string') continue
    next ??= new Map(parent)
    next.set(prefix, rawValue)
  }
  return next ?? parent
}

function expandedName(
  qualifiedName: string,
  namespaces: NamespaceMap
): { namespace?: string; localName: string } {
  const separator = qualifiedName.indexOf(':')
  if (separator < 0) {
    const namespace = namespaces.get('')
    return namespace === undefined
      ? { localName: qualifiedName }
      : { namespace, localName: qualifiedName }
  }
  const prefix = qualifiedName.slice(0, separator)
  const localName = qualifiedName.slice(separator + 1)
  const namespace = namespaces.get(prefix)
  return namespace === undefined
    ? { localName }
    : { namespace, localName }
}

function isExpandedName(
  qualifiedName: string,
  namespaces: NamespaceMap,
  namespace: string,
  localName: string
): boolean {
  const expanded = expandedName(qualifiedName, namespaces)
  return expanded.namespace === namespace && expanded.localName === localName
}

function childElements(nodes: unknown): OrderedXmlNode[] {
  if (!Array.isArray(nodes)) return []
  return nodes.filter(
    (node): node is OrderedXmlNode =>
      node !== null && typeof node === 'object' && !Array.isArray(node)
  )
}

function literalText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return ''
  let text = ''
  for (const node of childElements(nodes)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue
      if (key === '#text') {
        text += typeof value === 'string' ? value : String(value)
        continue
      }
      if (key.startsWith('?')) continue
      malformedXmp('dc:subject 的 rdf:li 必须是简单文本值', { element: key })
    }
  }
  return text
}

function subjectsFromSubjectElement(
  subjectChildren: unknown,
  subjectNamespaces: NamespaceMap
): string[] {
  const values: string[] = []
  for (const bagNode of childElements(subjectChildren)) {
    const bagNamespaces = namespaceContext(
      subjectNamespaces,
      bagNode[':@']
    )
    for (const [bagName, bagChildren] of Object.entries(bagNode)) {
      if (
        bagName === ':@' ||
        !isExpandedName(bagName, bagNamespaces, RDF_NAMESPACE, 'Bag')
      ) {
        continue
      }
      for (const liNode of childElements(bagChildren)) {
        const liNamespaces = namespaceContext(bagNamespaces, liNode[':@'])
        for (const [liName, liChildren] of Object.entries(liNode)) {
          if (
            liName !== ':@' &&
            isExpandedName(liName, liNamespaces, RDF_NAMESPACE, 'li')
          ) {
            values.push(literalText(liChildren))
          }
        }
      }
    }
  }
  return values
}

function walkOrderedXml(
  nodes: unknown,
  parentNamespaces: NamespaceMap,
  values: string[]
): void {
  for (const node of childElements(nodes)) {
    const namespaces = namespaceContext(parentNamespaces, node[':@'])
    for (const [name, children] of Object.entries(node)) {
      if (name === ':@' || name === '#text' || name.startsWith('?')) continue
      if (isExpandedName(name, namespaces, DC_NAMESPACE, 'subject')) {
        values.push(...subjectsFromSubjectElement(children, namespaces))
      }
      walkOrderedXml(children, namespaces, values)
    }
  }
}

export function parseSubjectValuesFromXmp(xml: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    malformedXmp('XMP 不允许包含 DTD 或实体声明')
  }
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    malformedXmp('XMP XML 结构无效', {
      validation
    })
  }

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      preserveOrder: true,
      trimValues: false,
      parseTagValue: false,
      processEntities: true
    })
    const parsed = parser.parse(xml) as unknown
    const values: string[] = []
    walkOrderedXml(parsed, new Map(), values)
    return values
  } catch (error) {
    if (error instanceof AppError) throw error
    malformedXmp('无法解析 XMP XML', {
      cause: error instanceof Error ? error.message : String(error)
    })
  }
}

function similarityKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, '')
    .replace(/_/gu, '-')
}

function editDistanceWithin(
  left: string,
  right: string,
  maximum: number
): boolean {
  if (Math.abs(left.length - right.length) > maximum) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] ?? 0) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      const insertion = (current[rightIndex - 1] ?? 0) + 1
      const deletion = (previous[rightIndex] ?? 0) + 1
      const next = Math.min(substitution, insertion, deletion)
      current[rightIndex] = next
      rowMinimum = Math.min(rowMinimum, next)
    }
    if (rowMinimum > maximum) return false
    previous = current
  }
  return (previous[right.length] ?? maximum + 1) <= maximum
}

export function isSimilarTargetValue(value: string): boolean {
  if (value === TARGET_SUBJECT) return false
  const candidate = similarityKey(value)
  const target = similarityKey(TARGET_SUBJECT)
  return (
    candidate === target ||
    (candidate.length >= target.length - 2 &&
      editDistanceWithin(candidate, target, 2))
  )
}

export function analyzeSubjectValues(values: readonly string[]): SubjectAnalysis {
  const copiedValues = [...values]
  const exactCount = copiedValues.filter(
    (value) => value === TARGET_SUBJECT
  ).length
  const similarValues = copiedValues.filter(isSimilarTargetValue)

  return {
    state:
      exactCount > 1
        ? 'duplicate'
        : exactCount === 1
          ? 'compliant'
          : similarValues.length > 0
            ? 'similar'
            : 'untagged',
    values: copiedValues,
    exactCount,
    similarValues
  }
}

export function inspectEmbeddedXmp(
  buffer: Buffer,
  format: ImageFormat
): SubjectAnalysis {
  const values = extractEmbeddedXmpPackets(buffer, format).flatMap((packet) =>
    parseSubjectValuesFromXmp(packet.xml)
  )
  return analyzeSubjectValues(values)
}
