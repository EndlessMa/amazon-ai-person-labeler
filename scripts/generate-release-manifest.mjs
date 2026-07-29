import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const releaseDirectory = resolve(process.argv[2] ?? 'release')
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageMetadata = JSON.parse(
  await readFile(join(projectDirectory, 'package.json'), 'utf8')
)
const ruleMetadata = JSON.parse(
  await readFile(
    join(projectDirectory, 'resources', 'rule-manifest.json'),
    'utf8'
  )
)
const product = packageMetadata?.build?.productName
const version = packageMetadata?.version
const ruleVersion = ruleMetadata?.ruleVersion

for (const [field, value] of Object.entries({ product, version, ruleVersion })) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`发布元数据缺少有效的 ${field}`)
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function artifactExtension(target) {
  if (target === 'zip' || target === 'dmg') return target
  if (target === 'portable' || target === 'nsis') return 'exe'
  throw new Error(`发布清单脚本不认识构建目标：${String(target)}`)
}

const distributableExtension = /\.(?:zip|exe|dmg)$/i
const expectedArtifactNames = new Set()
for (const platformName of ['mac', 'win']) {
  const platform = packageMetadata?.build?.[platformName]
  const template = platform?.artifactName
  if (typeof template !== 'string' || !Array.isArray(platform?.target)) {
    throw new Error(`package.json 缺少有效的 build.${platformName} 发布配置`)
  }
  for (const target of platform.target) {
    if (
      !target ||
      typeof target !== 'object' ||
      typeof target.target !== 'string' ||
      !Array.isArray(target.arch)
    ) {
      throw new Error(`build.${platformName}.target 配置无法生成严格清单`)
    }
    const extension = artifactExtension(target.target)
    for (const arch of target.arch) {
      if (typeof arch !== 'string' || arch.length === 0) {
        throw new Error(`build.${platformName}.target 包含无效架构`)
      }
      expectedArtifactNames.add(
        template
          .replaceAll('${productName}', product)
          .replaceAll('${version}', version)
          .replaceAll('${arch}', arch)
          .replaceAll('${ext}', extension)
      )
    }
  }
}
const entries = await readdir(releaseDirectory, { withFileTypes: true })
const artifacts = []
const rejectedArtifacts = []

for (const entry of entries) {
  if (!entry.isFile() || !distributableExtension.test(entry.name)) continue
  if (!expectedArtifactNames.has(entry.name)) {
    rejectedArtifacts.push(entry.name)
    continue
  }
  const path = join(releaseDirectory, entry.name)
  const before = await stat(path)
  const digest = await sha256(path)
  const after = await stat(path)
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  ) {
    throw new Error(`发布包在计算哈希期间发生变化：${entry.name}`)
  }
  artifacts.push({
    file: basename(path),
    bytes: after.size,
    sha256: digest
  })
}

if (rejectedArtifacts.length > 0) {
  throw new Error(
    `release 目录含有未知、旧版本或命名不合规的安装包：${rejectedArtifacts.sort().join('；')}`
  )
}

artifacts.sort((left, right) => left.file.localeCompare(right.file, 'zh-CN'))

if (artifacts.length === 0) {
  throw new Error(`没有在 ${releaseDirectory} 找到可发布的安装包`)
}

const manifest = {
  schemaVersion: 1,
  product,
  version,
  ruleVersion,
  generatedAt: new Date().toISOString(),
  unsigned: true,
  artifacts
}

const destination = join(releaseDirectory, 'release-manifest.json')
const temporary = `${destination}.${process.pid}.tmp`
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
await rename(temporary, destination)
console.log(`已生成 ${destination}（${artifacts.length} 个安装包）`)
