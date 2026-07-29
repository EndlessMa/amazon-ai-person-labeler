# AI 人物标签工具

公司内部使用的离线桌面工具，用于批量检测、添加或移除图片内嵌 XMP
`dc:subject` 中的固定值：

```text
contains-synthetic-performer
```

V1 不判断图片是否包含 AI 生成人物，也不上传亚马逊。使用者必须先确认哪些媒体需要标记；工具只交付可供后续上传的合规图片。

## V1 范围

- Windows 10 22H2 / Windows 11 x64，以及 macOS Apple Silicon / Intel。
- 输入：多张 JPG/JPEG、静态 PNG、文件夹、ZIP/ZIP64、RAR4/RAR5。
- 三种互相独立的模式：仅检测、添加标签、移除标签。
- 递归扫描、拖放、预检、逐文件选择、二次校验、CSV 报告和诊断日志。
- 源文件始终只读；添加或移除只发生在新建的批次输出目录。
- 不支持视频、APNG、GIF、WebP、TIFF、HEIC、PSD、RAW、7Z、加密/分卷/嵌套/SFX 压缩包和 XMP sidecar。
- 不包含账号、角色、云服务、遥测、自动更新、亚马逊上传、ASIN 匹配或其他图片合规检查。

详细技术边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
当前内测状态与实包验收结果见 [docs/SELF-TEST.md](docs/SELF-TEST.md)。

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

## 内测包

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

V1 按已确认决定不签名：

- macOS 首次运行时，在“系统设置 → 隐私与安全性”中确认仍要打开。
- Windows 出现 SmartScreen 提示时，仅在已核对 `release-manifest.json` 的
  SHA-256 后选择“更多信息 → 仍要运行”。

不要把未核对哈希的内测包转发到公司外部。

## 批次输出

添加/移除模式：

```text
AI人物标签-<批次ID>/
├── images/          # 二次校验通过的图片
│   ├── 输入文件夹 A/
│   └── 输入文件夹 B/
├── report.csv       # Excel 可直接读取，UTF-8 BOM
└── diagnostic.log   # 本地诊断信息，不含图片内容
```

文件夹输入会在 `images/` 下建立同名顶层文件夹，并保留其中的相对目录结构。
因此，不同输入文件夹里的同名图片会分别输出到各自目录，互不覆盖或改名。若两个
输入文件夹本身同名，则从第二个输出目录开始追加 ` (2)`、` (3)`。直接选择的
单张图片和压缩包仍直接输出到 `images/`；它们之间若重名，会安全追加序号。

仅检测模式只生成 `report.csv` 和 `diagnostic.log`，不创建空的 `images/`。

## 维护

- 固定规则：`src/shared/contracts.ts`
- 发布审计副本：`resources/rule-manifest.json`
- 固定回归样本：`pnpm test:fixtures`
- 自动化与端到端回归：`tests/`
- 第三方组件说明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- 当前许可状态：[LICENSE-NOTICE.md](LICENSE-NOTICE.md)
- 内测验收记录：[docs/SELF-TEST.md](docs/SELF-TEST.md)
