# RouteDev 竞品源码级横评 II：工程质量、架构模式与项目治理

> 日期：2026-08-05
> 方法：全部结论来自本地 clone（`%TEMP%\repos\`）的真实源码精读，每个机制带 `文件:行号` 证据；不依赖 README 宣传。
> 范围：本文件与《RouteDev-Harness-借鉴优先级与DeepSeekV4FlashGA执行计划-2026-08-04.md》**相互独立**。旧文件已进入实施（B-00 基线已开），本文件**不新增、不修改任何 B-xx 任务**，只回答三个旧文件未覆盖的问题：
> 1. 还有哪些活跃且优秀的同类项目（第二轮：gemini-cli / pi / codex / OpenHands / cline / agents-cli / CoreCoder；第三轮补：qwen-code / CodeWhale / jcode 工程质量维度 + 两个逆向教学仓库）；
> 2. 这些项目在**工程质量、架构模式、项目治理**三个维度上做对了什么、做错了什么；
> 3. RouteDev 可以不依赖任何功能级借鉴、直接吸收的**可执行检查项**（§7 CHECK-01~16 + §8 CHECK-20~22 + §9 CHECK-17~19，共 22 项）。
>
> 第三轮扩展（2026-08-05 下午）：按用户要求放开主题限制——凡是比旧计划做得更好的内容都写进来。§8 补 qwen-code/CodeWhale/jcode 的工程质量深挖（旧计划只取了功能证据）；§9 把 claude-code-from-scratch / how-claude-code-works 两个逆向教学仓库的经验落地为检查项。

---

## 0. 新项目一览（2026-08-05 GitHub 实测）

| 项目 | ⭐ | 语言 | 仓库规模 | 活跃度 | 一句话定性（源码） |
|---|---|---|---|---|---|
| google-gemini/gemini-cli | 106k | TS | ~50 万行 / 1,576 文件 | 今日推送（0.55.0-nightly） | Google 官方：自研引擎（非 SDK 薄封装），scheduler 状态机 + 三总线 + 双循环实现 |
| openai/codex | 104k | Rust | ~129 万行 / 100+ crate | 今日推送 | 「核心引擎 + app-server daemon + 多前端」的进程边界范本 |
| earendil-works/pi | 83.7k | TS | ~11.4 万行 / 9 包 | 今日推送（0.83.0） | 「薄内核 + 厚扩展」：30 事件扩展 API，little-coder 的底座 |
| OpenHands/OpenHands | 83k | TS + Python | 客户端 1.4 万行（Agent Canvas） | 今日推送（1.9.0） | 瘦客户端 + 远程 agent-server：事件流状态一致性工程 |
| cline/cline | 65.7k | TS | SDK 17 万行 + 多宿主 | 今日推送（4.1.3） | 内核外置（Kernel-as-SDK）：`@cline/agents` + RuntimeHost 多宿主 |
| google/agents-cli | 5.5k | Python | 4,758 行 CLI + skills | 2026-08-04 | Google ADK 的 agent **开发/评测/部署** CLI（非 harness） |
| he-yufeng/CoreCoder | 1.6k | Python | 1,281 行 | 2026-08-04 | ~1000 行极简 agent 循环 + 三层压缩（教学范本） |

**状态更新（延续上一轮核验）**：`google-gemini/gemini-cli` 是旧计划 24 个项目的最大遗漏——106k⭐ 的 Google 官方开源编码 agent，旧文件完全未覆盖；OpenHands 主仓库已重构为纯前端 Agent Canvas（Python 内核拆到 `OpenHands/software-agent-sdk` 外部仓库）。

---

## 1. 七个项目逐项深挖

### 1.1 google-gemini/gemini-cli（106k⭐，Google 官方）

**架构定性**：npm workspaces monorepo（core 31.5 万行 / cli 17 万行 / a2a-server 等）。不是 `@google/genai` SDK 的薄封装，而是在 SDK 之上自建了完整分层引擎：`GeminiChat`（会话）→ `Turn`（流事件翻译，17 种 GeminiEventType）→ `Scheduler`（工具编排状态机）→ `PolicyEngine`（策略）→ `SandboxManager`（三平台沙箱）。**关键决策：核心会话类 `GeminiChat` 是从 js-genai 复制的改写版**（geminiChat.ts:7-8 自述「copied version ... with the intention of working around a key bug」）。

**工程质量（源码取证）**：
- 测试：960 个测试文件、13,568 用例；分层 = vitest 单测 → integration-tests 录制回放（`.responses` 夹具，真实 CLI 二进制离线可跑）→ 沙箱矩阵（none/docker/podman）→ evals（37 个，`RUN_EVALS=1` 连真实 Gemini）→ memory/perf 基线（baselines.json）。**盲区：CI 中 `--coverage.enabled=false`（ci.yml:193），无覆盖率门禁；Windows 沙箱主体是 C#（`GeminiSandbox.cs`），游离于 vitest 体系外**。
- 错误分类是产品级：~30 类 `ToolErrorType` + `FatalError` 语义 exit code（41 认证/44 沙箱/52 配置/53 轮次/54 工具）+ 9 类 `InvalidStreamError` 驱动「重试 vs 引导模型 vs 放弃」三档决策（geminiChat.ts:1404-1459）。
- CI：46 个 workflow，含 `agent-session-drift-check.yml`（**官方承认 legacy 与 AgentSession 双循环实现存在，需 CI 检测漂移**）、`evals-nightly`、`memory-nightly`、`perf-nightly`。
- 遥测默认关闭（`telemetry?.enabled ?? false`，config.ts:1085）。

**架构模式**：
- 工具编排显式状态机：`Validating → Scheduled → Executing → AwaitingApproval → Success/Error/Cancelled`（scheduler/types.ts:26-34）；策略检查挂在 Validating 阶段（scheduler.ts:648-675）。
- 三条事件总线并存：`coreEvents`（跨层解耦）+ `MessageBus`（工具确认域）+ context 图内 eventBus——职责重叠，是架构瑕疵。
- 依赖注入：构造器注入为主，但 `Config` 是 **4,185 行上帝对象**（config.ts），所有服务都从 `context.config` 拉取。

**不足（按严重度）**：
1. 【高】SDK 复刻 fork drift：GeminiChat 1,660 行副本 + `ensureActiveLoopHasThoughtSignatures`（:1094）/`stripToolCallIdPrefixes`（:1583）等打补丁式 hack，SDK 升级不自动获得修复
2. 【高】legacy/AgentSession 双循环并存（官方 CI drift-check 佐证）
3. 【中】`scheduler.ts:552` 用 10ms 忙轮询等待外部事件而非事件通知
4. 【中】`isClientInitiated` 的 ASK_USER 直接降级 ALLOW（policy.ts:79-88）——安全边界依赖调用方诚实
5. 【中】YOLO 模式无匹配规则即 ALLOW（policy-engine.ts:636-638）；沙箱禁用时 `NoopSandboxManager` 裸执行（shell-utils.ts:56,899）
6. 【低-中】确认总线无人响应兜底 `confirmed: false`（scheduler.ts:170-179）——行为正确但错误信息易误导

### 1.2 openai/codex（104k⭐，OpenAI 官方，Rust）

**架构定性**：「核心引擎 + 协议层 + 多前端」。`codex-rs/core`（agent 引擎，30.2 万行）→ `codex_protocol`（类型枢纽）→ `codex-app-server`（常驻 daemon，JSON-RPC over WebSocket/UDS，13 万行）→ tui/exec 全部是 app-server 的**客户端**。权限与沙箱是独立平台 crate（linux-sandbox / windows-sandbox-rs / sandboxing 抽象）。

**工程质量（源码取证）**：
- 测试：全 workspace **12,776 个 `#[test]`**，三层结构（crate 内单测 + `core/tests/all.rs` 聚合 118 个集成测试模块 + CLI e2e）；`TestCodexBuilder` + mock HTTP SSE 让端到端 turn 在 CI 上离线复现；集成测试跑**真实 exec/沙箱**。
- 遥测文化最成熟：工具决策处记录 `ToolDecisionSource::{Config, AutomatedReviewer, User}`（approvals.rs:257-272）、沙箱 outcome（orchestrator.rs）、guardian 审查、subagent 启动全部打点。
- 门禁：clippy `-D warnings`、`#![deny(clippy::print_stdout)]`、cargo-deny 供应链、5 平台 nextest 矩阵、发布 tag 与版本强绑定（rust-release.yml 校验 tag 与 Cargo.toml 一致）。
- 错误处理：thiserror 域错误枚举（`CodexErrorDetails`，protocol/error.rs:81-121）+ 顶层 anyhow；中断路径显式建模（Ctrl-C 杀进程组 → 向模型返回 128+9 退出码，exec.rs:1063-1067）。

