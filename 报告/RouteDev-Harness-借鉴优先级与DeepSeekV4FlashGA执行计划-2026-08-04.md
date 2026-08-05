# RouteDev Harness 借鉴优先级与 DeepSeek V4 Flash GA 执行计划

> 日期：2026-08-04
> 范围：对《RouteDev Agent Harness 全景对比》中的全部借鉴点重新排序，并转换为可由 DeepSeek V4 Flash GA 小步执行的工程任务。
> 原则：先提高现有基础能力的完成率，再增加产品表面；保留 RouteDev 的全局 FIFO、NativeAgentKernel、统一事件、远程 ACL、PermissionEngine、模型路由和桌面优先优势。

## 1. 纠偏结论

用户指出的问题成立。上一版报告虽然把 Qwen Code 的“执行工具”和“生产成熟”评分放在 RouteDev 之上，但借鉴点只写了 settings、MCP 和诊断，评分与建议没有形成证据闭环。

直接核验官方源码后，Qwen Code 更值得优先借鉴的是：

1. **按模型、模式、环境和权限解析模型可见工具面**，并支持 deferred tool / `tool_search`，而不是把注册表里的工具全部暴露给模型。
2. **工具注册前执行权限判断**，权限支持 allow / ask / deny、别名和 shell 语义防绕过。
3. **成熟的执行工具集合**：grep/glob、读写编辑、Notebook、LSP、结构化输出、图像查看、Web、worktree、任务管理和 MCP 资源，且并非全量同时注入。
4. **更低摩擦的子 Agent 接口**：核心只要求 `description` 与 `prompt`，内置 Explore 为只读角色，并有 list/stop/send、后台运行、恢复和隔离机制。
5. **三档压缩与恢复**：压缩后恢复最近文件和图片，记录指标，并为缓存命中维持稳定前缀。
6. **生产链路**：checkpoint、hooks、分层配置、headless JSON/stream-json、遥测和诊断共同构成可运行、可排障、可集成的产品能力。

这不是要求 RouteDev 复制 Qwen Code。RouteDev 已经拥有 Qwen Code 不具备或产品边界不同的桌面远程控制、设备 ACL、统一 Kernel/Event Hub 和全局 FIFO；计划只补足影响当前模型执行质量的基础机制。

## 2. RouteDev 当前源码基线

| 基础面 | 当前事实 | 直接问题 | 证据 |
|---|---|---|---|
| 模型可见工具 | `core` 注册 10 个基础工具，但 VFS 4 个、Plan 5 个也始终注册，之后再注册 `spawn_agent`，通常约 20 个 schema | “core ≤10”与实际模型可见面不一致；内部计划/VFS 工具挤占 Flash 模型选择空间 | `src/runtime/app-init-tools.ts`、`src/runtime/app-init-agent-loop.ts`、`src/tools/adapter.ts` |
| 工具提示 | ChatBridge 把每个工具名称和最长 240 字描述写入系统提示，同时又传入完整 tool schema | 描述重复、前缀变动、token 浪费，增大选错工具概率 | `desktop/main/bridges/chat-bridge.ts` |
| 系统提示词 | 主提示覆盖执行、权限、上下文、Todo、进度、项目、用户和完成协议 | 能力完整，但缺少明确 token 预算、稳定/动态分区和快照回归 | `src/prompts/manager.ts` |
| 搜索工具 | `file_search` 与 `code_search` 都能搜索内容；默认 core 没有 repo map、LSP、Web | 工具边界含混；基础代码理解能力受 profile 影响 | `src/tools/builtin/file-search.ts`、`src/tools/builtin/code-search.ts`、`src/runtime/app-init-tools.ts` |
| 完成验证 | 修改文件后，只有用户文本命中 test/build/lint 等关键词才进入 CompletionGate | 普通“实现/修复”任务可能不自动验证 | `desktop/main/bridges/chat-bridge.ts`、`src/agent/completion-gate.ts` |
| 子 Agent | 有 7 种角色、隔离、fork history、缓存共享和递归阻断；schema 要求显式填写 `model` | 基础设施强，但调用接口对 Flash 模型偏重，角色过多且缺少默认只读 Explore 契约 | `src/tools/builtin/spawn-agent.ts`、`src/agents/subagent-registry.ts`、`src/agents/subagent-session.ts` |
| 压缩 | 已有 5 阶段压缩、50/80/90 阈值、最近消息保留、CCR 和记忆 | 缺少“最近读写文件/图片恢复”、可见指标与稳定前缀测试 | `src/agent/context-compaction.ts` |
| DeepSeek | V4 Flash 被用于 simple/classifier；客户端复用 OpenAI 兼容层，并有 reasoning/tool-call 修复 | 缺少针对 GA 行为的固定契约语料、schema 规模基准和错误分类 | `src/config/defaults.ts`、`src/router/llm/deepseek-client.ts`、`src/agent/loop.ts` |

## 3. 排序标准

不采用复杂加权公式，避免伪精确。按以下顺序判定：

- **P0**：直接提高普通编码任务完成率，或堵住现有安全/正确性缺口；1–2 个小批次可验证。
- **P1**：补齐成熟 Harness 的常用基础能力，收益明确，但依赖 P0 的工具和提示词基线。
- **P2**：增强生产集成、恢复和隔离；不应阻塞基础执行质量。
- **P3**：功能表面扩张或多代理复杂化；没有评测证据前不实施。

