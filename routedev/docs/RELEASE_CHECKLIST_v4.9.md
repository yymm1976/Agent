# RouteDev v4.9.0 发布验收清单

> **版本：** v4.9.0
> **日期：** 2026-07-11
> **来源：** Phase 85 Task 2（发布门禁）
> **对齐文档：** `docs/CAPABILITY_LAYERS.md` 四层分层 / `CHANGELOG.md` 版本历史 / `蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md`
> **目的：** v4.9.0 发布前的场景验收门禁，所有 Core 场景必须全部通过，Pack 场景在启用后必须通过，Freeze 验证必须不可达。

---

## 验收规则

- **Core 场景（1-10）**：默认装配即应通过，**全部通过**为发布必要条件
- **Extended Pack 场景（11-13）**：启用对应 Pack 后必须通过；未启用时不阻断发布
- **Standard Pack 场景（14-16）**：启用对应 Pack 后冒烟测试通过；未启用时不阻断发布
- **用户自建 Pack 场景（17-18）**：示例 Pack 必须可加载并受 PermissionEngine 管控
- **Freeze 验证（19-21）**：三条冻结代码路径必须在生产中不可达
- **指标报告**：与 Phase-80 基线对比，达成目标值
- **复选框说明**：`[x]` 通过 / `[ ]` 未通过 / `[-]` 不适用

---

## 1. Core 场景（必须通过）

> 对齐 `docs/CAPABILITY_LAYERS.md` 第 1 节 Core 层（C-01 ~ C-70，默认 on）。Core 场景失败即阻塞发布。

| # | 场景 | 验收标准 | 验收方法 | 结果 |
|---|------|----------|----------|------|
| 1 | 普通对话 + 流式输出 | 端到端可用，token 流式返回无中断 | 1) 启动应用 2) 在 ChatPage 发送"请用一段话介绍你自己" 3) 确认响应逐字流式渲染 4) 确认响应完整且无截断 | `[ ]` |
| 2 | 读文件 → 编辑 → 运行测试 → 解释 | 单 Agent 闭环完成四步 | 1) 准备一个含简单测试的项目 2) 让 Agent 读取 `src/foo.ts` 3) 让 Agent 修改为指定行为 4) 让 Agent 运行 `pnpm test` 5) 让 Agent 解释测试结果 6) 确认四步全部完成且无人工介入 | `[ ]` |
| 3 | 工具确认同意/拒绝 | 双向 IPC 正确，同意则执行、拒绝则中止 | 1) 配置一个 `confirm` 级工具（如 shell-exec 的 rm 命令） 2) 触发工具调用 3) 确认弹出确认框 4a) 点击"同意" → 确认工具执行并返回结果 4b) 重置后再次触发，点击"拒绝" → 确认工具未执行并返回 abort 原因 | `[ ]` |
| 4 | Checkpoint 回滚 | 工作区干净检查 + git checkout 正确还原 | 1) 在干净 git 工作区开始对话 2) 让 Agent 修改 `src/foo.ts` 并保存 3) 确认产生 checkpoint 4) 执行回滚 5) 确认 `git status` 干净 6) 确认 `src/foo.ts` 内容已还原 7) 确认脏工作区时回滚被拒绝（前置检查 fail-closed） | `[ ]` |
| 5 | Token/预算可见 | 设置页 + 对话页均可见 token 消耗与预算 | 1) 打开设置页 → 确认有预算配置项（perRequestLimit 等） 2) 在对话页发送一条消息 3) 确认对话页显示本次 token 消耗 4) 确认累计 token 可见 5) 触发 80% 预算警告 → 确认警告可见 6) 触发 100% 预算 → 确认执行中止 | `[ ]` |
| 6 | 权限固定规则 | deny / confirm / allow 按配置生效 | 1) 配置 `deny: ["rm -rf"]` → 确认 `rm -rf /` 被拒绝（含大小写绕过防护） 2) 配置 `confirm: ["git push"]` → 确认弹出确认框 3) 配置 `allow: ["git status"]` → 确认直接执行无确认 4) 确认 PermissionEngine 为唯一权限源（C-17） | `[ ]` |
| 7 | /tree 会话分支导航 | 跳转 + 继续对话正确 | 1) 在对话中创建多条分支（至少 3 节点） 2) 输入 `/tree` → 确认展示树结构且活跃节点高亮 3) 点击非活跃节点跳转 → 确认活跃分支切换 4) 在新分支继续对话 → 确认消息追加到正确分支 5) 确认旧分支未被污染 | `[ ]` |
| 8 | /fork 创建新分支 | 新旧分支独立，互不影响 | 1) 在活跃分支末尾执行 `/fork` 2) 确认新分支创建并自动切换 3) 在新分支输入"方案 A" 4) 切回原分支 → 确认原分支无"方案 A" 5) 切回新分支 → 确认"方案 A"存在 6) 确认 fork 时 checkpointId 正确继承 | `[ ]` |
| 9 | ask_user 交互 | 用户输入正确注入对话上下文 | 1) 让 Agent 调用 ask-user 工具询问"请输入变量名" 2) 确认 UI 弹出输入框 3) 用户输入 `myVar` 4) 确认 Agent 后续消息中引用了 `myVar` 5) 确认输入内容被 PermissionEngine 校验（注入检测） | `[ ]` |
| 10 | plan/todo 管理 | 任务列表闭环（创建 → 更新 → 完成） | 1) 让 Agent 创建一个含 3 个任务的 plan 2) 确认 plan 工具返回 3 项 3) 让 Agent 完成第 1 项 → 确认状态变为 completed 4) 让 Agent 新增第 4 项 → 确认列表长度为 4 5) 让 Agent 删除第 2 项 → 确认列表长度为 3 6) 确认所有变更持久化（刷新后不丢失） | `[ ]` |