**架构模式**：
- **进程边界**：UI 永远不触碰 core 内部（`pub(crate) mod session`，lib.rs:17）；TUI → app-server-client → daemon → ThreadManager。事件走无界 async_channel，app-server 做连接多路复用。
- 工具面抽象：`ToolRuntime<Rq, Out>` 泛型 trait，shell/apply_patch/MCP 共用同一「审批-沙箱-遥测」编排（orchestrator.rs:41-44）——**工具实现者不碰审批逻辑**。
- 策略引擎 DSL：`$CODEX_HOME/execpolicy` 下的 **Starlark 规则文件**（exec_policy.rs:446），程序内只保留 `Decision::{Forbidden, Prompt, Allow}` 三值。
- 持久化：rollout 事件追加写（thread-store），可重建会话（resume/fork/审计免费）。

**不足（按严重度）**：
1. 【高】**Windows 默认无沙箱**（windows_sandbox_level 未配置 = Disabled，config/mod.rs:3409）；Linux bwrap 缺失时 `unwrap_or(SandboxType::None)` 静默降级（manager.rs:281）——**沙箱失败 fail-open 而非 fail-closed**
2. 【高】无限制 FS 权限 = 不启沙箱（policy_transforms.rs:531-535）
3. 【高】execpolicy Allow 规则命中时**绕过沙箱且不再问审批**（exec_policy.rs:406-413）
4. 【高】apply_patch 外部路径跳过权限匹配（apply_patch.rs:308-315，依赖「平台沙箱兜底」，与 1/2 叠加即无防护）
5. 【中】token 记账用 `len/4` 字节粗估（truncate.rs:71-73），中文场景误差数倍
6. 【中】session 级审批缓存 key 不含 cwd（shell.rs:129-137）——同命令不同目录复用跳过审批
7. 【中】mid-turn 压缩无迭代上限（turn.rs:433 注释自认）

### 1.3 earendil-works/pi（83.7k⭐，little-coder 底座）

**架构定性**：「三明治分层」monorepo：pi-ai（LLM 协议层 2.2 万行）→ pi-agent-core（通用内核 9,735 行）→ pi-coding-agent（编码壳 5.8 万行，含扩展系统/会话树/7 内置工具），另有 pi-tui（零依赖渲染库）、RPC 三件套（protocol/client/server）与 pi-evals。**核心是 30 个生命周期事件的扩展 API**——little-coder 的全部机制都挂在这层 API 上。

**工程质量（源码取证）**：
- 测试：409 个测试文件 / 10.2 万行测试代码；**回归测试按 issue 编号存档**（`test/suite/regressions/1717-2113-*.test.ts` 等）。
- 质量闸门（`npm run check`）：biome + **pinned-deps（强制精确版本号，禁 range/file:/git:）** + ts-imports（强制跨包用包名）+ shrinkwrap + `tsgo --noEmit` + browser-smoke；CI 10 个 workflow。
- 依赖方向**单行无环**（tui 对内核零依赖）；全包锁步版本 + 三层兼容垫（compat.ts / legacy-api-aliases / 旧包名虚拟模块）。
- 类型安全：TypeBox（非 zod）+ 「erasable TypeScript」规范（禁 enum/namespace/参数属性）。

**架构模式**：
- **薄内核 + 厚扩展**：内核只做消息循环与事件转发（agent-loop.ts 792 行），所有产品能力（工具/命令/UI/provider/压缩自供）经扩展 API 注入；30 个事件中 11 个可返回「结果对象」（改写/阻断/取消）。
- 双层事件：低层 AgentEvent 10 个（稳定通用）+ 扩展层 ExtensionEvent 30 个（产品化），中间由 AgentSession 钩子接线——同一循环两套命名。
- 三队列注入模型：steer（轮内）/followUp（停止后）/nextTurn（下轮）——「流式中用户/扩展持续输入」的标准解法。
- 压缩协议留给扩展：`session_before_compact` 可取消、可自供摘要；`session_compact` 通知（可插拔压缩协议）。

**不足**：
1. 【高】**无内置权限系统**（README.md:39 官方明示），安全责任外包给第三方沙箱扩展；项目信任是唯一二值闸门（project-trust.ts:53-92）
2. 【高】`tool_call` 事件改参后**不重新校验**（types.ts:901-902）——扩展可注入绕过 schema 的参数
3. 【中】AgentHarness 与 coding-agent 双轨重复实现（两套 compaction/skills/system-prompt/tools）
4. 【中】token 估算 `chars/4` 粗估（compaction.ts:266-291）；单文件巨型化（agent-session.ts 3,337 行）
5. 【低】`process.emitWarning = () => {}` 启动即静默所有进程警告（cli.ts:12）

### 1.4 OpenHands/OpenHands（83k⭐，Agent Canvas）

**重要前置**：当前主仓库已重构为**纯前端**（`@openhands/agent-canvas`，TS/React/Electron，业务代码仅 1.4 万行）；Python agent 内核（EventStream/DockerRuntime/condenser/SWE-bench harness）已拆到外部仓库 `OpenHands/software-agent-sdk`。以下取证均为本仓库内可验证的**客户端侧**实现 + 服务端协议契约。

**工程质量（源码取证）**：
- 测试：554 个 vitest 文件 + **Stryker 变异测试**配置（开源前端少见）+ 19 个 Playwright e2e 分三套（mock-llm 确定性轨迹 / mock-llm-docker / live 真实模型，仅 label 触发）。
- **确定性 e2e 是亮点**：`tests/e2e/mock-llm/scripts/mock-llm-server.py` 用 `TestLLM` 按脚本化轨迹驱动真实 agent 循环——不依赖真实模型、确定性断言。
- 架构守门测试：`no-direct-agent-server-calls.test.ts` 用静态正则禁止绕过统一 typed client（白名单仅 3 文件）。
- CI 19 个 workflow：`sdk-version-sync.yml` 跨仓库版本一致性检查、pr-description-check、release-please、trusted publishing + provenance。
- 弱点：单元测试无覆盖率门槛；`docs/TESTING_MATRIX.md` 人工矩阵大量单元格未勾选。

**架构模式**：
- **服务器权威事件流 + 客户端纯投影**：`addEvent → dedup(Set) → sort(timestamp) → handleEventForUI`（use-event-store.ts:92-146）；历史 REST 分页 + 增量 WebSocket `resend_mode=since` 锚定（context:855-864）；重放事件跳过副作用（context:480-492）——状态一致性的完整配套。
- 双通道混合（REST 历史 + WS 增量 + bash 独立 socket）；上行消息也是「事件」（`SendMessageRequest` 带 `run:true`）。
- 压缩是**可见事件**：`CondensationEvent { forgotten_event_ids, summary_offset }`，token 记账分 agent/condenser 两组件（conversation-state-event.ts:46-56）——可审计设计。

**不足**：
1. 【高】本地模式**无沙箱**（docs/architecture.md:51「The agent has host filesystem access」），仅文档警告
2. 【高】双事件类型系统漂移（legacy `action-type.tsx` 30 文件引用 vs v1 `types/agent-server` 84 文件引用）
3. 【高】Electron 首启必须 `uvx` 从 PyPI 下载 Python agent-server（可达 10 分钟，失败即无法启动）；端口 8000/18000/18001 硬编码
4. 【高】客户端持有 LLM secrets（明文经会话创建请求传给服务端）
5. 【中】cloud/local 每服务手写双分支 + 云分页降级 hack

### 1.5 cline/cline（65.7k⭐，Kernel-as-SDK 范本）

