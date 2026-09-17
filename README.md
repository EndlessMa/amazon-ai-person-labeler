# AI人物标签

离线桌面工具，用于批量检测、添加或移除图片内嵌 XMP
`dc:subject` 中的固定值：

```text
contains-synthetic-performer
```

V1 不判断图片是否包含 AI 生成人物，也不上传亚马逊。使用者必须先确认哪些媒体需要标记；工具只交付可供后续上传的合规图片。

## V1 范围

- Windows 10 22H2 / Windows 11 x64，以及 macOS Apple Silicon / Intel。
- 输入：多张 JPG/JPEG、静态 PNG、文件夹、ZIP/ZIP64、RAR4/RAR5。
- 在“添加图片”右侧下拉选择添加或移除标签，默认为添加；两者处理前都会执行只读预检。
- 点击“更换文件夹”后会直接保存为默认输出位置；“一键输出”会自动完成预检、空间检查和处理。
- 递归扫描、拖放、预检、逐文件选择和二次校验。
- 源文件始终只读；添加或移除只发生在新建的批次输出目录。
- 不支持视频、APNG、GIF、WebP、TIFF、HEIC、PSD、RAW、7Z、加密/分卷/嵌套/SFX 压缩包和 XMP sidecar。
- 不包含账号、角色、云服务、遥测、自动更新、亚马逊上传、ASIN 匹配或其他图片合规检查。

详细技术边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
当前测试状态与实包验收结果见 [docs/SELF-TEST.md](docs/SELF-TEST.md)。

## 下载

请在 [GitHub Releases](https://github.com/EndlessMa/amazon-ai-person-labeler/releases)
下载最新版本：

- `AI人物标签-*-mac-arm64.zip`：macOS Apple Silicon（M1/M2/M3/M4 等）。
- `AI人物标签-*-mac-x64.zip`：macOS Intel。
- `AI人物标签-*-windows-x64.exe`：Windows 10/11 64 位便携版。
- `SHA256SUMS.txt`：下载文件完整性校验值。

## 本地开发

要求 Node.js 22.12+ 和 pnpm 11+：

```bash
pnpm install
pnpm dev
```

完整检查：

```bash
pnpm check
```

## 本地构建

```bash
pnpm dist:mac:arm64
pnpm dist:mac:x64
pnpm dist:win:x64
```

每次打包会在 `release/` 生成 `release-manifest.json`，列出包大小和
SHA-256。`dist:win:x64` 带平台门禁，只能在 Windows x64 主机上执行：必须先在该
主机运行 `pnpm install --frozen-lockfile`，确保按平台安装的 ExifTool.exe 被收入包内，
再完成一轮检测与添加冒烟测试。工具会拒绝在 macOS 上生成无法验证的 Windows 包。

Mac 包应在对应架构的 Mac 上构建与自测；Apple Silicon 主机安装 Rosetta 后也可以对
x64 包做补充冒烟测试。

当前发布包未使用商业代码签名证书：

- macOS 首次运行时，在“系统设置 → 隐私与安全性”中确认仍要打开。
- Windows 出现 SmartScreen 提示时，仅在已核对 `release-manifest.json` 的
  SHA-256 后选择“更多信息 → 仍要运行”。

建议下载后使用 Release 中的 `SHA256SUMS.txt` 核对文件。

## 批次输出

添加/移除模式：

```text
AI人物标签-<批次ID>/
├── 主图.jpg
├── 主图 (2).jpg
└── 细节图.png
```

所有成功图片都直接平铺到批次目录，不再生成 `images/`、CSV 或诊断日志。
无论图片来自直接选择、文件夹还是压缩包，只要名称重复，就从第二张开始追加
` (2)`、` (3)`，不会覆盖先前文件。

添加模式的一键流程会自动选择所有预检合格图片。已经包含一个精确目标标签的图片
不会重复写入标签，而是原样复制到输出，因此批次结果仍包含全部可用图片。

预检显示实际检查数量与当前文件，支持取消后重试。元数据引擎启动超过 30 秒会明确报错；缩略图生成失败或超时会跳过预览，不影响图片检查结果。

## 维护

- 固定规则：`src/shared/contracts.ts`
- 发布审计副本：`resources/rule-manifest.json`
- 固定回归样本：`pnpm test:fixtures`
- 自动化与端到端回归：`tests/`
- 第三方组件说明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- 当前许可状态：[LICENSE-NOTICE.md](LICENSE-NOTICE.md)
- 验收记录：[docs/SELF-TEST.md](docs/SELF-TEST.md)
