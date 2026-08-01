# RouteDev Android Remote 一次性 `/goal` 实施计划

## 1. 可直接交给 `/goal` 的目标

在同一个父工作区内完成 RouteDev Desktop 安全远程网关和全新的 Android 客户端。Android 客户端通过 Tailscale 访问电脑上的 RouteDev，能够查看最近任务与严格按时间排序的执行时间线、新建对话、发送消息、停止任务、处理授权请求、选择本轮 Skill 与 MCP 范围，并在任务完成时发送 Android 系统通知。

必须遵守以下边界：

- RouteDev Desktop 是唯一执行端。模型 API Key、MCP 凭据、文件内容权限和命令执行能力不得复制到 Android。
- RouteDev Gateway 只监听 `127.0.0.1`，由 Tailscale Serve 提供 tailnet 内 HTTPS 入口；不得直接向公网或局域网开放裸端口。
- 传输采用版本化 REST + SSE。命令走 REST，严格有序的增量事件走 SSE，并支持 `Last-Event-ID` 断线续传。
- Android 必须通过限时配对码完成首次配对，并把设备令牌保存到 Android Keystore 支持的加密存储中。桌面端必须支持查看和撤销设备。
- 手机端指定的 Skill、MCP Server 和工具范围都必须在桌面端重新校验。客户端提交的名称不能绕过已安装、已启用、权限、沙箱和审批策略。
- 不引入云中继、Firebase 后端或 RouteDev 账号系统。任务完成即时通知依赖 Android 前台连接服务；应用被系统强制停止后不承诺即时通知。
- 不把模型隐藏思维链当作产品数据。只传输供应商实际返回且 RouteDev 已允许展示的 reasoning 增量、模型主动输出的工作进度、工具事件和任务状态。
- 所有新增协议必须有契约测试；所有安全边界必须有拒绝路径测试；最后同时产出 Android APK 和 RouteDev Windows portable 包。

## 2. 工作区前提

一次性 `/goal` 必须从同时能访问两个工程的父目录运行：

- `routedev/`：现有 RouteDev Desktop 工程。
- `routedev-android/`：新建 Android 工程。

如果 `/goal` 只在 Android 工程内运行，它无法完成 RouteDev 服务端接入，任务不得被标记为完成。

建议 Android 工程配置：

- Kotlin
- Gradle Kotlin DSL
- Jetpack Compose
- 最低 Android 版本以仍受官方安全更新支持的范围为准
- 单 Activity
- Material 3
- OkHttp REST/SSE
- Kotlin Serialization
- Room
- DataStore
- Android Keystore 支持的令牌加密封装
- WorkManager 仅用于非即时补偿同步

不要在计划中锁死依赖版本。创建项目时查询当时的 Android 官方稳定版本，并把版本集中写入 version catalog。

## 3. 已确认架构

### 3.1 网络路径

Android App → Tailscale tailnet HTTPS → Tailscale Serve → `127.0.0.1:43117` → RouteDev Remote Gateway → RouteDevEngine。

选择该结构的原因：

- Tailscale 已提供 WireGuard 加密、设备身份和 NAT 穿透。
- RouteDev 不需要自己处理公网证书、端口映射、动态 DNS 或云中继。
- Gateway 只监听 loopback，即使用户防火墙配置错误也不会裸露在普通局域网。
- Tailscale Serve 可以提供 Android 可正常验证的 HTTPS 地址。

### 3.2 进程边界

Gateway 运行在 Electron 主进程内，但业务逻辑不得直接依赖 `ipcMain` 或 BrowserWindow。

新增三个边界：

1. `RemoteProtocol`：纯类型、校验器、事件 envelope 和错误码。
2. `RouteDevRemoteService`：把协议命令映射到 RouteDevEngine 能力。
3. `RemoteGatewayServer`：只负责 HTTP、SSE、鉴权、限流和序列化。

Renderer IPC 与 Remote Gateway 必须共享同一个应用服务层，不能复制两套聊天、Skill、MCP 或任务逻辑。

### 3.3 通知边界

- Android 用户打开“任务通知连接”后启动前台服务并保持 SSE。
- 收到 `task.completed`、`task.failed` 或 `approval.required` 时生成本地通知。
- App 在前台时更新 UI，可抑制重复系统通知。
- 断线后用指数退避重连，并带上最后确认的 event id。
- 被用户强制停止、撤销 VPN 或关闭电脑时，不保证即时通知；恢复后通过事件续传补齐状态。

## 4. 协议设计

