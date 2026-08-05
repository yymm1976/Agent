# RouteDev Android 验证报告

更新时间：2026-08-02

## 本轮改动

- 配对二维码增加 `transport` 字段：同一 Wi-Fi 使用 `lan`，跨网络使用 HTTPS。
- Android 只接受私有 IPv4 网段的 LAN HTTP；公共地址的明文 HTTP 会被拒绝。
- 连接页面改为 LAN 优先，不再把 Tailscale 当作必需依赖。
- 桌面端设置页提供“局域网直连 / Tailscale（跨网络 HTTPS）”选择。

## 桌面端验证

- `pnpm typecheck`：通过
- 远程配置、配对、Gateway 定向测试：通过
- `pnpm run build`：通过
- `pnpm run dist:electron`：通过

交付产物：

| 文件 | SHA-256 |
| --- | --- |
| `routedev/release-v25/RouteDev-4.9.0-portable.exe` | `10D91817FDF963B5427357A0A12ECB9F472701F06452000B8E72F1947B6A7DBE` |
| `routedev/release-v25/RouteDev Setup 4.9.0.exe` | `2DB5C0C78EB5BD1DBB5923204C94EAE169AFFBB2C49F1CFE99B4761A8F973018` |

## Android 验证状态

本轮 Android 源码已修改，但尚未生成包含 LAN 模式的新版 APK。Gradle 9.4.1 已成功下载，且已加入 `android.overridePathCheck=true` 以兼容当前 Windows 中文路径；当前构建机没有 Android SDK API 36 与 Build Tools 36.0.0。临时 SDK 下载已验证可用，但安装组件需要接受 Google Android SDK 许可证，未代替用户确认，因此本轮没有继续安装或生成 APK。

仓库中现有的 APK/AAB 哈希属于改动前构建，仅供追溯，不能用于验证本轮 LAN 配对：

- debug APK：`27AB835B86DABD47A84D016ACD49D084D46814BC8FA8C314CF1A5B7159CABE23`
- release unsigned APK：`9FA32A8F3628B153CAB5D7708D250FCACD5C5ABDD490590C8313C84295AAD8AD`
- release AAB：`8F0EF1EDC690C88CAECCDF1E410B58A94FEC775CBF617446ABA865D0E53CE341`

依赖恢复后，在本目录执行：

```powershell
.\gradlew.bat :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
.\gradlew.bat :app:assembleRelease :app:bundleRelease
```

随后应重点验收：同一 Wi-Fi 下扫码配对、任务流式更新、待办快照、Skill/MCP/工具选择和任务完成通知；跨网络场景再单独验证 Tailscale HTTPS。