**架构定性**：已重构为 **Bun monorepo**：`@cline/agents`（通用 AgentRuntime 主循环，4,819 行）+ `@cline/core`（会话编排/工具/压缩/checkpoint/遥测，14.5 万行）+ `@cline/llms`（模型目录）+ `@cline/shared`（跨包契约）。VS Code 扩展只是宿主之一（薄适配层 SdkController 2,111 行），另有 CLI、cline-hub daemon、JetBrains。**内核完全无 VS Code 依赖**。

**工程质量（源码取证）**：
- 测试：660 个测试文件（core 151 / vscode 224 / cli 147…）；核心机制（压缩/checkpoint/FileContextTracker）均有专测；CI 双 OS 矩阵（Windows 只跑 SDK）。
- 防御性细节：工具结果截断在 executor 层（48k 字符）与消息构建层（8k/6MB 兜底）各做一次；「截断通知保留在头尾，避免被二次截断吃掉」（output-limits.ts:12-14）；有副作用工具不自动重试（run_commands `retryable:false`）。
- 遥测不含用户提示词/文件内容（core-events.ts:429-494），PostHog + OpenTelemetry 双 provider，隐私开关在事件入口统一拦截。

**架构模式**：
- **三个回调把宿主策略注入内核**：`prepareTurn`（压缩）/`requestToolApproval`（审批）/`consumePendingUserMessage`（插话）——内核零 UI 耦合，CLI/桌面/远程复用同一内核。
- 事件带快照：`emit({type, snapshot, ...增量})`，UI 既能全量重建也能局部更新。
- webview 通信用 **gRPC-over-postMessage**（19 个 proto service）替代字符串消息总线。
- 审批三层分离：`toolPolicies`（默认 autoApprove）→ 回调 → 宿主弹窗；SDK 侧强制 `autoApprove:false` + 回调实时评估 UI 设置。

**不足**：
1. 【高】YOLO 模式全工具自动批准（presets.ts:141-158 `"*": {autoApprove:true}`）
2. 【中】桌面审批是**明文文件轮询**（tool-approval.ts:38-104，200ms 轮询、5 分钟超时，同机进程可写 decision 文件冒充批准，无签名）
3. 【中】checkpoint 依赖 git 且会触碰用户索引（GIT_INDEX_FILE 隔离 + 合成第三父提交）；非 git 工作区恢复能力退化
4. 【中】`checkpointRestore.ts:6-23` **静默空操作**（controller.restoreCheckpoint 不存在时返回 Empty 无错误）
5. 【中】溢出恢复用 JSON 长度当 token 代理（agent-runtime.ts:1426-1429，自认 coarse proxy）
6. 【中】Plan 模式命令守卫是黑名单（command-guard.ts:19-22 自认拦不住 `python -c "open(...,'w')"`）
7. 【低】`@cline/agents` 仅 2 个测试文件（核心循环单测集中在 2,457 行单文件）

### 1.6 google/agents-cli（5.5k⭐，Google ADK CLI）

**定性**：不是编码 harness，而是 agent **开发工作流 CLI**：`auth` / `deploy` / `dev`（install/lint/playground）/ `eval` / `infra`（CICD/datastore）/ `publish` 全链路命令（src/google/agents/cli/ 各 cmd_*.py）。

**价值点（工程质量维度）**：其 eval 子系统是最完整的 agent 评测工程参考：
- `eval generate`：合成多轮轨迹（user simulation，`_synthesize_runner.py` 368 行）
- `eval grade`：按 metric 给轨迹打分；`eval metric` 可发现/管理指标
- `eval compare`：两个评测结果 JSON 递归 diff，数值带 delta（`+0.07/-0.03`，cmd_compare.py:44-66）
- `eval optimize`：**GEPA 框架优化 agent prompts**（optimization_config.json + train/validation 数据集拆分，cmd_optimize.py:1-50）
- `eval run`：generate + grade 链式一条命令

**不足**：绑定 Google Cloud/ADK 生态（Vertex AI 部署路径、GCP infra 命令），本地/自托管场景复用度低；无 agent 循环实现（本身不执行 agent）。

### 1.7 he-yufeng/CoreCoder（1.6k⭐，~1,000 行 Python 极简实现）

**价值点**：150 行 agent 循环（agent.py）是「最小正确实现」的教学范本：
- 循环：`user → LLM(tools) → tool_calls? → 执行（单/并行）→ 循环 → 纯文本回复结束`（agent.py:54-99）；max_rounds=50
- **Ctrl+C 中断时回填 `[interrupted]` 工具回复**（`_answer_pending_tool_calls`，agent.py:132-146）——与 crush「孤儿 tool_use 自愈」同一问题域，极简实现也在处理
- 参数校验先于执行（`inspect.signature.bind`，agent.py:108-111）防 TypeError 误标
- 三层压缩（context.py:41-43）：**50% snip 工具输出为一行摘要 → 70% LLM 摘要（keep_recent=8）→ 90% 硬折叠**——四档阈值分类的又一实现
- 子 agent 通过 `AgentTool._parent_agent` 注入（agent.py:39-41）

**不足**：无权限系统（bash.py 裸执行）、无持久化、无事件模型——定位是教学/原型，非产品。

---

## 2. 横向对比一：架构模式

| 模式 | gemini-cli | codex | pi | OpenHands | cline | RouteDev 现状 |
|---|---|---|---|---|---|---|
| 内核/UI 分离 | core 纯引擎 + AgentProtocol 事件流 | **进程级**：UI 是 daemon 的 RPC 客户端 | 包级分离 + RPC 三件套 | 客户端纯投影，服务端权威 | **Kernel-as-SDK**：多宿主同等 | NativeAgentKernel 已分离（B-12 一致性待验证） |
| 工具编排状态机 | scheduler 六态 + 策略挂 Validating | orchestrator 泛型 trait + 审批-沙箱-遥测统一编排 | 低层钩子 + 扩展事件拦截 | 服务端实现（契约可见） | prepareToolExecution + 策略回调 | 工具执行分散（旧计划 B-01 已覆盖 schema 面） |
| 审批位置 | Validating 阶段集中 | 编排层集中 | 事件层（可绕过，改参不重校验） | 服务端安全分析器 | 策略+回调，双层 | PermissionEngine 集中（领先） |
| 事件流 | 三总线并存（瑕疵） | 无界 channel + 双协议 | 双层事件（10+30） | **单权威流 + REST/WS 双通道 + 幂等合并** | 类型化事件 + snapshot | EngineEventV1 单总线（领先） |
| 依赖注入 | Config 上帝对象（4,185 行） | 构造器 + trait 边界 | 扩展 API 注入 | 静态类 + React Context | 回调注入三件套 | 构造器注入 |
| 状态持久化 | 会话录制文件 | rollout 事件日志（可重建） | JSONL 会话树（fork 支持） | 服务端事件存储 | sqlite + 轮边界落盘（有洞） | TurnSnapshot 联合回滚 |
| 可测试性核心 | mock ContentGenerator | TestCodexBuilder + mock SSE | vitest alias 免构建 | mock-llm 轨迹 e2e | 纯函数抽离 + 行为测试 | 待 B-00 基线 |

**模式结论（三句话）**：
1. **行业共识是「内核独立 + 事件流接口 + 宿主只做投影」**——gemini-cli/codex/OpenHands/cline 四个头部项目不约而同，RouteDev 的 NativeAgentKernel 方向正确且已具雏形；差距只在「事件先持久化再消费」和「宿主走统一 RPC 通道」两点（见 §5）。
2. **审批/沙箱/遥测必须收敛到一个编排层**（codex orchestrator、gemini-cli scheduler、cline 策略回调），散落在工具内部的三家都出过绕过漏洞（codex apply_patch 外部路径、pi 改参不重校验、gemini-cli isClientInitiated 降级）。
3. **双实现/双类型系统是头部项目共同的债**（gemini-cli legacy/session drift-check、OpenHands 双事件类型、pi harness/agent 双轨）——任何「新协议」都应走适配器复用同一内核，不另起一套。

## 3. 横向对比二：工程质量