### 4.1 通用 envelope

所有响应和事件都包含：

- `protocolVersion`
- `requestId` 或 `eventId`
- `timestamp`
- `sessionId`
- `turnId`，不属于具体 turn 时可为空
- `sequence`，在单个 session 内严格单调递增
- `type`
- `payload`

事件排序以 `sequence` 为准，不能以 Android 收包时间、工具完成时间或 UI 分组顺序代替。

### 4.2 最小 REST API

- `GET /v1/health`
- `GET /v1/capabilities`
- `POST /v1/pair`
- `GET /v1/devices`
- `DELETE /v1/devices/{deviceId}`
- `GET /v1/sessions`
- `POST /v1/sessions`
- `GET /v1/sessions/{sessionId}`
- `GET /v1/sessions/{sessionId}/timeline`
- `POST /v1/sessions/{sessionId}/messages`
- `POST /v1/sessions/{sessionId}/stop`
- `POST /v1/approvals/{approvalId}/resolve`
- `GET /v1/skills`
- `GET /v1/mcp/servers`
- `GET /v1/tools`
- `GET /v1/events`，SSE，支持 `Last-Event-ID`

### 4.3 发送消息请求

消息请求除文本和图片外，允许携带：

- `skillIds`：本轮显式加载的 Skill。
- `mcpServerIds`：本轮允许暴露工具的 MCP Server。
- `allowedToolNames`：可选的进一步收窄，不得扩大桌面端权限。
- `autonomyMode`：可选请求值；是否允许远程修改由设备 scope 和桌面配置决定。
- `clientMessageId`：Android 离线重试幂等键。

服务端处理顺序：

1. 验证设备 scope。
2. 验证 session 状态和 `clientMessageId` 幂等性。
3. 解析并验证 Skill、MCP 和工具选择。
4. 对工具集取“客户端请求范围 ∩ 桌面已启用范围 ∩ 权限允许范围”。
5. 启动 turn，生成稳定 `turnId`。
6. 把事件写入 journal 后再推送 SSE。

### 4.4 事件类型

至少支持：

- `session.created`
- `session.updated`
- `turn.started`
- `assistant.text.delta`
- `assistant.reasoning.delta`
- `assistant.progress`
- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `tool.failed`
- `todo.replaced`
- `todo.updated`
- `approval.required`
- `approval.resolved`
- `turn.completed`
- `turn.failed`
- `task.completed`
- `task.failed`
- `connection.notice`

`assistant.progress` 必须来自模型实际文本输出或明确的引擎状态，不允许使用“模型思考中，第 N 轮”一类硬编码内容冒充模型进度。

### 4.5 错误码

定义稳定错误码，至少覆盖：

- `AUTH_REQUIRED`
- `AUTH_REVOKED`
- `PAIRING_EXPIRED`
- `PAIRING_INVALID`
- `SCOPE_DENIED`
- `SESSION_NOT_FOUND`
- `SESSION_BUSY`
- `SKILL_NOT_AVAILABLE`
- `MCP_NOT_AVAILABLE`
- `TOOL_NOT_ALLOWED`
- `APPROVAL_EXPIRED`
- `CONFLICT`
- `RATE_LIMITED`
- `ENGINE_UNAVAILABLE`
- `PROTOCOL_MISMATCH`

Android 不能依赖中文错误文案判断行为。

## 5. 安全设计

### 5.1 配对

- 桌面端生成 128 位以上随机一次性配对 secret，保存哈希，默认 5 分钟过期且只可使用一次。
- 二维码包含 HTTPS base URL、配对 id、secret、协议版本和桌面显示名。
- Android 扫码后生成设备 id，提交配对信息。
- 桌面显示设备名和请求 scope，由用户确认后签发 256 位随机设备 token。
- token 只在签发响应中返回一次；桌面只保存哈希和设备元数据。

### 5.2 设备 scope

按设备控制：

- `sessions:read`
- `messages:send`
- `tasks:stop`
- `approvals:resolve`
- `skills:select`
- `mcp:select`
- `autonomy:change`

默认授予读取、发消息、停止、选择 Skill/MCP；远程审批和修改自主度默认关闭。

### 5.3 网关限制

- 只绑定 `127.0.0.1`。
- 启动时若配置了非 loopback 地址直接拒绝。
- Bearer token 使用常量时间哈希比较。
- 每设备和每 endpoint 限流。
- 请求体有严格大小上限。
- 图片类型、数量和大小受限。
- 所有路径、工具、Skill、MCP id 都采用 allowlist 解析。
- 日志不得记录 token、配对 secret、模型 Key、MCP header 或完整敏感参数。
- CORS 默认关闭；Gateway 不面向浏览器。
- Tailscale Serve 配置由用户显式完成，RouteDev 只提供检测结果和复制命令，不静默修改系统网络配置。

