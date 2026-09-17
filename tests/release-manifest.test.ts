import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const script = resolve('scripts/generate-release-manifest.mjs')
const packageMetadata = JSON.parse(
  await readFile(resolve('package.json'), 'utf8')
) as { version: string; build: { productName: string } }
const ruleMetadata = JSON.parse(
  await readFile(resolve('resources/rule-manifest.json'), 'utf8')
) as { ruleVersion: string }

function currentMacArtifact(arch: 'arm64' | 'x64' = 'arm64'): string {
  return `${packageMetadata.build.productName}-${packageMetadata.version}-mac-${arch}.zip`
}

describe('release manifest generation', () => {
  it('derives release metadata from project sources and hashes current artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labeler-manifest-'))
    const artifactName = currentMacArtifact()
    const contents = Buffer.from('fixed release bytes')
    await writeFile(join(directory, artifactName), contents)
    await writeFile(join(directory, 'builder-effective-config.yaml'), 'ignored')

    await execFileAsync(process.execPath, [script, directory])
    const manifest = JSON.parse(
      await readFile(join(directory, 'release-manifest.json'), 'utf8')
    ) as {
      product: string
      version: string
      ruleVersion: string
      artifacts: Array<{ file: string; bytes: number; sha256: string }>
    }
    expect(manifest).toMatchObject({
      product: packageMetadata.build.productName,
      version: packageMetadata.version,
      ruleVersion: ruleMetadata.ruleVersion,
      artifacts: [
        {
          file: artifactName,
          bytes: contents.length,
          sha256: createHash('sha256').update(contents).digest('hex')
        }
      ]
    })
  })

  it.each([
    ['旧版本', 'AI人物标签-0.0.1-mac-arm64.zip'],
    ['未知产品', 'unknown-tool-0.1.0-windows-x64.exe'],
    ['错误目标', `${packageMetadata.build.productName}-${packageMetadata.version}-linux-x64.zip`]
  ])('拒绝 release 目录中的%s安装包', async (_label, rejectedName) => {
    const directory = await mkdtemp(join(tmpdir(), 'labeler-stale-release-'))
    await writeFile(join(directory, currentMacArtifact()), 'current')
    await writeFile(join(directory, rejectedName), 'stale')

    await expect(
      execFileAsync(process.execPath, [script, directory])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('未知、旧版本或命名不合规')
    })
  })
})