| 维度 | gemini-cli | codex | pi | OpenHands | cline | 可移植到 RouteDev |
|---|---|---|---|---|---|---|
| 测试规模 | 13,568 用例 | 12,776 `#[test]` | 409 文件 / 10.2 万行 | 554 文件 + 变异测试 | 660 文件 | 规模不是目标，分层结构是 |
| 离线端到端 | `.responses` 录制回放 | mock SSE 服务器 | vitest alias 直连源码 | **mock-LLM 脚本化轨迹** | 行为级 e2e | **✓ mock LLM 轨迹层（成本最低收益最高）** |
| CI 覆盖率门禁 | ✗ 关闭（反面教材） | 部分 | 无明确门禁 | ✗ 无门槛 | 无门槛 | **✓ 尽早开（至少策略引擎/错误分类）** |
| 遥测 | 默认关 + 全链路事件化 | 决策点埋点（decision source） | — | consent 先行 + 类型化捕获 | 元数据不收集内容 | **✓ decision source 是审计核心** |
| 错误分类 | ~30 类 ToolErrorType + 语义 exit code | CodexErrorDetails + 中断建模 | — | — | ProviderErrorClass 驱动恢复 | **✓ 「可重试/内容问题/致命」三档** |
| 依赖治理 | — | cargo-deny | pinned-deps + shrinkwrap + ts-imports | sdk-version-sync 跨仓 | bun monorepo + biome | **✓ pinned-deps + 依赖方向守门** |
| 发布 | nightly + patch 机器人 | tag 与版本强绑定 + 平台签名 | 锁步版本 + prepublishOnly | release-please + provenance | 脚本驱动 tag + 三线独立版本 | ✓ 已有 R-03 CI 基础 |
| 评测体系 | 37 evals（需真实 API） | — | 仅 4 个 eval 文件 | mock-llm 确定性 + live label | — | agents-cli 的 generate/grade/compare/optimize 四段链是唯一完整参照 |

## 4. 横向对比三：上下文管理实现分类学（6 种已见实现）

| 方案 | 代表 | 触发 | 策略 | 证据 |
|---|---|---|---|---|
| 摘要即截断 | crush | 剩余 token ≤ 阈值（大窗口 20k buffer，小窗口 20%） | 摘要消息替换历史，后续从摘要点开始 | agent.go:1693-1713 |
| 保留窗口 + 结构化摘要 | grok-cli | `tokens > window - reserve`（16k） | keepRecent 20k + Goal/Progress/Decisions 摘要；重试减半 keep（min 4k） | compaction.ts:247-252, 345 |
| 三层阈值 | CoreCoder | 50% / 70% / 90% | snip 工具输出 → LLM 摘要(keep 8) → 硬折叠 | context.py:41-43 |
| 压缩协议可插拔 | pi | 阈值 + overflow 重试一次 | `session_before_compact` 可取消/自供摘要 | agent-session.ts:1951-2226 |
| 压缩事件化 + 双组件记账 | OpenHands | 服务端 condenser | `CondensationEvent{forgotten_ids, offset}` + agent/condenser 分开计费 | condensation-event.ts:5-46 |
| 压缩专用小模型 + 六态结果 | gemini-cli | 历史 > 50% 上限，保留 30% | 独立压缩模型；COMPRESSED/FAILED_INFLATED/FAILED_EMPTY/NOOP/CONTENT_TRUNCATED 六态 | chatCompressionService.ts:41-100, turn.ts:183-201 |

**共同弱点（4/6 家）**：token 估算全是字符级粗估（`len/4`、`chars/4`、`chars/3.5`），无一家接真实 tokenizer——对 CJK/代码场景系统性偏差。这是 RouteDev 可以差异化的小点（Flash 本身有真实 tokenizer 可复用）。

## 5. 横向对比四：权限模型实现分类学（7 种已见实现）

| 方案 | 代表 | 判定基础 | 已知绕过（源码证据） |
|---|---|---|---|
| 无审批/无门禁 | smolagents、grok-cli（仅 paid_request 需审批）、pi（官方明示无） | — | 全部命令裸执行 |
| 字符串前缀白名单 | crush safeCommands、little-coder permission-gate | `strings.HasPrefix` / `segment.startsWith` | `timeout 5 rm -rf /`、`env bash -c 'curl\|bash'`、`find -exec rm`、`sed -i`、`python -c`、引号内重定向 |
| 字符串黑名单 | crush CommandsBlocker、cline command-guard | args[0] 精确匹配 | shebang 脚本、`/usr/bin/curl`、大小写变体、`python -c "open(...,'w')"` |
| 工具级审批（无命令级） | cline toolPolicies、Kun approvalPolicy | 工具名 + autoApprove | YOLO 全批；「始终允许 bash」后任意命令免审 |
| 策略 DSL 三值 | codex execpolicy（Starlark） | `Decision::{Forbidden,Prompt,Allow}` | Allow 规则命中即绕过沙箱且不再问审批；无限制 FS 权限 = 不启沙箱 |
| 策略 + 沙箱 + 兜底拒绝 | gemini-cli policy + sandboxManager | ALLOW/DENY/ASK_USER + 模式排序 | YOLO 无匹配即 ALLOW；isClientInitiated 降级；NoopSandboxManager |
| 快照化授权 + 物理校验 | Kun Graph worker | allowed 列表只收窄 + inode/dev/nlink + 二次 symlink | Direct 子代理无 networkAllowed（与 Graph 分叉） |

**横向结论**：**没有任何一家把「命令级语义安全」做对**——基于字符串的实现全被绕过，基于策略 DSL 的实现又把「允许」与「无沙箱」绑在一起。RouteDev 的 PermissionEngine（工具级 + deny 优先 + shell 语义回归）已在旧计划 B-08 覆盖测试面；本文件补充的教训是：**「allow」必须与「沙箱/审计等级」解耦**（codex 的 bypass_sandbox 是反例），且 **ACL 不可用必须 fail-closed**（三家 fail-open 的教训）。

## 6. 横向对比五：项目治理与许可

| 项目 | 许可 | 治理结构 | 上游依赖策略 | 可持续性判断 |
|---|---|---|---|---|
| gemini-cli | Apache-2.0 | Google 官方 + nightly 发布 + patch 机器人 | 复刻 SDK 改写出 fork drift（高维护债） | 强（公司背书），但 SDK 复刻是长期风险 |
| codex | Apache-2.0 | OpenAI 官方 + tag 强校验 + 平台签名 | cargo-deny + Cargo.lock | 强；双构建系统（Bazel+Cargo）是内部债 |
| pi | MIT | 单作者（badlogic）+ 社区 | 锁步版本 + 三层兼容垫 | 中；扩展 API 有 45 处 Breaking Changes 史 |
| OpenHands | MIT | 基金会化 + 跨仓库 SDK 版本同步 | typed client + 守门测试 | 强；Python 内核外置后前端迭代快 |
| cline | Apache-2.0 | 核心团队 + 多宿主 | bun workspace 内控 | 强；品牌/包名错位（claude-dev）是小瑕疵 |
| agents-cli | Apache-2.0 | Google 官方 | ADK 生态绑定 | 中（非 harness，定位不同） |
| CoreCoder | MIT | 单作者 | litellm | 教学定位，不评 |

**对照第一轮**：cc-haha（无 license + Anthropic 专有源码 fork）与 Kun（PolyForm-Noncommercial）仍是**不可代码复用**的两家；本轮 7 家全部宽松许可（Apache-2.0/MIT），可合法借鉴实现思想。

## 7. 可执行检查项（CHECK-01 ~ CHECK-16，供实施旧计划时会话直接引用）

> 使用方式：每项独立可验收，验收标准是「能跑的具体测试/命令」，不是文档承诺。实施旧计划（B-00~B-19）的会话遇到对应任务时，把标有「挂靠」的检查项直接并入该任务验收；未挂靠的检查项可独立排期。**本清单不新增 B-xx 任务，只把横评结论转成可执行形式。**

### A 组：测试与可观测性（低-中成本，优先做）