## 6. Android 页面

### 6.1 配对页

- 扫描二维码
- 手动输入 tailnet HTTPS 地址
- 展示电脑名称、协议版本和连接状态
- 展示配对失败的通俗解释

### 6.2 首页

- 最近任务
- 运行中、等待授权、已完成、失败四种状态
- 最近更新时间
- 新建对话
- 连接状态与电脑在线状态

### 6.3 对话页

- 严格按 `sequence` 展示时间线
- 用户消息、模型文本、真实进度、reasoning、工具调用、待办、审批和最终结果交错展示
- reasoning 默认折叠
- 工具参数与输出默认摘要，按需展开
- 待办只展示当前对话的最新完整快照
- 输入区支持发送、停止、Skill 选择、MCP 范围选择和工具范围查看

### 6.4 Skill/MCP 选择器

- 只显示电脑端已安装且已启用项目
- Skill 显示名称、通俗描述和来源
- MCP 显示服务器、连接状态和可用工具数量
- 选择只影响当前发送 turn，除非用户明确保存为会话默认值
- Android 不提供 MCP 凭据编辑和远程安装

### 6.5 设置页

- 已配对电脑
- 连接测试
- 通知开关
- 前台连接服务说明
- 设备权限 scope
- 清除本地凭据
- 协议与应用版本

## 7. 数据与状态

- Room 保存 session 摘要、timeline event、最后 event id、待发送消息和连接状态。
- UI 只从本地数据库观察状态；网络层先落库再通知 UI。
- `(sessionId, sequence)` 唯一，重复 SSE 事件必须幂等。
- 发送消息使用 `clientMessageId`，网络超时后安全重试。
- 新建 session 的临时本地 id 在服务端确认后原子替换。
- token 与敏感连接资料不得进入 Room 明文库。

## 8. 分阶段实施任务

### Task 1：建立协议源与契约夹具

涉及文件：

- `routedev/desktop/shared/remote-protocol.ts`
- `routedev/desktop/shared/remote-schemas.ts`
- `routedev/tests/contracts/remote-protocol.test.ts`
- `routedev-android/protocol/fixtures/*.json`
- `routedev-android/app/src/test/.../ProtocolFixtureTest.kt`

工作：

- 定义 REST DTO、事件 envelope、错误码和协议版本。
- 为每种请求、响应和事件保存成功与失败 JSON fixture。
- TS 和 Kotlin 分别读取同一批 fixture 做序列化兼容测试。

验收：

- 未知字段向前兼容。
- 缺失必填字段和错误枚举被拒绝。
- sequence、event id 和时间字段语义固定。

依赖：无。

### Task 2：建立 EngineEventHub 与顺序 journal

涉及文件：

- `routedev/desktop/main/events/engine-event-hub.ts`
- `routedev/desktop/main/events/session-event-journal.ts`
- `routedev/desktop/main/bridges/chat-bridge.ts`
- `routedev/desktop/main/engine-bridge.ts`
- 对应测试文件

工作：

- 把单一 renderer 回调改为可订阅 fan-out。
- 为每个 session/turn 生成稳定 id 和严格递增 sequence。
- 按真实发生顺序发布文本、reasoning、工具、待办、审批和完成事件。
- journal 使用有界追加日志，支持按 event id/sequence 续读。
- 移除硬编码 thinking 文案对产品时间线的影响。

验收：

- 两段 reasoning 之间发生工具调用时，journal 顺序与真实事件一致。
- 模型中途输出的工作进度不会丢失。
- renderer 与 remote 订阅互不影响。

依赖：Task 1。

### Task 3：抽取 RouteDevRemoteService

涉及文件：

- `routedev/desktop/main/remote/remote-service.ts`
- `routedev/desktop/main/remote/remote-types.ts`
- `routedev/desktop/main/bridges/*.ts`
- 对应服务测试

工作：

- 封装 session、消息、停止、审批、Skill、MCP 和工具查询。
- 扩展聊天请求支持显式 `skillIds`、`mcpServerIds` 和工具收窄。
- 所有远程选择在服务端与当前配置求交集。
- 保持现有 renderer IPC 行为兼容。

验收：

