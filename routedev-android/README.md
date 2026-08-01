# RouteDev Remote for Android

## 局域网直连（默认）

手机和电脑在同一个可信 Wi-Fi 时，不需要安装 Tailscale。桌面端开启“局域网直连”，二维码会携带 `http://192.168.x.x:43117` 地址；手机只接受私有 IPv4 网段的局域网地址。

局域网模式使用 HTTP，只适用于可信家庭或办公网络。跨网络或不可信网络请改用 HTTPS 传输。

RouteDev Remote 是电脑端 RouteDev 的安全遥控客户端。模型、API Key、MCP 凭据、工作区文件和命令执行始终留在电脑上；手机只通过版本化 REST + SSE 查看进度和发送经过电脑端重新校验的指令。

## 连接电脑

1. 在电脑 RouteDev 的“设置 → 远程连接”中开启 Remote Gateway。
2. 如果手机和电脑在同一可信 Wi-Fi，选择“局域网直连”，保存后直接生成二维码；不需要安装任何第三方软件。
3. 如果需要跨网络访问，选择“Tailscale（跨网络 HTTPS）”，再在电脑上安装并登录 [Tailscale](https://tailscale.com/download/windows)，手机登录同一个 tailnet。
4. 跨网络模式按设置页给出的命令显式启用 HTTPS 转发：

   ```powershell
   tailscale serve --bg http://127.0.0.1:43117
   ```

5. 把 Tailscale 提供的 `https://<设备名>.<tailnet>.ts.net` 地址填回 RouteDev 设置页，生成 5 分钟有效的一次性二维码。
6. 在 Android App 扫码。电脑会显示手机名称和申请权限，只有桌面用户确认后才签发设备令牌。

局域网模式会监听电脑发现的私有 IPv4 网卡；HTTPS 模式仍只监听 `127.0.0.1`，由 Tailscale Serve 转发。项目不会静默修改 Tailscale 或使用云中继。

## 能力与限制

- 支持最近任务、新建对话、发送/停止、严格有序时间线、当前待办、授权、Skill/MCP/工具范围和完成通知。
- Skill、MCP 和工具选择只影响下一轮，发送成功后清空。
- 远程选择只能收窄电脑端现有权限；不能安装 Skill、修改 MCP 凭据或绕过沙箱。
- 开启“任务完成通知”后，前台服务保持 SSE。应用被强制停止、电脑关机或网络断开时不保证即时通知；恢复后使用 `Last-Event-ID` 补齐。
- 设备 token 由 Android Keystore 的 AES-256-GCM 密钥加密，不进入 Room、日志、资源、BuildConfig 或系统备份。

## 构建

要求 JDK 17+ 与 Android SDK API 36。

```powershell
.\gradlew.bat :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
.\gradlew.bat :app:assembleRelease :app:bundleRelease
```

主要产物：

- `app/build/outputs/apk/debug/app-debug.apk`
- `app/build/outputs/apk/release/app-release-unsigned.apk`
- `app/build/outputs/bundle/release/app-release.aab`

Release 产物必须由发布者使用自己的 Android 签名密钥签名；仓库不包含密钥或密码。