| ID | 目标 | 来源证据 | 验收标准（可跑） | 挂靠 |
|---|---|---|---|---|
| CHECK-01 | 确定性 mock-LLM 轨迹测试层 | OpenHands `mock-llm-server.py`（TestLLM 脚本化轨迹驱动真实循环）；codex `TestCodexBuilder` + mock SSE | `tests/evals/fake-llm/` 下有一台 fake LLM server；用 3 条固定轨迹（纯文本 / 单工具 / 连续工具）驱动真实 agent 循环，断言事件序列与工具参数，CI 离线可跑 | B-00 |
| CHECK-02 | 事件先持久化再消费 | codex rollout 追加写（session/mod.rs:3251）；OpenHands 服务端事件存储 | EngineEventV1 每条事件默认落盘 JSONL；重启后从磁盘重建会话状态（消息/工具结果/压缩点）；UI 状态只从事件投影 | B-12 |
| CHECK-03 | pinned-deps + 依赖方向守门 | pi `check-pinned-deps.mjs`（禁 range/file:/git: 依赖）+ `check-ts-relative-imports.mjs`；OpenHands `no-direct-agent-server-calls.test.ts` | CI 新增两个脚本：package.json 依赖全部精确版本（除 workspace:）；跨包 import 强制走包名；新增一条静态测试禁止 desktop/renderer 直接 import `src/agent` 内部符号 | 独立 |
| CHECK-04 | 错误分类三档化 | gemini-cli ~30 类 ToolErrorType + 9 类 InvalidStreamError（geminiChat.ts:1404-1459）；codex CodexErrorDetails | `src/router/llm/` 错误枚举区分三类：可重试协议错误（429/529/连接）、内容问题（触发回写引导提示）、致命错误（终止 turn）；每类有测试夹具 | B-06 |
| CHECK-05 | 遥测记 decision source | codex `ToolDecisionSource::{Config, AutomatedReviewer, User}`（approvals.rs:257-272）；claude-code `logPermissionDecision` 四路扇出 | 每次权限决策（允许/拒绝/预授权）的事件带 `decisionSource` 字段；审批漏斗可统计「配置放行 vs 用户放行 vs 硬拒绝」 | B-08/R-01 |
| CHECK-06 | 压缩结果事件化 | OpenHands `CondensationEvent{forgotten_event_ids, summary_offset}` + agent/condenser 双组件记账 | EngineEventV1 压缩事件包含：删减消息 id 列表、摘要插入偏移、压缩前后 token、耗时；桌面有轻量展示 | B-07 |
| CHECK-07 | 架构守门测试 | OpenHands 用静态测试执行架构约束（罕见做法，比 code review 可靠） | 一条 vitest 遍历 `desktop/src`，断言无 import 路径指向 `src/agent` 内部模块（白名单 ≤3 文件）；CI 必跑 | B-12 |

### B 组：循环正确性（低成本，防回归）

| ID | 目标 | 来源证据 | 验收标准（可跑） | 挂靠 |
|---|---|---|---|---|
| CHECK-08 | 截断工具调用整体作废 | pi agent-loop.ts:381-406（stopReason=length 时 failToolCallsFromTruncatedMessage）；gemini-cli 流有效性分类 | 测试：模型流被截断（length）且带半截工具 JSON 时，工具**不执行**并回喂错误结果；会话可继续 | B-06 |
| CHECK-09 | 中断回填工具回复 | CoreCoder `_answer_pending_tool_calls`（agent.py:132-146）；crush 孤儿 tool_use 自愈（agent.go:1625-1691） | 测试：执行工具中途 Ctrl+C/abort，所有未回填的 tool_call 自动获得 `[interrupted]` 回复，下次请求不被 API 拒绝 | B-06 |
| CHECK-10 | 读前必读 + 外部修改检测 | claude-code FileEdit 读取要求；crush filetracker（edit.go:290-303）；little-coder read-guard-edit | 测试：未读文件 edit 被拒并返回「先 Read 拿精确 oldText」指引；文件在读取后被外部修改则拒绝编辑 | B-01/B-03 |
| CHECK-11 | 双重截断兜底 | cline executor 层 48k 字符 + 消息层 8k/6MB（output-limits.ts:24-42, message-builder.ts:28-35）；crush bash 30KB | 测试：单条工具输出超 executor 阈值 → 头尾保留 + 落盘路径提示；整段消息超预算 → 消息层二次截断且截断通知不被二次截断吃掉 | B-10 |
| CHECK-12 | 终止态事件单一出口 | crush publishRunComplete（agent.go:539-548，OnComplete 合并重试 + PublishMustDeliver） | 测试：取消/拒绝/失败/成功四种终局各恰好一条 terminal 事件；重试链合并为一次终态 | B-12 |

### C 组：安全与上下文（中成本，红线）

| ID | 目标 | 来源证据 | 验收标准（可跑） | 挂靠 |
|---|---|---|---|---|
| CHECK-13 | ACL fail-closed | codex 沙箱静默降级（manager.rs:281）、gemini-cli NoopSandboxManager、OpenHands 本地无沙箱——三家反例 | 测试：ACL 服务不可用/配置缺失/沙箱初始化失败时，工具执行一律**拒绝**并返回可诊断错误；测试断言不存在「降级为放行」路径 | B-08/R-01 |
| CHECK-14 | 权限决策单一出口 | claude-code `logPermissionDecision` 唯一出口四路扇出；codex orchestrator 统一编排 | 全部审批请求（含 shell 预授权、工具级 deny、远程 ACL）经同一函数进入；该函数同时产出审计事件 + 遥测 + 工具上下文，无旁路 | B-08 |
| CHECK-15 | 前缀缓存字节级稳定 | claude-code 前缀缓存约束（任何字节变化整段失效）；little-coder 尾部注入（inject.ts:54-87）；Kun immutable-prefix 指纹 | 快照测试：连续 3 轮系统提示前缀 hash 完全一致（B-02A 已有基础）；注入块一律走对话尾部且字节去重；KV 缓存命中率记录进遥测 | B-02 |
| CHECK-16 | 渐进式压缩 + 缓存感知 | claude-code 五级压缩流水线；CoreCoder 三层阈值（50/70/90%）；grok-cli relax 重试 | 压缩按成本递进（snip 工具输出 → 摘要 → 硬折叠）；缓存热时阈值放宽（SNIP_HOT_OVERRIDE 思路）；压缩失败有降级而非崩溃 | B-07 |

### 实施顺序建议

1. 第一批（随 B-00/B-06 实施顺手做）：CHECK-01、04、08、09 —— 都是测试层，直接并入旧计划测试任务。
2. 第二批（随 B-07/B-08 实施）：CHECK-05、06、13、14、16 —— 安全与上下文，与既有任务验收天然重合。
3. 第三批（独立小工程）：CHECK-02、03、07 —— 各自半天量级，不阻塞任何 B-xx。
4. 明确不做（对应原 §7 第 7 条）：进程级 RPC 边界（codex app-server / cline gRPC）——成本极高，Electron 主进程 + IPC + CHECK-07 守门已够。

---

## 8. 旧计划已列头部项目的工程质量补深挖（qwen-code / CodeWhale / jcode）

> 旧计划 §7/§8 对这三家只取了**功能证据**（工具可见面、压缩、权限规则等），本节省略功能、只补工程质量/架构/治理维度。取证日期 2026-08-05（qwen-code v0.21.5 / CodeWhale 0.9.4 / jcode 0.68.0）。

### 8.1 qwen-code（26.7k⭐，TS，852,511 行 src / 2,597 文件；测试 1,061,556 行，测试:源码 ≈ 1.25:1）

**架构**：已从 CLI 演化为多前端 agent 平台（core / cli / acp-bridge / sdk×3 / desktop×2 / web×3 / channels×9 / IDE 扩展×3）。核心循环 `AgentCore.runReasoningLoop`（agent-core.ts:743）→ `while(true)`（:881），UI 只订阅 `AgentEventType` 枚举事件（agent-events.ts:51），依赖方向单向 cli→core。