---

## 2. Extended Pack 场景（启用后必须通过）

> 对齐 `docs/CAPABILITY_LAYERS.md` 第 2 节 Extended Pack 层（E-01 ~ E-30）。启用对应 Pack 开关后必须通过；未启用时不阻断发布但需确认装配门控生效（即未启用时对应工具/IPC 不可用）。

### 启用前预检（每个 Pack 通用）

- [ ] Pack 开关默认 `false`（确认 `src/config/defaults.ts` 中对应字段）
- [ ] 未启用时对应工具未注册到 ToolRegistry
- [ ] 未启用时对应 IPC 通道返回 not-enabled 错误而非崩溃
- [ ] 未启用时对应 slash 命令返回提示而非崩溃

| # | 场景 | Pack | 验收方法 | 结果 |
|---|------|------|----------|------|
| 11 | /goal sequential 执行 | `goal-advanced` | 1) 在配置中设置 `packs.goalAdvanced.enabled: true` 2) 确认 `/goal` 命令可用 3) 输入 `/goal 实现 foo 函数` 4) 确认 GoalRunner sequential 执行（非并行，对齐 F-04 冻结） 5) 确认 GoalVerifier 验证目标达成 6) 确认 BudgetMonitor 在预算耗尽时中止 7) 确认 PrefixAwareCache 命中时 token 节省 | `[ ]` |
| 12 | spawn_agent 子 Agent | `multi-agent` | 1) 在配置中设置 `packs.multiAgent.enabled: true` 2) 让主 Agent 调用 spawn-agent 工具 3) 确认子 Agent 创建并执行任务 4) 确认子 Agent 工具集物理隔离（无法再 spawn 孙子 Agent） 5) 确认并行上限生效（maxConcurrentSubAgents） 6) 确认 Worker 上下文选择性传递生效 7) 确认子 Agent 结果回写 Blackboard | `[ ]` |
| 13 | /review 对抗审查 | `adversarial-review` | 1) 在配置中设置 `packs.adversarial.enabled: true` 2) 输入 `/review correctness src/foo.ts` 3) 确认 cross-model-reviewer 使用不同模型审查 4) 确认 ReviewerPolicy tieredReview 生效（按风险等级路由） 5) 确认审查结果含 critical/warning/info 三级 6) 确认 UnifiedReviewer（Core C-67）作为基础层在 Pack 关闭时仍可用 | `[ ]` |

