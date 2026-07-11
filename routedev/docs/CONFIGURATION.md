# RouteDev 配置参考

> 本文档列出 RouteDev 所有配置项，按模块分组。
> 配置文件位置：
> - **全局配置**：平台特定 AppData 目录下的 `config.yaml`
>   - Windows: `%APPDATA%\RouteDev\config.yaml`
>   - macOS: `~/Library/Application Support/RouteDev/config.yaml`
>   - Linux: `~/.config/routedev/config.yaml`
> - **项目级配置**：项目根目录下的 `.routedev.yaml`
> 所有配置项均通过 Zod Schema 校验，非法值会在启动时报错。

## 1. 顶层结构

```yaml
general:
  language: zh-CN
providers: []
router: {}
agent: {}
autonomy:
  defaultMode: semi
checkpoint: {}
mcp: {}
import: {}
ui: {}
security: {}
# Phase 50 新增：
goalIntegration: {}
orchestrationIntegration: {}
delegationIntegration: {}
phase48Integration: {}
phase49Integration: {}
# Phase 81 新增：能力 Pack 开关 + 工具注册档位
packs: {}
tools:
  profile: core
```

## 2. Phase 50 新增配置项

### 2.1 goalIntegration（Task 1：/goal 流程接入）

```yaml
goalIntegration:
  # 是否启用目标持久化到 .routedev/goals/
  persistenceEnabled: true
  # 是否启用多层目标审计（CompletionGate + VerifierLLM + ReviewerAgent 三层仲裁）
  auditEnabled: true
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `persistenceEnabled` | boolean | true | 开启后 plan 生成后调用 `GoalPersistence.save` 持久化到 `.routedev/goals/<id>.json` |
| `auditEnabled` | boolean | true | 开启后 verify 阶段调用 `GoalAuditor.audit` 执行三层独立审计 |

### 2.2 orchestrationIntegration（Task 2：多 Agent 编排接入）

```yaml
orchestrationIntegration:
  # 是否启用按复杂度自动选择策略（sequential/parallel/adaptive）
  strategyEnabled: false
  # 是否启用步骤级状态机管理
  stateGraphEnabled: false
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `strategyEnabled` | boolean | false | 开启后 `Orchestrator.plan` 按 GoalPlan 步骤数选择策略（≤2=sequential, 3-6=parallel, >6=adaptive） |
| `stateGraphEnabled` | boolean | false | 开启后 `Orchestrator` 用 `ExecutionStateGraph` 管理步骤状态转换（pending→running→completed） |

### 2.3 delegationIntegration（Task 3：子 Agent 委托体系接入）

```yaml
delegationIntegration:
  # 是否启用上下文打包（按角色权重收集代码符号）
  contextPackerEnabled: true
  # 是否启用委托门控（spawn 前检查资格）
  delegationGateEnabled: true
  # 是否启用契约校验（执行中校验工具调用合规）
  delegationEnforcerEnabled: true
  # 是否启用生命周期管理 + 反滥用检测
  lifecycleEnabled: true
  # 是否启用评分卡收集
  scoreCardEnabled: true
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextPackerEnabled` | boolean | true | 开启后 `spawn_agent` 调用前用 `ContextPacker.pack` 按角色打包上下文附加到 prompt |
| `delegationGateEnabled` | boolean | true | 开启后 `spawn_agent` 调用前用 `DelegationGate.checkDelegationEligibility` 检查资格，不合格拒绝 |
| `delegationEnforcerEnabled` | boolean | true | 开启后创建 `DelegationContract` + `DelegationEnforcer` 校验工具调用合规（自动激活 `delegation-contract.ts`） |
| `lifecycleEnabled` | boolean | true | 开启后用 `SubAgentLifecycle` 注册子 Agent 状态转换（pending→running→completed/failed）+ 反滥用检测 |
| `scoreCardEnabled` | boolean | true | 开启后执行完成用 `SubAgentScoreCardCollector` 记录评分卡（角色/满意度/Token 使用） |

