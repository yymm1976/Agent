# Security boundaries

- Desktop 是唯一执行端；Android 不持有模型 API Key、MCP header 或文件系统权限。
- Gateway 默认只服务本机；局域网模式会显式绑定私有网络接口，并只在二维码标记为 `lan` 时允许 Android 使用私有 IPv4 HTTP 地址。
- Tailscale/自定义远程连接使用 HTTPS。局域网 HTTP 只适用于可信家庭或办公 Wi-Fi，不应在公共网络使用。
- 设备 token 使用 Android Keystore AES-256-GCM 加密；不进入 Room、日志、资源、BuildConfig 或系统备份。
- 设备被撤销后，现有 SSE 会被桌面端关闭；Android 收到 401 后清除本地凭据并返回配对流程。
- Android 提交的 Skill/MCP/工具名称由 Desktop 与已安装、已启用、已连接及权限范围求交集。
- `approvals:resolve` 与 `autonomy:change` 默认不授予。
- 日志和异常不得包含 token、配对 secret、模型 Key、MCP 凭据或完整敏感工具参数。