**工程质量亮点**：
- 错误分类粒度：`ToolErrorType` ~50 个字符串码（tool-error.ts，按域分组可序列化）+ 106 个领域错误类
- 遥测默认关闭 + `sanitize.ts` 脱敏层（config.ts:2174 `enabled ?? false`）
- 关键 LLM SDK 精确钉版：`@google/genai: 2.6.0`（普通依赖 caret）
- 测试基建：`integration-tests/fake-openai-server.ts`（fake OpenAI 服务）+ MSW + `no-ak` 无 key 子集供 CI 脱网
- 发布：45 个 workflow，CHANGELOG 完全由 GitHub Releases API 生成（禁手改）、nightly+preview 双轨

**不足**：
1. 【高】**巨型文件泛滥**：SessionManager.ts 12,299 行、acpAgent.ts 11,591、Session.test.ts 27,409——测试:源码 1.25:1 的代价是测试巨型化
2. 【中】**重试逻辑三份拷贝**（utils/retry.ts:232、tools/mcp-retry.ts:103、weixin/api.ts:57），瞬时错误判据各写一套已漂移（stream 6 码 vs mcp 8 码）
3. 【中】**desktop 嵌套 monorepo 平行宇宙**：自带 bun.lock、不依赖 core 包、SessionManager 与 core 概念重复实现
4. 【中】**版权混血（合规警示）**：大量核心文件（geminiChat.ts/tool-error.ts/retry.ts/msw.ts）头注释为 `Copyright 2025/2026 Google LLC`——repo 明显由 Gemini CLI 血统改写；**RouteDev 借鉴 qwen-code 代码前必须做逐文件合规排查**
5. 【中】覆盖率无门槛 + 裸 `process.exitCode=1` 散布（与 106 个细粒度错误类形成反差）

### 8.2 CodeWhale（40.5k⭐，Rust，765,555 行 / 19 crates）

**架构**：`crates/tui` 巨石 **667,738 行占 87%**（官方自认拆分未完成，docs/ARCHITECTURE.md boundary note）；**引擎反向依赖 UI 类型**（tool_catalog.rs:19 `use crate::tui::app::AppMode`）——引擎无法脱离 TUI 复用。

**工程质量亮点**：
- **MockLlmClient trait 边界 mock**（llm_client/mock.rs，预录 turn 回放 + 请求捕获，87 处引用）——CI 离线跑全量
- 11,338 处 `#[test]` / 545 文件；CI 全量+全特性+`--locked`+离线缓存回放
- 错误信封：`ErrorCategory`（10 类）+ `ErrorEnvelope{category,severity,recoverable,code}` 统一跨子系统
- 重试配置化（config.example.toml:886：3 次/1s 起/60s 封顶/指数退避）+ 全局 RetryBanner 倒计时
- **零网络遥测**（无 posthog/sentry/segment），本地资源遥测与上报分离
- 治理完整度罕见：24 个 workflow（DCO 门禁、PR 最小权限、security-audit、发布 tag 与 SHA 绑定 + sha256 校验清单）
- 扩展机制一等公民：PluginManifest（schema v1 + deny_unknown_fields + sha256 路径校验 + 1MB/64MB 上限）

**不足**：
1. 【高】**巨石单 crate + 引擎-UI 类型耦合**——结构性风险，拆分成本极高（67 万行后才开始拆）
2. 【中】**供应链 6 条 unmaintained advisory 豁免**（paste/ttf-parser/derivative/fxhash/bincode/yaml-rust），无到期复核机制
3. 【中】巨型单文件（ui/tests.rs 20,765 行、ui.rs 19,139、main.rs 16,827）
4. 【中低】两类 hooks 并存互不相通（tui hooks.rs 与 crates/hooks 事件槽）；418 处 `#[allow(dead_code)]`
5. 【低】退出码仅 0/1；改名残留（LICENSE 署名 "DeepSeek CLI Contributors"、DEEPSEEK_TUI_* 环境变量别名）

### 8.3 jcode（15.9k⭐，Rust，692,545 行 / 83 crates，0.68.0）

**架构**：83 crates 纵向分层（base → app-core → tui，tui 是独立 rustc 编译单元——增量编译工程决策）+ 9 个 provider-runtime crate（downstream，改 provider 不重建核心脊柱）+ 14 个 `*types` 叶子 crate。**「RAM 高效」的三个工程证据**：jemalloc `malloc_conf` 调优（默认参数曾致 1.4GB RSS，main.rs:1-35）；provider SSE 流式消费而非全量缓冲（openai_stream_runtime.rs:246 + turn_streaming_mpsc.rs 1,710 行）；87MB ONNX 嵌入模型空闲即卸载（embedding.rs:228）。

**工程质量亮点**：
- **CI 护栏矩阵是行业标杆**：6 个 budget ratchet（warning / panic / swallowed-error / code-size / test-size / wildcard-reexport），允许存量债务但不许增长、`--update` 需显式人工执行
- **测试防静默跳过**：CI 对嵌入模型测试显式 grep skip 标记并 fail（"A skipped test still reports ok" 是反复踩过的事故）
- 确定性 MockProvider（tests/e2e/mock_provider.rs：脚本化 StreamEvent 队列 + 捕获 prompt/模型断言）
- 重试常量带事故注释（turn_loops.rs:13-23："one empty response once in 43 turns silently ended a 20-hour benchmark"）
- TELEMETRY.md 透明声明（明确不收集 prompts/code）+ Cloudflare D1 schema 先行
- 7,263 处 `#[test]`；changelog 结构化 JSON（机器可读）

**不足**：
1. 【高】**巨型文件债务制度化且只冻结不拆**：101 个 >1,200 行文件被 code_size_budget.json 追踪（合计 202,928 行），ratchet 自述 "keeps the debt from getting worse"，截至取证日仍原样存在
2. 【中】**无 deny.toml / 无 cargo-deny**；cargo-audit 只在 Linux CI 一步运行且 `command -v` 失败默认跳过
3. 【中】发布 profile 与性能卖点张力：`[profile.release] opt-level=1, codegen-units=256`（编译优先牺牲运行时性能）
4. 【中】调试 bin 混入发布面（`[[bin]] test_api` 无 feature 门）；根 tests/ 残留一次性 Python 脚本
5. 【低】170MB assets/（57MB gif + 76MB mp4）入库且与 release assets 双份存储，无 git-lfs

### 8.4 三家对比与 RouteDev 增量（新增检查项 CHECK-20/21）

| 维度 | qwen-code | CodeWhale | jcode | RouteDev 增量 |
|---|---|---|---|---|
| mock LLM | fake-openai-server + MSW | **MockLlmClient trait（87 处引用）** | MockProvider 脚本化队列 | CHECK-01 已覆盖；补 trait 化接口 |
| 错误分类 | 50 字符串码 + 106 类 | ErrorEnvelope 统一信封 | 内部 anyhow + 边界枚举 | CHECK-04 已覆盖 |
| 遥测 | 默认关 + sanitize | 零网络遥测 | TELEMETRY.md 先行 + D1 | CHECK-05 已覆盖 |
| CI 护栏 | 45 workflows / flaky 巡逻 | 24 workflows / DCO | **6 个 budget ratchet + 防静默跳过** | **新增 CHECK-20/21** |
| 重试 | 3 份拷贝（反面） | 配置化 + 可观测 | 常量 + 事故注释 | CHECK-04 附注：单点化 |
| 关键教训 | 巨型文件 + 双轨 desktop + 版权混血 | 巨石 crate 拆分太晚 | ratchet 需配拆解 deadline | 行数红线（CI lint） |

**新增检查项**：

| ID | 目标 | 来源证据 | 验收标准 | 挂靠 |
|---|---|---|---|---|
| CHECK-20 | 测试防静默跳过 | jcode CI 对嵌入模型的教训（"skipped test still reports ok"） | CI 汇总校验：实际执行的用例数 ≥ 预期（如 `--reporter` 输出断言）；`describe.skipIf`/条件跳过时打印显式 SKIP 计数 | 独立 |
| CHECK-21 | budget ratchet 护栏（最小集） | jcode 6 个 budget 脚本（只降不升 + `--update` 显式执行） | CI 三个基线文件：`禁止新增 unwrap/any`、`禁止新增 >3000 行源文件`、`禁止新增 TODO/FIXME`；违规即 fail，`--update` 需人工 | 独立 |
| CHECK-22 | 行数红线（防巨型文件） | qwen-code 最大 12,299 行 / jcode 101 个 >1200 行（高严重度债） | lint 规则：源文件 >3000 行、测试文件 >8000 行触发 CI 告警；新文件超限即 fail | 独立 |

