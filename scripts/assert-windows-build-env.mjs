import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(
    'Windows 内测包必须在 Windows x64 主机上构建并冒烟测试，已拒绝跨平台生成可能缺少 ExifTool.exe 的包。'
  )
}

const require = createRequire(import.meta.url)
const requireFromExifTool = createRequire(
  require.resolve('exiftool-vendored')
)

let executable
try {
  executable = requireFromExifTool('exiftool-vendored.exe')
} catch (error) {
  throw new Error(
    '未安装 Windows ExifTool 引擎。请在 Windows x64 上执行 pnpm install --frozen-lockfile 后重试。',
    { cause: error }
  )
}

if (typeof executable !== 'string' || !existsSync(executable)) {
  throw new Error(`Windows ExifTool 引擎不存在：${String(executable)}`)
}

console.log(`Windows 构建环境检查通过：${executable}`)