同优先级内依次按：完成率影响 > 安全 > 可诊断性 > 交互便利 > 生态规模。

## 4.1 第二轮源码复核后的优先级确认（2026-08-04）

本轮对 SWE-agent、Plandex、Continue、Kimi Code、MiMoCode、MiniMax Mini-Agent、Trae Agent、Roo Code、Kilo Code、Open Interpreter、OpenHarness、jcode 共 12 个项目做了源码级复核（commit 与关键文件见 §8）。**优先级未发生替换或移动**，理由：

1. **新证据全部落在既有任务内**：Kimi Code 的 0.85/50k 自动压缩、Kilo Code 的锚定摘要、jcode 的 SplitSystemPrompt 静态/动态分区强化 B-02/B-07；Plandex 的 buildValidateLoop 强化 B-04；OpenHarness/Kilo Code 的权限规则集与 jcode 的破坏性命令门禁强化 B-08；Kimi/Trae 的 trajectory 与完成语义强化 B-00/B-06。
2. **几处"加分"被证实但不需要新任务**：Open Interpreter 的 harness profile 与原生沙箱是 B-02/B-08 的现成参照；jcode 的工具发现（discover）与 tool search 同构，直接服务于 B-01B。
3. **两项"降级"结论**：OpenHarness 无 benchmark 基础设施（取消"组合式多角色评测"作为借鉴点，改为生产级多角色编排，仍归 B-11/B-18 的观察对象）；Trae Agent 无 trajectory 回放（B-00 只借鉴记录结构，不承诺回放）。
4. **与 RouteDev 现有优势无冲突**：这些项目要么弱于 RouteDev 的全局 FIFO/统一 Kernel/远程 ACL（无第二套执行内核被证明必要），要么其强项（权限、压缩、提示词分区）正是 RouteDev 已计划的增量补齐点。

## 4. 统一优先级总表

| 顺序 | ID | 优先级 | 借鉴机制 | 主要来源 | RouteDev 落点 |
|---:|---|---|---|---|---|
| 1 | B-00 | P0 | 建立 Flash 基础任务集、轨迹与成本基线 | mini-swe-agent、SWE-agent、Trae Agent | 先测后改，防止“功能增加但完成率下降” |
| 2 | B-01 | P0 | 每回合解析模型可见工具面；支持 hidden/deferred/tool-search | Qwen Code、Codex、CodeWhale | 把约 20 个默认 schema 压到 8–12 个，模式和任务按需增补 |
| 3 | B-02 | P0 | 精简并稳定系统提示；去除工具描述重复 | Pi、Qwen Code、Reasonix | 建立 prompt budget、stable/dynamic zones 和快照测试 |
| 4 | B-03 | P0 | 纠正基础工具组合与命名边界 | Qwen Code、Codex、Goose | 合并重叠搜索入口，补结构化诊断能力，危险 Git 子命令继续受权限控制 |
| 5 | B-04 | P0 | 修改后按变更类型自动验证 | Aider、SWE-agent | 不再依赖用户是否说出“测试/构建” |
| 6 | B-05 | P0 | 降低子 Agent 调用摩擦；默认只读 Explore | Qwen Code、OpenCode、Pi | `model` 改为可选继承；精简角色和 schema；建立只读工具集 |
| 7 | B-06 | P0 | DeepSeek V4 Flash GA 消息/工具契约测试 | Reasonix、CodeWhale、Kimi/MiMo/MiniMax | 固定 reasoning、tool call、并行、截断、重试和错误样本 |
| 8 | B-07 | P1 | 压缩后恢复最近文件/图片；显示上下文预算 | Qwen Code、Pi、OpenCode、CodeWhale | 在现有五阶段压缩上增量补齐，不另造压缩器 |
| 9 | B-08 | P1 | 权限别名、deny 优先和 shell 语义防绕过回归 | Qwen Code、Codex、Goose | 强化 PermissionEngine 测试，不建立第二权限系统 |
| 10 | B-09 | P1 | Repo map、LSP diagnostics 与模型 edit protocol | Aider、Reasonix、Qwen Code | 先加诊断和 budgeted repo map；Notebook 仅在产品有场景时启用 |
| 11 | B-10 | P1 | 工具结果预算、收据与大结果检索 | OpenCode、CodeWhale、Goose | 统一截断、可恢复句柄和 UI 展示，避免大输出吞掉上下文 |
| 12 | B-11 | P1 | 子 Agent list/stop/send/resume 与只读/写入权限集 | Qwen Code、OpenCode、Cline | 复用现有 subagent/session/event，不引入 swarm runtime |
| 13 | B-12 | P1 | Kernel、Trace、远程 timeline 同序列契约与上下文可视化 | Codex、OpenHands、Cline | 关闭已有“已接线但待动态验证”的证据缺口 |
| 14 | B-13 | P2 | checkpoint 恢复范围可解释、可预览 | Cline、Roo Code、Plandex | 明确文件、会话、权限不会被含混地一起回滚 |
| 15 | B-14 | P2 | provider/tool capability 声明和兼容层 | Goose、Continue、Kimi Code、MiMoCode | 模型特例只留在适配器；不可用工具显式降级 |
| 16 | B-15 | P2 | headless JSON/stream-json 与诊断导出 | Qwen Code、Codex | 服务自动化和 CI 集成；复用 EngineEventV1 |
| 17 | B-16 | P2 | 高风险任务可选容器/worktree 隔离 | OpenHands、SWE-agent、Qwen Code | 可选后端，不替换本地轻量执行路径 |
| 18 | B-17 | P2 | 配置/扩展能力版本化与治理 | Continue、Goose、Kilo Code | 收口 Skill/MCP/Provider 能力清单，避免再加 DSL |
| 19 | B-18 | P3 | 多角色并行协作、team/swarm | OpenHarness、Trae Agent、Roo Code | 等 B-00 证明单 Agent 瓶颈后再立项 |
| 20 | B-19 | P3 | 第二套 CLI/TUI 或完整插件市场 | jcode、OpenCode、Goose | 与桌面优先优势不符，暂不实施 |