**合规警示（重要）**：qwen-code 大量核心文件为 Google LLC 版权头（Gemini CLI 血统改写），从 qwen-code 借鉴实现时必须逐文件核对 license 头；CodeWhale 虽 MIT 但署名/环境变量残留 "DeepSeek CLI" 改名痕迹——RouteDev 借鉴代码时以 pi（MIT 纯净）/ jcode（MIT）/ cline（Apache-2.0）为首选。

## 9. 逆向教学仓库经验落地（claude-code-from-scratch / how-claude-code-works）

> 两个仓库定位不同：`how-claude-code-works`（3.4k⭐）是 Claude Code **逆向分析文档库**（21 章 / 1.7 万行，含逐字提示词与可复现逆向方法）；`claude-code-from-scratch`（2.5k⭐）是**可运行的最小实现**（Python `mini_claude/` 5,074 行：agent.py 1,951 行 + autonomy/memory/tools/subagent/skills/mcp_client/ui）。两者互补：前者回答「它为什么这么设计」，后者回答「最少要多少代码能跑起来」。它们把 Anthropic 未开源的实现拆成了可学习、可对照的知识，RouteDev 无需等待任何上游开源即可参照。

### 9.1 从 how-claude-code-works 提炼的设计概念（21 章骨架 → RouteDev 落点）

| 章 | 核心机制（逆向结论） | 与 RouteDev 现状的关系 | 落点 |
|---|---|---|---|
| 02 agent-loop | 双层生成器（QueryEngine 会话层 / query() 循环层）；**7 个继续点**每种对应一种恢复策略；**错误扣留**：可恢复错误不立即 yield 上层 | 与 NativeAgentKernel 分层同构；「继续点显式枚举」RouteDev 未做 | 新增：loop 内每个 continue 站点登记（B-06 契约测试时顺手盘点） |
| 03 context-engineering | **五级压缩流水线**（渐进式：先低成本手段后重武器）；**前缀缓存字节级一致**约束；记忆预取；反应式压缩（PTL 错误触发） | B-07 计划已有压缩增量；「缓存热时放宽阈值」未提 | 并入 CHECK-16 |
| 04 tool-system | 60+ 工具 + **工具搜索/延迟加载**；并发控制；大结果处理 | 旧计划 B-01B tool_search 已规划 | 无需新增 |
| 05 code-editing | FileEdit search-and-replace；**编辑前读取要求**；原子写入 + LSP 集成；缩进保持 | read-guard-edit/crush filetracker 已证同方向 | 并入 CHECK-10 |
| 06 hooks | Hook 事件全景 + matcher + **PermissionRequest Hook**（权限决策可被 hook 改写）；Stop Hook 采样后验证 | 自动化预授权已有雏形（chat-bridge onConfirmTool） | 挂靠 B-08：hook 决策协议对齐 crush 的 exit-code 约定 |
| 07 multi-agent | 三种模式：子 Agent（AgentTool）/ **协调器（Coordinator）**/ Swarm；Plan 两阶段 | B-05/B-11 已规划；「协调器」模式是 B-18 观察对象 | 无需新增 |
| 08 memory | 四种记忆类型封闭分类法；**MEMORY.md 是索引而非容器**；语义检索；新鲜度/漂移防御 | RouteDev 已有极简记忆（Phase 97） | 挂靠 B-17：记忆治理不引入新存储 |
| 09 skills | **Frontmatter 处理**；执行模型 Inline vs Fork；信任模型 | Skill progressive disclosure 已有 | 无需新增 |
| 10 plan-mode | 唯一**主动降低自身权限**的机制；计划文件管理；退出审批与权限恢复 | RouteDev 有 Plan 模式 | 挂靠 B-08：Plan 模式权限降级要有状态机测试 |
| 11 permission-security | **纵深防御 5 层**；Bash 多层安全（tree-sitter AST 解析 + 23 项静态检查 + 路径约束）；危险文件保护；权限决策追踪 | 与 CHECK-13/14 直接对应；「tree-sitter AST 解析 bash」比 RouteDev 现方案强 | 并入 CHECK-13/14；AST 解析列为 B-08 可选增强 |
| 13 minimal-components | **七个最小必要组件**（以 claude-code-from-scratch 初始版 ~1,300 行 / 6 工具为基准）；渐进式增强路线 | 验证 RouteDev「不建第二内核」原则：1,300 行即可跑通核心循环 | 写入 B-00 基线文档作对照基准 |
| 15 task-system | TodoV2 **文件级存储 + 锁**（为多 Agent 并发而生）；三层变更检测；验证提醒 | RouteDev Todo 已有 | 无需新增 |
| 16 observability | 指标/事件/追踪/会话记录四层；**logPermissionDecision 唯一出口四路扇出**；「为什么放行」也记录；隐私边界「形状可见内容不可见」 | 与 CHECK-05 完全同构 | 并入 CHECK-05 |
| 17-21 autonomy 系列 | /goal 守门裁判 + /loop 自排程闹钟；**Auto Mode 两段式分类器**（64 字符粗筛 / 4096 细判，`classifyYoloActionXml`）；dynamic workflow 脚本编排（pipeline 默认 + parallel barrier）；agent-teams 共享任务列表；/bg 后台舰队 | 旧计划 B-18（多角色）明确延后；Auto Mode 分类器是「权限 × 自治」的新解法 | **新增观察项**：Auto Mode 两段式分类器（先粗筛后细判 + 自然语言规则桶）列入 B-08 后期可选，不提前实施 |

### 9.2 从 claude-code-from-scratch 提炼的可执行经验（最小实现 = 验收基准）

该仓库的价值是**证明「哪些机制是必需的最小集」**——每个机制都能在 5,074 行里找到对应实现，可作为 RouteDev 同类功能的「最少验收基准」：

| 机制 | 最小实现证据 | 为什么它是必需的最小集 | RouteDev 动作 |
|---|---|---|---|
| 双后端协议适配 | agent.py:78-99 `_is_retryable`（429/503/529 + overloaded/ECONNRESET）+ 指数退避 + jitter | 网络层错误不分类，重试就是乱撞 | B-06 契约测试补充：退避上限 30s + jitter 断言 |
| 模型能力硬编码表 | agent.py:104-144 MODEL_CONTEXT / _model_supports_thinking / _get_max_output_tokens | 能力声明不在模型侧时，客户端硬编码表是兜底 | 挂靠 B-14：能力表至少要有 contextWindow/maxOutput/thinking 三列 |
| 四层压缩（含缓存感知） | agent.py:166-174：SNIPPABLE_TOOLS + SNIP_THRESHOLD 0.60 + **SNIP_HOT_OVERRIDE 0.75（缓存热时放宽）** + MICROCOMPACT_IDLE 5min + KEEP_RECENT_RESULTS 3 | 「缓存热时不动、快溢出时宁牺牲缓存」是成本最优解 | 并入 CHECK-16 |
| 只读子 Agent 契约 | subagent.py:14 `READ_ONLY_TOOLS = {read_file, list_files, grep_search}` + explore/plan 双 prompt + 自定义 agent frontmatter（name/description/**allowed-tools**/system_prompt） | 只读 = 工具白名单 + prompt 双重约束，不靠模型自觉 | 并入 CHECK-14；B-05A 验收基准：explore 工具集 ≤3 |
| 自定义 agent 目录协议 | subagent.py:81-117：用户级 `~/.claude/agents` + 项目级 `.claude/agents`（项目覆盖用户） | 两层覆盖 + frontmatter 解析即可支持自定义角色 | 挂靠 B-17：技能/角色治理按此最小协议 |
| 预算双上限 | agent.py:190-194 max_cost_usd + max_turns | 成本上限与轮数上限必须同时存在 | 挂靠 B-00 基线：12 任务记录 cost/turn |
| 权限模式枚举 | tools.py check_permission + PermissionMode | 最小权限模型 = 模式枚举 + 每工具判定 | 对照 CHECK-13/14 验收 |