- 远程请求不能启用未安装 Skill、未连接 MCP 或被禁工具。
- 同一 `clientMessageId` 不会重复执行。
- renderer 现有测试不回归。

依赖：Task 1、Task 2。

### Task 4：设备存储、配对与 scope

涉及文件：

- `routedev/desktop/main/remote/device-store.ts`
- `routedev/desktop/main/remote/pairing-service.ts`
- `routedev/src/config/schema-remote.ts`
- `routedev/src/config/defaults.ts`
- 对应安全测试

工作：

- 实现限时单次配对、token 哈希存储、设备撤销和 scope。
- token 文件使用原子写入和限制性文件权限。
- Gateway 默认关闭。

验收：

- 过期、重放、错误 secret、撤销 token、缺失 scope 都被拒绝。
- 日志和异常不包含 secret/token。

依赖：Task 1。

### Task 5：实现 loopback REST + SSE Gateway

涉及文件：

- `routedev/desktop/main/remote/gateway-server.ts`
- `routedev/desktop/main/remote/router.ts`
- `routedev/desktop/main/remote/sse-session.ts`
- `routedev/desktop/main/index.ts`
- 集成测试

工作：

- 使用 Node 标准 HTTP 能力实现 REST 和 SSE。
- 强制 loopback 绑定。
- 实现认证、限流、请求体上限、错误映射和优雅关闭。
- SSE 支持心跳、`Last-Event-ID` 和慢消费者背压。

验收：

- 非 loopback 配置启动失败。
- 慢客户端不会阻塞 RouteDevEngine。
- 断线重连只补发缺失事件。
- Electron 退出时连接和 server 正常关闭。

依赖：Task 2、Task 3、Task 4。

### Task 6：桌面远程设置与设备管理

涉及文件：

- `routedev/desktop/renderer/src/components/settings/SettingsRemoteTab.tsx`
- `routedev/desktop/renderer/src/components/settings/RemotePairingDialog.tsx`
- `routedev/desktop/shared/ipc-types.ts`
- `routedev/desktop/preload/index.ts`
- `routedev/desktop/main/bridges/remote-bridge.ts`

工作：

- Gateway 开关、端口、Tailscale Serve 状态、配对二维码、设备列表、scope 和撤销。
- 通俗说明“电脑必须在线”“手机必须加入同一 tailnet”“无云中继时通知依赖前台服务”。
- 不允许设置 `0.0.0.0`。

验收：

- 新用户能在设置页完成从开启到二维码配对。
- 撤销设备后现有 SSE 在合理时间内断开。

依赖：Task 4、Task 5。

### Task 7：创建 Android 工程骨架与质量门

涉及文件：

- `routedev-android/settings.gradle.kts`
- `routedev-android/build.gradle.kts`
- `routedev-android/gradle/libs.versions.toml`
- `routedev-android/app/build.gradle.kts`
- 基础 Compose、lint、单测配置

工作：

- 建立分层包结构：`data`、`domain`、`ui`、`service`、`security`。
- 配置 debug/release、静态检查、单元测试和 instrumentation 测试。
- 禁止在 BuildConfig、资源或仓库中写死 token。

验收：

- `assembleDebug`、lint 和单测通过。

依赖：Task 1。

### Task 8：Android 配对、凭据和 API 客户端

涉及文件：

- `data/remote/RouteDevApi.kt`
- `data/remote/SseClient.kt`
- `security/DeviceCredentialStore.kt`
- `data/repository/ConnectionRepository.kt`
- 对应测试

工作：

- QR/手动配对。
- Keystore 支持的 token 加密存储。
- REST 错误码映射、超时、重试和证书验证。
- SSE 断线续传、心跳检测和指数退避。

验收：

- token 不进入日志、崩溃信息、Room 和备份。
- 网络超时不会重复发消息。
- 撤销设备后回到配对页。

依赖：Task 4、Task 5、Task 7。

### Task 9：Android 本地数据库与离线恢复

涉及文件：

- `data/local/RouteDevDatabase.kt`
- session/event/pending-message entities 与 DAO
- repository 测试

工作：

- 保存 session、timeline、cursor 和待发送消息。
- 使用事务处理 event 去重和 cursor 更新。
- 清理过期 timeline，保留当前任务和最近任务。

验收：

- 应用重启后能恢复最后时间线。
- 重复事件不产生重复卡片。
- sequence 缺口会触发补拉而不是静默跳过。

依赖：Task 7、Task 8。

### Task 10：首页、对话页和真实时间线

涉及文件：

