# 第三方组件说明

V1 直接使用的主要组件如下。精确版本以 `pnpm-lock.yaml` 为准，完整许可文本保留在各
`node_modules` 包及打包产物中。

| 组件 | 用途 | 许可证/注意事项 |
| --- | --- | --- |
| Electron | 跨平台桌面运行时 | MIT；Chromium 等组件另有随包 notices |
| React / React DOM | 用户界面 | MIT |
| electron-vite / Vite | 构建 | MIT |
| electron-builder | 打包 | MIT |
| exiftool-vendored | ExifTool 进程管理 | MIT |
| ExifTool | 图片元数据读写 | Artistic License 2.0 或 GPL |
| 7zip-bin-full / 7-Zip | ZIP、RAR 解压 | 包装器 MIT；7-Zip 主体 LGPL，部分代码 BSD；UnRAR 解码部分禁止用于重建 RAR 压缩算法 |
| fast-xml-parser | 独立 XMP XML 解析 | MIT |
| Lucide | 界面图标 | ISC |
| TypeScript / Vitest | 开发与测试 | Apache-2.0 / MIT |

本工具只调用 7-Zip 的解压能力，不创建 RAR，也不使用其解码代码实现 RAR 压缩。