### 2.4 ui.components（Task 7：React 组件接入）

> ⚠️ 以下 UI 组件配置项已随终端 UI 退役（Phase 72）废弃，仅作历史参考。桌面端不消费这些配置。

```yaml
ui:
  components:
    # 分支切换器（ChatPage 顶部）
    branchSwitcher: true
    # 恢复执行选择器（/resume 多快照时触发）
    resumePicker: true
    # 进度条（TaskMonitorPanel 任务进度）
    progressBar: true
    # Trace 面板（/trace view 命令触发，默认关闭需交互式输入）
    tracePanel: false
    # 渐进披露（系统消息 >200 字符时包裹）
    disclosureLevel: true
    # Diff 视图（/diff 命令触发）
    diffView: true
    # 配置变更通知（配置热重载时顶部通知）
    configReloadNotice: true
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `branchSwitcher` | boolean | true | 关闭后 ChatPage 顶部不渲染分支切换器 |
| `resumePicker` | boolean | true | 关闭后 `/resume` 多快照时回退到纯文本列表 |
| `progressBar` | boolean | true | 关闭后 TaskMonitorPanel 不显示进度条 |
| `tracePanel` | boolean | false | 开启后 `/trace view` 触发 TracePanel 组件渲染（默认关闭：需交互式 Ink 输入） |
| `disclosureLevel` | boolean | true | 关闭后系统消息不包裹渐进披露层 |
| `diffView` | boolean | true | 关闭后 `/diff` 命令回退到纯文本 diff |
| `configReloadNotice` | boolean | true | 关闭后配置热重载时不弹出顶部通知 |

### 2.5 phase48Integration（Task 5：Phase 48 模块接入确认）

```yaml
phase48Integration:
  # 引用系统（CiteResolver 在 sendUserMessage 前调用）
  citeEnabled: true
  # 外部生态导入（Claude Plugin / Codex Instructions 导入器）
  importEnabled: true
  # 宏系统（! 触发器 + Macro 执行）
  macrosEnabled: true
  # MCP 桥接（.mcp.json 加载 + 多协议支持）
  mcpBridgeEnabled: true
```

注：Phase 48 模块默认 `true`（已在 Phase 48 验证稳定性），可通过配置关闭。

### 2.6 phase49Integration（Task 6：Phase 49 模块接入确认）

```yaml
phase49Integration:
  # 双循环编排器（Inner ReAct + Outer 验证）
  dualLoopEnabled: true
  # Skill 质量门（三层检查 + 模型漂移检测）
  qualityGateEnabled: true
```

注：Phase 59 已删除 `skillFlowEnabled` / `contextUsagePanelEnabled` / `evaluationFrameworkEnabled` / `routingFunnelEnabled`（对应源模块已在 Phase 59/72-74 死代码清理中删除，开关无效）。剩余两项默认 `true`（已在生产验证稳定性）。

## 3. 渐进接入原则

所有 Phase 50 接入模块遵循以下原则：

1. **默认 `enabled: false`**：除 Phase 48 模块（已在 Phase 48 验证）和 UI 组件（默认 true）外，所有接入模块默认关闭
2. **try/catch 降级**：每个接入点均有 try/catch 兜底，接入失败时降级到原行为而非崩溃
3. **配置开关**：在 `src/config/schema.ts` 有对应的 Zod schema 字段
4. **设置页面入口**：在 `SettingsPage.tsx` 有对应控件（Phase 50 Task 7 接入 UI 组件，其他模块的设置入口在后续 Phase 补全）
5. **代码接线点明确**：每个模块的接入点在 `docs/ARCHITECTURE.md` 第 6 节有详细说明

## 4. 配置示例

### 4.1 最小配置（所有 Phase 50 模块关闭）

```yaml
providers: []
goalIntegration:
  persistenceEnabled: false
  auditEnabled: false