- `ui/home/*`
- `ui/chat/*`
- `ui/components/timeline/*`
- Compose UI 测试

工作：

- 实现首页、创建对话、对话时间线和输入区。
- reasoning、工具、进度、待办按 sequence 混排。
- 待办采用最新完整快照替换，不累积旧计划。
- 处理 loading、空态、离线、失败和重试。

验收：

- 参考 Codex 紧凑工作台，不出现三套重复任务列表。
- 字号和间距使用统一 design tokens。
- 长工具输出不会撑坏布局。

依赖：Task 9。

### Task 11：Skill、MCP、工具范围与审批

涉及文件：

- `ui/composer/CapabilityPicker.kt`
- `ui/approval/*`
- `domain/SendMessageUseCase.kt`
- 服务端范围验证测试

工作：

- 获取并选择 Skill、MCP 和工具范围。
- 显示审批请求并按设备 scope 处理。
- 默认不允许 Android 改 MCP 凭据或安装远程能力。

验收：

- UI 选择与服务端实际工具定义一致。
- 伪造 id、过期审批和无 scope 审批都失败。

依赖：Task 3、Task 8、Task 10。

### Task 12：前台连接服务与完成通知

涉及文件：

- `service/TaskConnectionService.kt`
- `notification/NotificationCoordinator.kt`
- `AndroidManifest.xml`
- 通知测试

工作：

- 用户显式启用后启动前台服务保持 SSE。
- 创建连接、完成、失败、等待审批通知渠道。
- 点击通知进入正确 session/turn。
- App 前台去重通知。

验收：

- 屏幕关闭时完成事件仍产生通知。
- 服务被系统回收后按平台允许方式恢复。
- UI 明确说明 force-stop 后不保证即时通知。

依赖：Task 8、Task 9。

### Task 13：Tailscale Serve 引导和端到端测试

涉及文件：

- 两个工程的 README/帮助页
- `routedev/tests/e2e/remote-gateway.e2e.test.ts`
- Android mock server 与 instrumentation 测试

工作：

- 给出 Tailscale 安装、登录、MagicDNS/HTTPS 和 Serve 配置步骤。
- 自动检测但不静默修改系统配置。
- 覆盖配对、新建任务、流式消息、工具、待办、审批、完成通知和断线续传。

验收：

- Windows 电脑与真实 Android 设备在不同网络下通过同一 tailnet 工作。
- 电脑离线、Tailscale 断开和 token 撤销均有可理解状态。

依赖：Task 5、Task 6、Task 12。

### Task 14：发布构建与交付

涉及产物：

- RouteDev Windows portable
- Android debug APK
- Android release APK 或 AAB
- 协议版本说明
- 安全限制说明
- 测试报告

验证命令：

- RouteDev typecheck
- RouteDev 远程协议、Gateway、ChatBridge 和现有桌面测试
- RouteDev production build
- RouteDev portable 打包
- Android unit test
- Android lint
- Android assembleDebug
- Android connected test，在有设备或 emulator 时

验收：

- 不允许仅因单元测试通过就宣布完成。
- portable 能直接启动，Android APK 能安装、配对并完成真实任务。
- 最终报告列出未运行的设备级测试及原因。

依赖：全部前置任务。

## 9. 关键依赖关系

- 协议先于服务端和 Android。
- 事件顺序模型先于 SSE 和时间线 UI。
- 服务端能力收窄先于 Android Capability Picker。
- 配对与 scope 先于任何远程命令。
- 本地数据库先于完整 UI 和通知。
- 端到端测试先于发布构建。

禁止把 Task 10 的漂亮 UI 提前当作可用产品；在 Task 2、4、5 未完成前，客户端仍没有可靠事件与安全边界。

## 10. 完成定义

只有同时满足以下条件才能将 `/goal` 标记为完成：

- 手机通过 Tailscale HTTPS 配对电脑。
- 手机能看到最近任务、新建会话、发送消息和停止任务。
- 模型文本、真实进度、reasoning、工具调用、待办和结果按 sequence 正确交错。
- 本轮 Skill/MCP/工具范围能选择且服务端严格收窄。
- 远程审批遵循设备 scope。
- 断线后无重复、无乱序地恢复时间线。
- 任务完成能在前台连接服务存活时产生系统通知。
- token 撤销立即生效，敏感信息不进日志和数据库。
- RouteDev 现有桌面功能没有回归。
- RouteDev portable 与 Android APK 均成功构建并经过一次真实设备或 emulator 冒烟测试。