## 5. DeepSeek V4 Flash GA 执行协议

以下规则写给执行模型，也应复制到每个任务包开头：

1. 每次只执行一个任务 ID；不得顺带重构邻近模块。
2. 开始前读取根 `AGENTS.md`、`routedev/AGENTS.md` 和本计划对应任务。
3. 先用 codebase graph 定位符号和调用方；图谱与磁盘冲突时，以磁盘为准并记录索引过期。
4. 开始前运行 `rtk git status`，不得覆盖 R-01～R-10 或用户已有改动。
5. 单批默认最多修改 5 个生产文件和 3 个测试文件；超过即停止并拆批。
6. 不创建第二执行循环、第二权限引擎、第二事件总线或第二压缩器。
7. 每批必须先写或更新失败测试，再做最小实现；测试无法在环境运行时，状态只能写“环境阻塞”。
8. 仅运行任务相关测试和双 typecheck；不要在未经确认时提交、推送、安装新依赖或改发布凭据。
9. 完成报告固定输出：改动文件、行为变化、验证命令、失败/跳过项、剩余风险。
10. 若发现计划假设错误，停止在该任务，不自行扩大范围。

## 6. 可执行任务包

### B-00：建立基础完成率基线

**目标**：让后续每项优化都有“是否真的帮助 DeepSeek V4 Flash GA”的证据。

**允许修改**：

- `routedev/tests/evals/**`（新）
- `routedev/scripts/run-harness-eval.mjs`（新）
- `routedev/package.json`
- `报告/RouteDev-Harness-FlashGA-基线.md`（新）

**实施**：

1. 建立 12 个本地、无网络、可重复任务：2 个只读定位、4 个单文件修复、2 个多文件修复、2 个测试失败诊断、1 个权限拒绝、1 个子 Agent 探索。
2. 每个任务记录：是否完成、工具调用数、无效工具调用数、提示 token、工具 schema token、总轮数、压缩次数、验证结果。
3. runner 只消费现有 Kernel/EventV1，不新增代理逻辑。
4. 首次只记录基线，不设置“为了过门槛而调低”的通过线。

**验收**：同一固定配置连续运行两次，任务定义、事件格式和汇总字段稳定；失败能定位到具体阶段。

### B-01A：模型可见工具面解析器

**目标**：区分“工具已注册”和“当前模型应看到”。

**允许修改**：

- `routedev/src/tools/types.ts`
- `routedev/src/tools/adapter.ts`
- `routedev/src/runtime/app-init-tools.ts`
- `routedev/desktop/main/bridges/chat-bridge.ts`
- `routedev/tests/tools/tool-surface-resolver.test.ts`（新）

**实施**：

1. 为工具增加最小元数据：`exposure: core | mode | deferred | hidden`、`modes`、`readOnly`；不要引入通用策略 DSL。
2. 新增纯函数 `resolveVisibleTools(context)`，输入只包含模式、任务类型、模型能力、权限结果和可用扩展。
3. 默认 coding 回合只暴露 8–12 个常用工具；VFS/Plan 工具仅在对应模式出现。
4. QA 回合继续只读；审批工具是否出现仍由权限和会话状态决定。
5. 兼容旧工具：未声明元数据时按 `core`，避免一次性改完所有工具。

**验收**：注册表工具数不变；不同模式的 schema 快照稳定；默认回合不再看到全部 VFS/Plan 工具；权限拒绝的工具不会出现在 schema。

### B-01B：Deferred tools 与 tool search

**依赖**：B-01A。

**允许修改**：

- `routedev/src/tools/adapter.ts`
- `routedev/src/tools/builtin/tool-search.ts`（新）
- `routedev/src/runtime/app-init-tools.ts`
- 对应测试

**实施**：

1. `tool_search` 只搜索本地已注册但未暴露的工具元数据，不执行工具、不绕过权限。
2. 返回最多 5 个候选的名称、单句用途和参数摘要；模型选择后仅对当前 turn 暴露。
3. Web、browser、repo map、code graph、notes、MCP 等低频工具改为 deferred 候选。
4. 不实现向量检索；先用名称、标签和描述的确定性评分。

**验收**：默认 schema token 明显低于基线；需要 Web/repo map 的任务仍能发现工具；deny 工具搜索不到。

### B-02A：去重系统提示与工具说明