orchestrationIntegration:
  strategyEnabled: false
  stateGraphEnabled: false
delegationIntegration:
  contextPackerEnabled: false
  delegationGateEnabled: false
  delegationEnforcerEnabled: false
  lifecycleEnabled: false
  scoreCardEnabled: false
```

### 4.2 全功能配置（所有 Phase 50 模块开启）

```yaml
providers: []
goalIntegration:
  persistenceEnabled: true
  auditEnabled: true
orchestrationIntegration:
  strategyEnabled: true
  stateGraphEnabled: true
delegationIntegration:
  contextPackerEnabled: true
  delegationGateEnabled: true
  delegationEnforcerEnabled: true
  lifecycleEnabled: true
  scoreCardEnabled: true
phase49Integration:
  dualLoopEnabled: true
  qualityGateEnabled: true
ui:
  components:
    tracePanel: true
```

## 5. 配置热重载

RouteDev 支持配置热重载：修改配置文件后无需重启，引擎会自动重新初始化。配置变更时：
- 受影响的模块会重新创建实例（如 `GoalAuditor`、`ContextPacker` 等）
- 对话历史和当前执行状态会保留

## 6. 能力包（Capability Packs）

> **Phase 81-82 新增。** 对齐 `docs/CAPABILITY_LAYERS.md` 四层分层模型。
> **Schema 定义：** `src/config/schema-observability.ts` → `PacksConfigSchema`
> **默认值：** `src/config/defaults.ts` → `packs` 字段（全部默认 `false`）

### 6.1 设计理念

RouteDev 采用 **默认 Core + 按需 Pack** 的能力装配模型：

- **Core 层**：默认开启，包含编程场景基础能力（≤10 个核心工具 + 必要子系统），不可关闭。
- **Extended Pack（高级区）**：默认关，用户能自建但预设更好用，修 bug 不扩功能。
- **Standard Pack（扩展区）**：默认关，几乎用到的可选能力，冷处理仅修崩溃。
- **Freeze（实验区）**：默认关且 UI 禁用，停止接线，不推荐启用。

每个 Pack 仅一个开关 `enabled: boolean`，消费方按 `config.packs.<id>.enabled` 条件装配。
用户可在设置页「能力分层」Tab 可视化切换，或直接编辑配置文件。

### 6.2 工具注册档位

除 Pack 开关外，`tools.profile` 控制工具注册范围：

| 档位 | 说明 | 默认 |
|------|------|------|
| `core` | 仅注册 ≤10 个核心工具（file-read/write/edit/search、list-directory、shell-exec、git-op、code-search、ask-user、todo-write） | ✅ |
| `full` | 注册全部工具（兼容旧行为，仅调试用） | — |

### 6.3 全部 14 个 Pack 开关

#### Extended Pack（高级区，4 个）

| Pack ID | 配置开关 | 说明 | 成本提示 |
|---------|----------|------|----------|
| `goalAdvanced` | `packs.goalAdvanced.enabled` | Goal 高级编排：/goal 执行器 + DAG 引擎 + 双循环 + 有界恢复 + 预算监控 | 系统提示 +2~4k tokens；双循环恢复额外调用 LLM |
| `multiAgent` | `packs.multiAgent.enabled` | Multi-Agent 编排：spawn-agent + orchestrator + worker + 冲突检测 + 熔断 | 子 Agent 消耗独立 token 预算，并行上限默认 3 |
| `adversarial` | `packs.adversarial.enabled` | 对抗审查：UnifiedReviewer + 跨模型审查 + 分级审查策略 | 每次审查额外调用 1 次 LLM |
| `skillLifecycle` | `packs.skillLifecycle.enabled` | Skill 生命周期：SkillLifecycleManager 自动提炼与精炼技能 | 后台周期性 LLM 调用，磁盘写入 .routedev/skills/ |

#### Standard Pack（扩展区，7 个）

| Pack ID | 配置开关 | 说明 | 成本提示 |
|---------|----------|------|----------|
| `browserWeb` | `packs.browserWeb.enabled` | 浏览器/Web：web-search + web-fetch + browser + 视觉助手 | 按实际调用计费；视觉助手需图片输入 |
| `codeMap` | `packs.codeMap.enabled` | 代码地图：code-graph-query + repo-map + CodeMapEngine + Watcher | 首次扫描耗内存 ~50MB；watch 模式持续监听 |
| `ccrCompression` | `packs.ccrCompression.enabled` | CCR 压缩：ccr-retrieve 可逆压缩 + ComposePipeline 组合编排 | 压缩缓存占磁盘空间 |
| `vfsPlan` | `packs.vfsPlan.enabled` | VFS/Plan 工具：虚拟文件系统 + 计划状态显式管理 | Agent 工作内存占用略增 |
| `harness` | `packs.harness.enabled` | Harness：Trace 回放 + 评分卡 + 并行实验 | trace 文件持续累积需定期清理 |
| `integrity` | `packs.integrity.enabled` | 完整性校验：cite / import / macros / mcpBridge / IntegrityManifest | 外部导入增加启动时间 |
| `compose` | `packs.compose.enabled` | Compose 管道：阶段提示词注入与自动流转 | 多阶段任务 token 开销增加 |

#### Freeze（实验区，3 个，UI 禁用）

| Pack ID | 配置开关 | 说明 | 成本提示 |
|---------|----------|------|----------|
| `trustGradient` | `packs.trustGradient.enabled` | TrustGradient：渐进式信任梯度动态升级（Phase 79 已冻结） | 已冻结——动态升级无证据，启用仅作展示 |
| `kgAdvanced` | `packs.kgAdvanced.enabled` | KG 高级算法：PageRank / 社区检测 | 已冻结——耗 CPU，tree-sitter + SQLite 已够用 |
| `acRouter` | `packs.acRouter.enabled` | ACRouter：闭环模型路由实验性高级部分 | 已冻结——可能引入路由抖动 |

### 6.4 配置示例

#### YAML：最小配置（仅 Core，所有 Pack 关闭）

```yaml
tools:
  profile: core