---

## 3. Standard Pack 场景（启用后冒烟测试）

> 对齐 `docs/CAPABILITY_LAYERS.md` 第 3 节 Standard Pack 层（S-01 ~ S-24）。启用对应 Pack 后执行冒烟测试确认不崩溃；功能完整性不作为阻断条件（仅修崩溃）。

| # | 场景 | Pack | 验收方法 | 结果 |
|---|------|------|----------|------|
| 14 | 浏览器工具可用 | `browser-web` | 1) 在配置中设置 `packs.browserWeb.enabled: true` 2) 确认 web-search / web-fetch / browser 三个工具注册 3) 调用 web-search 搜索"RouteDev" → 确认不崩溃并返回结果 4) 调用 web-fetch 抓取一个公开 URL → 确认不崩溃 5) 确认 SSRF 防护生效（拒绝内网 IP） 6) 确认 VisionAssistant 在 vision 配置启用时不崩溃 | `[ ]` |
| 15 | 代码地图索引 | `code-map` | 1) 在配置中设置 `packs.codeMap.enabled: true` 2) 确认 code-graph-query / repo-map 工具注册 3) 调用 repo-map 扫描当前项目 → 确认返回签名列表 4) 调用 code-graph-query 查询某符号 → 确认不崩溃 5) 确认 CodeMapEngine Watcher 在文件变更时不崩溃 6) 确认 tree-sitter 不可用时回退到正则引擎（CodeMapFallback） | `[ ]` |
| 16 | Trace 回放 | `harness` | 1) 在配置中设置 `packs.harness.enabled: true` 2) 先执行一次对话产生 trace 3) 调用 `/replay` 回放 trace → 确认不崩溃 4) 调用 `/scorecard` 生成评分卡 → 确认返回评分 5) 确认 experiment:* / trace:* IPC 通道不崩溃 | `[ ]` |

---

## 4. 用户自建 Pack 场景

> 对齐 `docs/CAPABILITY_LAYERS.md` 第 7 节 Pack API 统一接口。用户自建 Pack 必须使用与官方 Pack 相同的接口，并受 PermissionEngine 管控。

| # | 场景 | 验收标准 | 验收方法 | 结果 |
|---|------|----------|----------|------|
| 17 | 示例 Pack 加载 | 注册工具后在对话中可用 | 1) 按 Pack 接口约定编写一个示例 Pack（注册一个 `echo` 工具） 2) 在配置中启用示例 Pack 3) 启动应用 → 确认无装配错误 4) 在对话中让 Agent 调用 `echo` 工具 5) 确认工具被调用并返回结果 6) 确认示例 Pack 出现在设置页"扩展区" | `[ ]` |
| 18 | Pack 加载失败 | fail-open + 日志记录 | 1) 编写一个故意抛出异常的 Pack 2) 在配置中启用该 Pack 3) 启动应用 → 确认应用不崩溃（fail-open） 4) 确认日志中记录了 Pack 加载失败警告 5) 确认其他 Pack 不受影响 6) 确认设置页显示该 Pack 为"加载失败"状态 | `[ ]` |

---

## 5. Freeze 验证

> 对齐 `docs/CAPABILITY_LAYERS.md` 第 4 节 Freeze 层（F-01 ~ F-12）。冻结模块必须停止一切接线，生产调用路径不可达。验证方式：源码静态扫描 + 运行时调用追踪。