**目标**：实际 tool schema 是工具参数的唯一事实源。

**允许修改**：

- `routedev/desktop/main/bridges/chat-bridge.ts`
- `routedev/src/prompts/manager.ts`
- `routedev/tests/prompts/**`

**实施**：

1. 从 `availableTools` 删除每个工具最长 240 字的描述，只保留必要的能力组摘要；若 schema 已传入，提示词不再复述参数。
2. 把提示分为稳定区和动态区：稳定身份/安全/执行纪律在前，workspace、session、skills、状态在后。
3. 增加系统提示字符数、估算 token、稳定前缀 hash 的快照测试。
4. 保留现有 Skill progressive disclosure，不把 Skill 全文放回主提示。

**验收**：行为指令不丢失；提示 token 和前缀变化率低于 B-00 基线；工具描述只存在于 schema。

### B-02B：Flash 最小提示 A/B

**依赖**：B-00、B-02A。

**实施**：

1. 参考 Pi 建立 `flash-compact` 提示变体，只保留身份、工具纪律、修改保护、验证、权限和完成定义。
2. 用 B-00 的 12 个任务与现有提示 A/B；完成率不能下降，平均输入 token 目标下降至少 15%。
3. 若完成率下降，保留 B-02A，撤回 compact 变体，不继续“凭感觉”删提示。

### B-03：基础工具组合与边界

**依赖**：B-01A。

**实施**：

1. 给 `file_search` 与 `code_search` 写清互斥职责：前者找文件/简单文本，后者做代码正则与上下文；若评测仍频繁混淆，合并为一个 `search` façade，底层实现不必删除。
2. 把 `git_op` 的读操作和写操作按权限元数据区分；`commit/push/pull/prune` 不得因一个工具名称而共同获得预授权。
3. 增加结构化 `diagnostics` 工具入口，先复用现有 typecheck/lint，不立即引入完整 LSP 服务器管理。
4. `list_directory`、`file_read`、`file_edit`、`shell_exec`、`search`、`todo_write`、`ask_user`、`spawn_agent` 形成 Flash 默认核心候选。

**验收**：工具选择冲突任务的无效调用数下降；危险 Git 子命令权限测试通过；无新增运行时依赖。

### B-04：修改后自动验证

**允许修改**：

- `routedev/desktop/main/bridges/chat-bridge.ts`
- `routedev/src/agent/completion-gate.ts`
- 对应测试

**实施**：

1. 触发条件改为“本 turn 有文件修改”，而不是用户是否提到测试词。
2. 根据变更文件选择最小验证：配置/文档只做格式或跳过并说明；TypeScript 先相关测试/类型检查；未知项目使用已有项目命令发现机制。
3. 高成本全量测试仍需显式用户要求或策略允许；默认只做小而相关的检查。
4. 验证失败回到同一 turn 的修复预算；达到上限后明确报告，不无限循环。

**验收**：普通“修复这个 bug”任务在写文件后会验证；文档任务不会误跑全量测试；失败与跳过都有 EngineEventV1。

### B-05A：简化 spawn_agent

**允许修改**：

- `routedev/src/tools/builtin/spawn-agent.ts`
- `routedev/src/agents/subagent-registry.ts`
- 对应测试

**实施**：

1. schema 仅要求 `description`、`prompt`；`model` 默认 `inherit`。
2. 对模型暴露 3 个稳定角色：`explore`、`implement`、`review`；旧 7 角色在内部保留兼容映射，不立刻删除。
3. `explore` 默认只读，不提供 `ask_user` 和写入工具，避免子 Agent 死锁或越权。
4. 描述中给出清楚的“何时不要 spawn”：单文件、一步可完成任务直接执行。

**验收**：两字段调用成功；旧调用仍兼容；Explore 写入被拒绝；子 Agent 不能递归 spawn。

### B-05B：子 Agent 生命周期工具

**依赖**：B-05A、现有 Kernel/EventV1 一致性测试。

**实施**：只在现有 API 缺失时补 `list_agents`、`stop_agent`、`send_agent_message`、`resume_agent`；全部复用现有 session/registry/event，不创建另一管理器。后台运行默认只给只读 Explore，写入型 Agent 先保持前台串行。

**验收**：停止、恢复、消息发送和父会话 abort 的状态一致；全局 FIFO 不被绕过。

### B-06：DeepSeek V4 Flash GA 契约语料

**允许修改**：

- `routedev/src/router/llm/deepseek-client.ts`
- `routedev/src/agent/loop.ts`（仅在测试证明需要时）
- `routedev/tests/router/deepseek-v4-flash-ga.test.ts`（新）
- fixtures

**实施**：

1. 固定测试：无工具回答、单工具、连续工具、并行工具、reasoning_content、空 content、有 content+tool_calls、参数截断、非法 JSON、重复 tool id、流中断和重试。
2. 记录 provider 原始事件到脱敏 fixture；修复必须在 DeepSeek adapter 或协议归一化层完成。
3. 测试不同 schema 数量（8/12/20/40）对首轮选对工具率和输入 token 的影响。
4. 不将 DeepSeek 特例写进 PermissionEngine、Kernel 或通用工具实现。

**验收**：所有 fixture 归一化为相同内部事件契约；未知格式 fail-closed 或明确失败，不静默丢工具调用。