packs: {}
```

#### YAML：启用 Goal 高级编排 + Multi-Agent

```yaml
tools:
  profile: core
packs:
  goalAdvanced:
    enabled: true
  multiAgent:
    enabled: true
```

#### YAML：全功能配置（所有非 Freeze Pack 开启）

```yaml
tools:
  profile: core
packs:
  goalAdvanced:    { enabled: true }
  multiAgent:      { enabled: true }
  adversarial:     { enabled: true }
  skillLifecycle:  { enabled: true }
  browserWeb:      { enabled: true }
  codeMap:         { enabled: true }
  ccrCompression:  { enabled: true }
  vfsPlan:         { enabled: true }
  harness:         { enabled: true }
  integrity:       { enabled: true }
  compose:         { enabled: true }
```

#### JSON：等效配置（启用 Goal 高级编排 + Multi-Agent）

```json
{
  "tools": { "profile": "core" },
  "packs": {
    "goalAdvanced": { "enabled": true },
    "multiAgent":   { "enabled": true }
  }
}
```

### 6.5 迁移说明

- **旧配置兼容**：`packs` 字段缺省时 Zod `preprocess` 兜底为空对象，等价于所有 Pack 关闭（仅 Core 生效）。
- **`tools.profile: full`**：恢复 Phase 81 前的旧行为（全部工具注册），仅用于调试，生产环境不推荐。
- **Phase 81 前**：非 Core 模块通过 `*Integration.enabled` 散落各处控制；Phase 81 后统一收敛到 `packs.<id>.enabled`，旧 `*Integration` 开关保留但不影响 Pack 装配门控。