| # | 检查项 | 标准 | 验收方法 | 结果 |
|---|--------|------|----------|------|
| 19 | TrustGradient 动态升级不可达 | 无生产调用路径 | 1) 在 `src/` 中搜索 `trust-gradient` 的动态升级方法调用 2) 确认仅类型定义存在，无运行时调用 3) 确认配置 `trust.dynamicUpgrade` 即使设为 true 也不触发动态升级 4) 确认 `/trust` 命令仅使用静态档位 5) 运行时追踪确认无 TrustGradientManager 实例化 | `[ ]` |
| 20 | Implicit Feedback 不可达 | 无生产调用路径 | 1) 在 `src/` 中搜索 `quality-signal` 中间件的注册点 2) 确认中间件未注册到 middleware pipeline 3) 确认配置 `quality.enabled` 即使设为 true 也不触发中间件 4) 运行时追踪确认无 QualitySignalMiddleware 实例化 5) 确认 ImplicitFeedbackDetector 已删除（Phase 60 已删） | `[ ]` |
| 21 | /goal 并行调度不可达 | 无生产调用路径 | 1) 在 `src/` 中搜索 orchestrator 的并行调度方法 2) 确认 `/goal` 仅走 sequential 路径（GoalRunner） 3) 确认并行调度代码路径不可达（条件分支恒 false） 4) 确认 ConflictDetector 并行部分未实例化 5) 运行时追踪确认 /goal 执行无并行 worker 派遣 | `[ ]` |

---

## 6. 指标报告

> 与 Phase-80 基线对比，确认瘦身目标达成。基线值来源：Phase 80 Task 1 枚举结果（`docs/CAPABILITY_LAYERS.md` 第 5 节覆盖率统计）。

| 指标 | Phase-80 基线 | v4.9.0 目标 | v4.9.0 实测 | 达成 |
|------|--------------|-------------|-------------|------|
| 默认注册工具数 | 26+ | ≤ 10 | （填写） | `[ ]` |
| 默认启用配置开关数 | （填写基线值） | 减少 ≥ 50% | （填写） | `[ ]` |
| 默认装配模块数 | （填写基线值） | 减少 ≥ 30% | （填写） | `[ ]` |
| Extended Pack 数 | 0 | 3 | （填写） | `[ ]` |
| Standard Pack 数 | 0 | ≥ 3 | （填写） | `[ ]` |
| Freeze 模块数 | 0 | 明确记录 | （填写） | `[ ]` |
| 会话分支可用 | 无 | /tree /fork /clone | （填写） | `[ ]` |
| 用户自建 Pack | 无 | 示例 Pack 可加载 | （填写） | `[ ]` |

### 指标填写说明

- **默认注册工具数**：启动应用后在 ChatPage 让 Agent 列出可用工具（或调用 `/mcp` / `/status`），统计 `tools.profile: core` 档位下注册的工具数。目标 ≤ 10（file-read/write/edit/search、list-directory、shell-exec、git-op、code-search、ask-user、todo-write）。
- **默认启用配置开关数**：读取 `src/config/defaults.ts`，统计顶层 `enabled: true` 的配置字段数，与 Phase-80 基线对比计算减少百分比。
- **默认装配模块数**：读取 `src/runtime/app-init*.ts`，统计无条件装配（无 `packs.<id>.enabled` 门控）的模块数，与 Phase-80 基线对比。
- **Extended Pack 数**：确认 `goal-advanced` / `multi-agent` / `adversarial-review` 三个 Pack 在设置页"高级区"可见且可启用。目标 = 3。
- **Standard Pack 数**：确认 `browser-web` / `code-map` / `harness` 等 Pack 在设置页"扩展区"可见且可启用。目标 ≥ 3。
- **Freeze 模块数**：确认设置页"实验区"展示的 Freeze 模块数量，并在本文档第 5 节记录具体模块清单。

---

## 7. 防回潮规则

> 发布后维护纪律，引用 `docs/CAPABILITY_LAYERS.md` 第 6 节与蓝图 §8。任何 PR 违反以下规则不得合并。

