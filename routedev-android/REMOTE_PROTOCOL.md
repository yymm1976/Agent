# RouteDev Remote Protocol v1

- 命令：JSON REST，统一 `RemoteApiResponse` envelope。
- 增量：SSE `GET /v1/events?sessionId=...`。
- 恢复：请求头 `Last-Event-ID`，服务端只补发缺失事件。
- 排序：只按单会话严格递增的 `sequence`，不得按到达时间或 UI 分组排序。
- 幂等：发送消息使用稳定 `clientMessageId`；新建会话使用 `clientSessionId`。
- 兼容：客户端忽略未知 JSON 字段；协议版本不匹配时拒绝继续。
- 安全：Bearer 设备 token；配对 secret 一次性、限时、桌面只存哈希。

共享契约夹具位于 `protocol/fixtures/`，TypeScript 与 Kotlin 测试读取相同数据。