### 9.3 落地为计划的三条新检查项（并入 §7 清单）

| ID | 目标 | 来源证据 | 验收标准 | 挂靠 |
|---|---|---|---|---|
| CHECK-17 | 继续点显式登记 | claude-code query() 7 个继续点（how-claude-code-works 02 章） | loop 源码中每个 continue/恢复路径有注释登记恢复策略；契约测试覆盖「中断后从每个继续点恢复」 | B-06 |
| CHECK-18 | Auto Mode 两段式分类器观察项 | `classifyYoloActionXml`（64 字符粗筛 / 4096 细判）+ 自然语言规则桶（18 章） | 只产出设计笔记 + 2 个 POC 测试（粗筛命中率、细判成本），不接入生产 | B-08 后期（观察） |
| CHECK-19 | 最小集对照基准 | claude-code-from-scratch 初始版 ~1,300 行 / 6 工具（13 章） | B-00 基线文档附一节「RouteDev 最小可运行集」：列出最少工具数/最少模块数/冷启动 token，作为过度设计红线 | B-00 |

## 10. 对照 RouteDev 实际代码的复核结论（2026-08-05，建议状态校准）

> 应要求，本节省略文档（AGENTS.md / CODEMAP.md 均为二手描述），**全部基于 `routedev/` 实际源码取证**。结论先行：旧计划 B-01A/B-01B/B-02A/B-04/B-07 已在实施中落地；§7 的 22 项检查项需按下表重标状态，避免重复建议。

### 10.1 核对证据（实际代码）

| 机制 | 实际代码证据 | 对应 CHECK |
|---|---|---|
| B-01A 工具面解析 | `src/tools/tool-surface-resolver.ts`（79 行，纯函数：exposure hidden/deferred/mode + deniedTools + allowedTools + qa 模式 + maxCoreTools） | CHECK 相关项已实现 |
| B-01B tool_search | `src/tools/tool-search.ts`（183 行：TurnToolBoost 回合级提升、确定性评分含 CJK 二元组、deny 过滤、上限 5、调用后收回） | 已实现 |
| B-02A 提示词去重 | `desktop/main/bridges/chat-bridge.ts:380-384`（「工具参数只存在于 function calling schema；系统提示仅保留能力组摘要」） | 已实现 |
| B-04 修改后验证 | `src/agent/completion-gate.ts:212`（文档/配置变更跳过验证）+ `modifiedFiles` 驱动相关测试（:237 includeTests=false 时只做相关 typecheck/lint） | 已实现 |
| B-07 压缩恢复 | `src/agent/context-compaction.ts`（五阶段：L5 LLM Summary 唯一调 LLM）；`loop.ts:548-552` 压缩后恢复「最近读取/修改文件 + 未完成待办 + 图片数」 | 已实现 |
| CHECK-10 读前必读 | `src/tools/read-tracker.ts`（164 行，Phase 31 Task 6.1：新建文件例外、I1 工作目录、I6 存在性缓存不缓存 false） | 已实现 |
| CHECK-12 全局 FIFO | `src/agent/run-scheduler.ts`（158 行：队列上限 32、30 分钟超时、cancel/clear、状态快照） | 已实现 |
| CHECK-02 事件落盘 | `src/agent/kernel-native.ts:174-189`（EngineEventV1 sink → trace.recordEngineEvent）；`src/harness/trace-collector.ts:814`（按 sessionId 批量 appendFile → trace.jsonl） | 已实现 |
| CHECK-08 截断修复 | `loop.ts:654`（truncation 修复不完整 arguments JSON）+ `src/tools/tool-call-repair/`（truncation.ts/scavenge.ts/pipeline.ts） | 已实现 |
| CHECK-13/14 权限 | `src/tools/permission-engine.ts`（799 行，头部注释「唯一权限决策源」「deny 不可覆盖 > confirm > auto」「最严规则胜出」） | 已实现核心 |
| CHECK-15 前缀快照 | `routedev/tests/prompts/system-prompt-snapshot.test.ts` 存在 | 已实现 |
| CHECK-16 渐进压缩 | `context-compaction.ts:5-10` 五阶段说明（snip → … → L5 摘要） | 已实现 |
| CHECK-01 基线 | `routedev/tests/evals/`（eval-config.yaml + fixtures + tasks.ts + run-harness-eval.mjs 存在） | 部分（fake LLM server 未见） |
| CHECK-04 错误分类 | `src/router/llm/openai.ts`（withRetry querySource-aware 差异化重试 + normalizeError + LLMError） | 部分（三档分类粒度待查） |
| CHECK-11 截断 | `src/tools/result-sanitizer.ts:27`（DEFAULT_MAX_OUTPUT_CHARS=16000 + 智能截断 + truncated 标记） | 部分（executor 层有，消息层兜底待查） |

### 10.2 CHECK 状态重标（22 项）

| 状态 | CHECK | 说明 |
|---|---|---|
| **已实现（只补验证）** | 02、08、10、12、13、14、15、16 | 代码已存在，缺口是「对应验收测试是否存在」——实施时会话只需核对测试覆盖 |
| **部分实现（补缺口）** | 01（缺 fake LLM server）、04（分类粒度）、06（压缩事件字段有 compactedAt/stage/summaryFailed，UI 展示待查）、09（tool-call-repair 有修复管道，中断回填语义待查）、11（消息层兜底） | 每条先确认缺口再补 |
| **未实现（新做）** | 03（无 pinned-deps 守门）、05（permission-engine 无 decisionSource 字段，只有 reason）、07（无渲染层守门测试）、18（Auto Mode 观察项）、19（最小集对照）、20（防静默跳过）、21（budget ratchet）、22（行数红线） | 根 `.github/workflows/` 仅 ci.yml + release.yml，护栏类检查全部缺失 |
| **过时（撤回建议）** | 无 | 无整条过时项，但挂靠 B-01A/B-01B/B-02A/B-04/B-07 的 CHECK 描述需按已实现状态改写 |

### 10.3 修正后的执行建议（按现状重排）

1. **第一优先（低成本，护栏类缺失）**：CHECK-20/21/22 + CHECK-03/07——全部是脚本级检查，RouteDev 目前完全没有 CI 护栏（.github/workflows 只有 ci.yml/release.yml），收益最高。可合并为一个 `scripts/quality-gates.mjs`（行数红线 + 防静默跳过 + 依赖精确版本 + 渲染层守门）。
2. **第二优先（随既有任务验证）**：CHECK-01/04/06/09/11 的缺口确认——已实现机制缺测试的补测试，缺字段的补字段（如 CHECK-05 在 permission-engine 决策结果加 `decisionSource: 'config' | 'user' | 'preauthorized' | 'deny-rule'`，不新增旁路）。
3. **延后**：CHECK-18（Auto Mode 观察项）、CHECK-19（最小集对照，可并入 B-00 基线文档）。
4. **不再建议**：CHECK-02/08/10/12/13/14/15/16 不需要新实施，只核对测试覆盖；旧计划中已标注完成的 B-01A/B-01B/B-02A/B-04/B-07 与本次复核一致。

### 附录：取证仓库清单（已删除）

取证对象（全部 `--depth 1` 浅克隆，取证日期 2026-08-05；**取证完成后已删除，不占磁盘**，复查需重新 clone）：
- 第二轮：gemini-cli、codex（commit 见正文）、pi（588915e / 0.83.0）、OpenHands、cline、agents-cli、CoreCoder
- 第三轮：qwen-code（da37110 / v0.21.5）、CodeWhale（b63e483 / 0.9.4）、jcode（0.68.0）、claude-code-from-scratch、how-claude-code-works
- 第一轮：crush、little-coder、cc-haha、Kun、smolagents、grok-cli

复核记录（2026-08-05）：删除前抽查 11 个关键证据文件，路径/行数/版权头全部与正文一致（SessionManager.ts 12,299 行、mock.rs 27 处 MockLlmClient、geminiChat.ts:7-8 copied DISCLAIMER、qwen-code tool-error.ts Google LLC 版权头等）。