1. **新功能默认 `enabled: false` 或进入 Pack** —— 新增功能不得默认装配，必须通过 Pack 开关或配置开关门控
2. **想进 Core 必须提供四件套** —— 用户场景 / 费用影响 / 测试覆盖 / 为何不能 Pack；缺一不可
3. **审查发现"功能缺失"时先查"Core 不做"清单** —— 先确认是否属于 Freeze 层或 Pack 层能力，再决定是否实现
4. **Extended Pack 修 bug 不扩功能** —— 修复合并允许，新功能合并拒绝
5. **Standard Pack 仅修崩溃** —— 崩溃修复合并允许，其他变更拒绝
6. **Freeze 模块停止一切接线** —— 不得新增任何调用路径、配置入口、UI 入口
7. **Pack API 统一** —— 官方 Pack 与用户自建 Pack 使用相同接口（PackContext + CapabilityPack），无特权通道
8. **用户自建 Pack 受 PermissionEngine 管控** —— 自建 Pack 注册的工具必须经过 SecurityChecker / PermissionEngine 校验，无白名单绕过

---

## 8. 验收签署

| 角色 | 状态 | 备注 |
|------|------|------|
| Core 场景验收（1-10） | `[ ]` 全部通过 | |
| Extended Pack 场景验收（11-13） | `[ ]` 启用后全部通过 | |
| Standard Pack 场景验收（14-16） | `[ ]` 冒烟测试通过 | |
| 用户自建 Pack 场景验收（17-18） | `[ ]` 全部通过 | |
| Freeze 验证（19-21） | `[ ]` 全部不可达 | |
| 指标报告达成目标 | `[ ]` 全部达成 | |
| 防回潮规则确认 | `[ ]` 已知悉 | |

> **发布结论：** 上述全部勾选通过后，v4.9.0 可发布。任一 Core 场景或 Freeze 验证未通过即阻塞发布。

---

## 附录：场景与能力模块映射

| 场景 # | 对应 Core 模块（CAPABILITY_LAYERS ID） |
|---------|---------------------------------------|
| 1 | C-22 ReActAgentLoop / C-45 LLMClientManager / C-59 IPC: chat |
| 2 | C-01~C-07 文件工具 / C-06 shell-exec / C-22 ReActAgentLoop |
| 3 | C-17 PermissionEngine / C-18 PermissionMiddleware / C-15 ToolExecutor |
| 4 | C-32 CheckpointManager / C-33 CheckpointWriter / C-07 git-op |
| 5 | C-48 TokenTracker / C-49 TokenProfiler / C-62 config: router |
| 6 | C-17 PermissionEngine / C-19 PolicyEngine / C-21 CommandSandbox |
| 7 | C-68 SessionTree / C-70 session-commands / C-69 SessionNode |
| 8 | C-68 SessionTree / C-70 session-commands / C-32 CheckpointManager |
| 9 | C-09 ask-user / C-17 PermissionEngine / C-26 ToolResultSanitizer |
| 10 | C-13 plan-tool / C-10 todo-write / C-36 BranchManager |
| 11 | E-12 GoalRunner / E-13 GoalParser / C-66 GoalVerifier / E-23 BudgetMonitor / E-24 PrefixAwareCache |
| 12 | E-01 spawn-agent / E-02 createSpawnAgentFn / E-04 WorkerExecutor / E-11 AgentActivityStore |
| 13 | E-19 cross-model-reviewer / E-20 ReviewerPolicy / C-67 UnifiedReviewer |
| 14 | S-01 web-search / S-02 web-fetch / S-03 browser / S-19 VisionAssistant |
| 15 | S-04 code-graph-query / S-05 repo-map / S-06 CodeMapEngine / S-07 CodeMapContextMiddleware |
| 16 | S-18 TraceReplayer / S-20 IPC: experiment/trace / S-21 Slash: /replay /scorecard |
| 17 | CapabilityPack API / PackContext / ToolRegistry (C-14) |
| 18 | fail-open 守卫 / Logger / C-17 PermissionEngine |
| 19 | F-01 TrustGradientManager (动态升级冻结) |
| 20 | F-02 QualitySignalMiddleware (Implicit Feedback 冻结) |
| 21 | F-04 /goal 并行调度与冲突检测 (冻结) |
