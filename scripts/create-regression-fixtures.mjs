import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import sevenZip from '7zip-bin-full'

const TARGET = 'contains-synthetic-performer'
const outputRoot = resolve('regression-fixtures')
const imagesDirectory = join(outputRoot, 'images')
const nestedDirectory = join(outputRoot, 'folder-input', 'nested')
const archiveSource = join(outputRoot, 'archive-source')

let crcTable

function crc32(data) {
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

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBuffer.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length
  )
  return output
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmp(values) {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">固定回归样本</rdf:li></rdf:Alt></dc:title>',
    '<dc:subject><rdf:Bag>',
    ...values.map((value) => `<rdf:li>${xmlEscape(value)}</rdf:li>`),
    '</rdf:Bag></dc:subject>',
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  ].join('')
}

function png(values, { malformedXmp, animated = false } = {}) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const chunks = [pngChunk('IHDR', ihdr)]
  if (animated) {
    const animationControl = Buffer.alloc(8)
    animationControl.writeUInt32BE(1, 0)
    animationControl.writeUInt32BE(0, 4)
    chunks.push(pngChunk('acTL', animationControl))
  }
  const packet =
    malformedXmp ?? (values === undefined ? undefined : xmp(values))
  if (packet !== undefined) {
    chunks.push(
      pngChunk(
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
    pngChunk(
      'IDAT',
      deflateSync(Buffer.from([0, 10, 20, 30, 40, 50, 60]))
    ),
    pngChunk('IEND', Buffer.alloc(0))
  )
  return Buffer.concat([signature, ...chunks])
}

const onePixelJpeg = Buffer.from(
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

function storedZip(entryName, data) {
  const name = Buffer.from(entryName)
  const checksum = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

async function runSevenZip(args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(sevenZip.path7z, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`7-Zip 退出码 ${code}: ${stderr}`))
    })
  })
}

await Promise.all([
  mkdir(imagesDirectory, { recursive: true }),
  mkdir(nestedDirectory, { recursive: true }),
  mkdir(archiveSource, { recursive: true })
])

const files = {
  '01-未标记.png': png(['普通关键词']),
  '02-已合规.png': png(['普通关键词', TARGET]),
  '03-重复待规范.png': png([TARGET, '保留关键词', TARGET]),
  '04-近似值.png': png([` ${TARGET} `, TARGET.toUpperCase()]),
  '05-XMP损坏.png': png(undefined, {
    malformedXmp: '<rdf:RDF><dc:subject></rdf:RDF>'
  }),
  '06-APNG.png': png([], { animated: true }),
  '07-未标记.jpg': onePixelJpeg
}

for (const [name, data] of Object.entries(files)) {
  await writeFile(join(imagesDirectory, name), data)
}
await writeFile(join(imagesDirectory, '08-不支持.txt'), 'not an image\n')
await writeFile(join(nestedDirectory, '嵌套-未标记.png'), files['01-未标记.png'])
await writeFile(join(archiveSource, '归档-未标记.png'), files['01-未标记.png'])
await writeFile(join(archiveSource, '归档-已合规.png'), files['02-已合规.png'])

const normalZip = join(outputRoot, 'normal.zip')
await rm(normalZip, { force: true })
await runSevenZip(['a', '-tzip', '-mx1', normalZip, `${archiveSource}/*`])
await writeFile(
  join(outputRoot, 'unsafe-traversal.zip'),
  storedZip('../escape.png', files['01-未标记.png'])
)

await writeFile(
  join(outputRoot, 'expected.json'),
  `${JSON.stringify(
    {
      ruleVersion: 'amazon-ai-person-xmp-v1',
      target: TARGET,
      expectedDetection: {
        '01-未标记.png': 'untagged',
        '02-已合规.png': 'compliant',
        '03-重复待规范.png': 'duplicate',
        '04-近似值.png': 'similar',
        '05-XMP损坏.png': 'MALFORMED_METADATA',
        '06-APNG.png': 'ANIMATED_PNG',
        '07-未标记.jpg': 'untagged',
        '08-不支持.txt': 'UNSUPPORTED_FORMAT'
      },
      unsafeArchives: {
        'unsafe-traversal.zip': 'ARCHIVE_PATH_UNSAFE'
      }
    },
    null,
    2
  )}\n`
)

console.log(`固定回归样本已生成：${outputRoot}`)