### B-07：压缩恢复与上下文预算

**依赖**：B-00、B-02。

**实施**：

1. 在现有 compaction 输入中跟踪最近读取文件、最近修改文件、图片引用和未完成 Todo。
2. 压缩后恢复紧凑清单，不恢复完整工具输出；路径必须再次经过 workspace boundary。
3. EngineEventV1 增加前后 token、删减类型、恢复项数和耗时；桌面只做轻量展示。
4. 增加有效 turn boundary 测试，禁止在 tool_call/tool_result 中间切断。

**验收**：压缩后能继续编辑最近文件；无图片时不注入空块；恢复清单有上限；缓存前缀测试稳定。

### B-08～B-12：P1 收敛批次

这些任务按顺序执行，每个继续遵守“最多 5 个生产文件”的限制：

- **B-08 权限回归**：为 shell 链接符、子 shell、重定向、别名、大小写、路径转义建立 deny 优先测试；复用 PermissionEngine。
- **B-09 代码理解**：先接 `lsp_diagnostics` 与 token-budgeted repo map；用 B-00 证明收益后再考虑 definition/references 和 Notebook。
- **B-10 大结果处理**：统一工具输出上限、截断元数据和可回读 receipt；禁止 sanitizer 失败返回原文。
- **B-11 生命周期**：补全子 Agent list/stop/send/resume UI 和审计，不开放写入型并行。
- **B-12 一致性**：同一 run 对 Kernel、Trace、桌面、SSE/Android timeline 做 session/turn/sequence/status 逐项断言。

### B-13～B-17：P2 生产增强

只有 P0 全绿且 B-00 显示没有回归时进入：

- **B-13 Checkpoint**：恢复前展示文件差异；分别选择“仅文件”“文件+会话”；权限授权和远程 ACL 永不随 checkpoint 回滚。
- **B-14 Capability**：Provider/MCP/Skill 声明工具调用、图像、并行、流式和最大 schema 能力；不支持时显式降级。
- **B-15 Headless**：将 EngineEventV1 输出为 versioned JSONL；stdin 接任务；退出码区分成功、拒绝、验证失败和内部错误。
- **B-16 Isolation**：先实现 task worktree；容器后端另立可选 adapter。禁止改变默认本地路径。
- **B-17 Extension governance**：能力版本、最小 RouteDev 版本、权限清单、数据访问和故障隔离；不新增第二套配置语言。

## 7. 项目借鉴点到任务 ID 的完整映射

| 项目 | 源码/公开机制复核后的借鉴点 | 任务 |
|---|---|---|
| OpenAI Codex CLI | 按回合/模型/环境解析工具；Direct/Hidden/ModelOnly；稳定事件与批准协议 | B-01、B-08、B-12、B-15 |
| OpenCode | per-agent 工具/权限、旧工具输出 pruning、简单角色代理 | B-01、B-05、B-07、B-10、B-11 |
| Reasonix | prompt cache shape、DeepSeek 协议、路径绑定工具、LSP diagnostics | B-02、B-06、B-08、B-09 |
| Open Interpreter | 可版本化 harness profile、原生沙箱+execpolicy、审批与角色层叠 | B-02、B-08、B-14；不建第二内核 |
| Pi | 极简动态提示、四工具核心、turn boundary、分支/压缩扩展 | B-02、B-03、B-07 |
| Qwen Code | lazy tool registry、tool search、权限防绕过、完整工具、压缩恢复、子 Agent、hooks/checkpoint/headless/telemetry | B-01～B-08、B-11、B-13、B-15、B-17 |
| Cline | diff-first 审批、checkpoint、文件上下文跟踪、任务可见性 | B-07、B-12、B-13 |
| Roo Code | 按模式工具组与自定义模式、影子 Git checkpoint、condense 压缩 | B-05、B-07、B-13、B-17 |
| Kilo Code | opencode v2 重写：agent 模式提示词、PermissionV2、锚定摘要压缩、沙箱与网关 | B-05、B-08、B-14、B-16、B-17 |
| OpenHands | runtime adapter、typed event、sandbox、上下文/工具可视化 | B-12、B-16 |
| Plandex | plan/apply 校验-修复循环、context packs、多文件 diff 审查、subtask | B-04、B-07、B-11、B-13 |
| Aider | PageRank repo map、模型 edit format、修改后 lint/test | B-04、B-09 |
| Goose | tool schema normalize/toolshim、扩展能力、权限与大响应处理 | B-08、B-10、B-14、B-17 |
| SWE-agent | bundle 化 ACI+blocklist、exit_status 失败分类、轨迹 replay、cost limit | B-00、B-02、B-16 |
| mini-swe-agent | 小循环、step/cost limit、YAML 实验配置 | B-00、B-02；只作最小内核对照 |
| OpenHarness | 生产级多角色编排、权限三模式与敏感路径硬拒、会话快照、headless | B-08、B-11、B-13、B-15 |
| jcode | 静态/动态提示词分区、工具发现、破坏性命令门禁、会话恢复/replay | B-01、B-02、B-08、B-12；不建第二 TUI |
| Continue | context provider、按模型能力解析工具、CLI headless | B-14、B-15、B-17 |
| Kimi Code | 模型原生协议适配、0.85/50k 自动压缩与交接摘要、子 agent 档案 | B-06、B-07、B-11、B-14 |
| Trae Agent | trajectory JSON 双轨结构、task_done+diff 校验、SWE-bench runner | B-00、B-04、B-18 |
| MiniMax Mini-Agent | MiniMax 双协议适配（thinking 持久化）、按轮次摘要压缩 | B-06、B-07、B-14 |
| MiMoCode | 分模型提示词路由、按模型切换工具集、actor 子 agent 动词化 | B-02、B-05、B-06、B-14 |
| CodeWhale | DeepSeek 原生事件、ToolSurfaceBudget、deferred tools、context/tool-call budget | B-01、B-06、B-07、B-10 |
| ZCode Agent | 子 Agent 角色入口文案，源码不可验证 | B-05 的 UX 参考，不作实现证据 |
| MiniMax Code | issue 分类和支持入口，运行时源码不可验证 | 进入治理文档，不影响核心架构 |
| Tencent CodeBuddy Code | 中文 onboarding、企业策略表达 | B-17 文档层 |
| Baidu Comate | 管理员策略和数据边界说明 | B-17 文档层 |

## 8. 直接源码证据

以下仓库均固定到本轮实际读取的 commit，避免把 README 宣传当实现：

- Qwen Code `8566385a66b1b85791cdb4141d673540313f69d9`：[`config.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/config/config.ts)、[`prompts.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/core/prompts.ts)、[`chatCompressionService.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/services/chatCompressionService.ts)、[`agent.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/tools/agent/agent.ts)、[`builtin-agents.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/subagents/builtin-agents.ts)、[`permission-manager.ts`](https://github.com/QwenLM/qwen-code/blob/8566385a66b1b85791cdb4141d673540313f69d9/packages/core/src/permissions/permission-manager.ts)。
- OpenAI Codex `2a16af823456712e3dbb030ecf29fb727c2cde66`：[`spec_plan.rs`](https://github.com/openai/codex/blob/2a16af823456712e3dbb030ecf29fb727c2cde66/codex-rs/core/src/tools/spec_plan.rs)。
- Pi `b784c80961c29451c4665a6ccca15089cb36e0eb`：[`system-prompt.ts`](https://github.com/badlogic/pi-mono/blob/b784c80961c29451c4665a6ccca15089cb36e0eb/packages/coding-agent/src/core/system-prompt.ts)、[`agent-loop.ts`](https://github.com/badlogic/pi-mono/blob/b784c80961c29451c4665a6ccca15089cb36e0eb/packages/agent/src/agent-loop.ts)。
- Aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`：[`repomap.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)、[`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py)。
- OpenCode `c387fe190bbd22e9396d264effe242d157f866d2`：[`tools.ts`](https://github.com/anomalyco/opencode/blob/c387fe190bbd22e9396d264effe242d157f866d2/packages/opencode/src/session/tools.ts)、[`compaction.ts`](https://github.com/anomalyco/opencode/blob/c387fe190bbd22e9396d264effe242d157f866d2/packages/opencode/src/session/compaction.ts)、[`agent.ts`](https://github.com/anomalyco/opencode/blob/c387fe190bbd22e9396d264effe242d157f866d2/packages/opencode/src/agent/agent.ts)。
- Reasonix `9b3a452f1fe81d0f8f70dfe61c8d8715bd8936f4`：[`cache_shape.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/9b3a452f1fe81d0f8f70dfe61c8d8715bd8936f4/internal/agent/cache_shape.go)、[`run_loop.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/9b3a452f1fe81d0f8f70dfe61c8d8715bd8936f4/internal/agent/run_loop.go)、[`tool.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/9b3a452f1fe81d0f8f70dfe61c8d8715bd8936f4/internal/lsp/tool.go)。
- CodeWhale `b63e48331b7d06e0517970cd9b9033a4cbbe6fff`：[`tool_catalog.rs`](https://github.com/Hmbown/CodeWhale/blob/b63e48331b7d06e0517970cd9b9033a4cbbe6fff/crates/tui/src/core/engine/tool_catalog.rs)、[`context_budget.rs`](https://github.com/Hmbown/CodeWhale/blob/b63e48331b7d06e0517970cd9b9033a4cbbe6fff/crates/tui/src/context_budget.rs)、[`model_profile.rs`](https://github.com/Hmbown/CodeWhale/blob/b63e48331b7d06e0517970cd9b9033a4cbbe6fff/crates/tui/src/model_profile.rs)。
- mini-swe-agent `a83fcae82d2a08f0ee0c688f9d137b3566c097f8`：[`default.py`](https://github.com/SWE-agent/mini-swe-agent/blob/a83fcae82d2a08f0ee0c688f9d137b3566c097f8/src/minisweagent/agents/default.py)、[`mini.yaml`](https://github.com/SWE-agent/mini-swe-agent/blob/a83fcae82d2a08f0ee0c688f9d137b3566c097f8/src/minisweagent/config/mini.yaml)。
- Cline `5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa`：[`prompt.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/runtime/prompt.ts)、[`tools.ts`](https://github.com/cline/cline/blob/5ec2d47b21b3a09aa7a094bfbbe0c7e8f7ddd3fa/apps/cli/src/runtime/tools.ts)。
- Goose `7f62ce53e70c49e634ed9ba16a1ef8e02a2d239c`：[`prompt_manager.rs`](https://github.com/aaif-goose/goose/blob/7f62ce53e70c49e634ed9ba16a1ef8e02a2d239c/crates/goose/src/agents/prompt_manager.rs)、[`subagent_handler.rs`](https://github.com/aaif-goose/goose/blob/7f62ce53e70c49e634ed9ba16a1ef8e02a2d239c/crates/goose/src/agents/subagent_handler.rs)。
- SWE-agent `3ea751c087f32b16e039a2233dd6eefecef325d5`：[`agents.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py)、[`tools.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/tools/tools.py)、[`history_processors.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/history_processors.py)（默认仅 3 个工具可见；exit_status 失败分类；无 max_steps；无自动验证）。
- OpenHarness `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`：[`query.py`](https://github.com/HKUDS/OpenHarness/blob/9b2efd795c6aa09f88b0c257d269a9e518da6ae7/src/openharness/engine/query.py)、[`permissions/checker.py`](https://github.com/HKUDS/OpenHarness/blob/9b2efd795c6aa09f88b0c257d269a9e518da6ae7/src/openharness/permissions/checker.py)、[`system_prompt.py`](https://github.com/HKUDS/OpenHarness/blob/9b2efd795c6aa09f88b0c257d269a9e518da6ae7/src/openharness/prompts/system_prompt.py)、[`swarm/`](https://github.com/HKUDS/OpenHarness/tree/9b2efd795c6aa09f88b0c257d269a9e518da6ae7/src/openharness/swarm)（MIT、Claude Code Python 移植、权限三模式、约 5k 行 swarm、无 benchmark）。
- jcode `156ae409250c20f7b3dd530ff282d8367d6d5cd5`：[`agent/prompting.rs`](https://github.com/1jehuang/jcode/blob/156ae409250c20f7b3dd530ff282d8367d6d5cd5/crates/jcode-app-core/src/agent/prompting.rs)、[`agent/compaction.rs`](https://github.com/1jehuang/jcode/blob/156ae409250c20f7b3dd530ff282d8367d6d5cd5/crates/jcode-app-core/src/agent/compaction.rs)、[`tool/mod.rs`](https://github.com/1jehuang/jcode/blob/156ae409250c20f7b3dd530ff282d8367d6d5cd5/crates/jcode-app-core/src/tool/mod.rs)、[`tool/bash_destructive_gate.rs`](https://github.com/1jehuang/jcode/blob/156ae409250c20f7b3dd530ff282d8367d6d5cd5/crates/jcode-app-core/src/tool/bash_destructive_gate.rs)（Rust 重写；SplitSystemPrompt 静态/动态分区；discover 工具发现；破坏性命令门禁）。
- Plandex `e2d772072efadbe41d2946d97d79be55532dbab5`：[`tell_stream_main.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/tell_stream_main.go)、[`build_validate_and_fix.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_validate_and_fix.go)、[`prompts/chat.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/prompts/chat.go)（build 阶段校验-修复循环；subtask；context packs）。
- Continue `5522c6f44ca0ac3528b37244818fbfa39b5af470`：[`streamNormalInput.ts`](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/redux/thunks/streamNormalInput.ts)、[`countTokens.ts`](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/llm/countTokens.ts)、[`core/tools/`](https://github.com/continuedev/continue/tree/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/tools)（loop 在 GUI；9 基础工具+按模型能力解析；无内置验证；CLI 子 agent 放开权限）。
- Open Interpreter `855ab60c0e10dac6bc89f3e248cba3746d44f034`：[`session/turn.rs`](https://github.com/OpenInterpreter/open-interpreter/blob/855ab60c0e10dac6bc89f3e248cba3746d44f034/codex-rs/core/src/session/turn.rs)、[`tools/src/harness.rs`](https://github.com/OpenInterpreter/open-interpreter/blob/855ab60c0e10dac6bc89f3e248cba3746d44f034/codex-rs/tools/src/harness.rs)、[`core/src/compact.rs`](https://github.com/OpenInterpreter/open-interpreter/blob/855ab60c0e10dac6bc89f3e248cba3746d44f034/codex-rs/core/src/compact.rs)、[`sandboxing/`](https://github.com/OpenInterpreter/open-interpreter/tree/855ab60c0e10dac6bc89f3e248cba3746d44f034/codex-rs/sandboxing)（Rust 重写确认；许可改为 Apache-2.0；15+ harness profile；原生沙箱+execpolicy）。
- Kimi Code `c32e661faa931df9fdc72e63230f3ebebc00dce5`：[`loopService.ts`](https://github.com/MoonshotAI/kimi-code/blob/c32e661faa931df9fdc72e63230f3ebebc00dce5/packages/agent-core-v2/src/agent/loop/loopService.ts)、[`fullCompactionService.ts`](https://github.com/MoonshotAI/kimi-code/blob/c32e661faa931df9fdc72e63230f3ebebc00dce5/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts)、[`permissionPolicy/`](https://github.com/MoonshotAI/kimi-code/tree/c32e661faa931df9fdc72e63230f3ebebc00dce5/packages/agent-core-v2/src/agent/permissionPolicy)（MIT、TypeScript；0.85 触发/50k 预留压缩；manual/yolo/auto 权限模式；原生 builtin_function 协议）。
- MiMoCode `6674db7a34053fe0ffc4813856ad43d8d91a1209`：[`session/prompt.ts`](https://github.com/XiaomiMiMo/MiMo-Code/blob/6674db7a34053fe0ffc4813856ad43d8d91a1209/packages/opencode/src/session/prompt.ts)、[`session/system.ts`](https://github.com/XiaomiMiMo/MiMo-Code/blob/6674db7a34053fe0ffc4813856ad43d8d91a1209/packages/opencode/src/session/system.ts)、[`tool/registry.ts`](https://github.com/XiaomiMiMo/MiMo-Code/blob/6674db7a34053fe0ffc4813856ad43d8d91a1209/packages/opencode/src/tool/registry.ts)（MIT；opencode 派生 fork；15 份分模型提示词；按模型切换工具集）。
- MiniMax Mini-Agent `d76a4f6389688cabda39c224a6cdfa274215d47c`：[`agent.py`](https://github.com/MiniMax-AI/Mini-Agent/blob/d76a4f6389688cabda39c224a6cdfa274215d47c/mini_agent/agent.py)、[`llm/anthropic_client.py`](https://github.com/MiniMax-AI/Mini-Agent/blob/d76a4f6389688cabda39c224a6cdfa274215d47c/mini_agent/llm/anthropic_client.py)、[`llm/openai_client.py`](https://github.com/MiniMax-AI/Mini-Agent/blob/d76a4f6389688cabda39c224a6cdfa274215d47c/mini_agent/llm/openai_client.py)（MIT；双协议适配+thinking 持久化；teaching-level demo；无权限/子 Agent/checkpoint）。
- Trae Agent `e839e559ac61bdd0e057c375dd1dee391fee797d`：[`base_agent.py`](https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/trae_agent/agent/base_agent.py)、[`trajectory_recorder.py`](https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/trae_agent/utils/trajectory_recorder.py)、[`run_evaluation.py`](https://github.com/bytedance/trae-agent/blob/e839e559ac61bdd0e057c375dd1dee391fee797d/evaluation/run_evaluation.py)（task_done+must_patch；轨迹记录无回放；SWE-bench runner；近 6 个月停更）。
- Roo Code `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`：[`Task.ts`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts)、[`prompts/system.ts`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/system.ts)、[`shared/modes.ts`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/shared/modes.ts)、[`checkpoints/index.ts`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/checkpoints/index.ts)、[`condense/index.ts`](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/condense/index.ts)（按模式工具组；影子 Git checkpoint；5% 阈值 condense）。
- Kilo Code `692b89c8eb792e9523a7f8e939097ed86dcf82c2`：[`opencode/src/agent/agent.ts`](https://github.com/Kilo-Org/kilocode/blob/692b89c8eb792e9523a7f8e939097ed86dcf82c2/packages/opencode/src/agent/agent.ts)、[`core/src/permission.ts`](https://github.com/Kilo-Org/kilocode/blob/692b89c8eb792e9523a7f8e939097ed86dcf82c2/packages/core/src/permission.ts)、[`core/src/session/compaction.ts`](https://github.com/Kilo-Org/kilocode/blob/692b89c8eb792e9523a7f8e939097ed86dcf82c2/packages/core/src/session/compaction.ts)、[`opencode/src/agent/prompt/`](https://github.com/Kilo-Org/kilocode/tree/692b89c8eb792e9523a7f8e939097ed86dcf82c2/packages/opencode/src/agent/prompt)（MIT；opencode v2 重写；PermissionV2；锚定摘要压缩；kilo-sandbox/gateway）。

## 9. 每阶段退出门槛

### P0 完成

- B-00～B-06 全部有自动测试。
- Flash 默认可见工具不超过 12 个；特殊任务通过 mode 或 tool search 获取额外能力。
- 系统提示不再重复 tool schema，且有 token/稳定前缀快照。
- 任意代码修改都会进入最小验证策略。
- `spawn_agent` 两个必填字段可用，Explore 只读。
- DeepSeek GA 协议 fixture 全部归一化且错误不静默。
- 12 个基础任务完成率不低于基线，无效工具调用和输入 token 至少一项显著下降。

### P1 完成

- 压缩后能恢复最近文件/图片/Todo，且 UI 可解释上下文消耗。
- shell 绕过、安全拒绝、大结果截断和子 Agent 生命周期测试通过。
- Kernel/Trace/桌面/远程事件具备统一契约测试。

### P2 完成

- checkpoint 范围明确，headless 事件协议版本化。
- provider capability、worktree/容器隔离和扩展治理不绕过现有权限、ACL、审计和 FIFO。
- 原综合生产化台账中的 CI、签名、双设备和 SSRF 动态验证项全部按证据更新状态。

## 10. 明确不做

- 不因为竞品有更多工具就默认把更多 schema 塞给模型；目标是**可发现但少暴露**。
- 不为 DeepSeek 单独复制 Agent loop。
- 不把 7 个子 Agent 角色扩成 team/swarm；先降低调用摩擦并验证单 Agent 瓶颈。
- 不默认自动提交、不默认并行写入、不允许 checkpoint 回滚权限与 ACL。
- 不在 P0 完成前新增插件市场、第二 CLI/TUI、通用 workflow DSL 或多租户平台。
