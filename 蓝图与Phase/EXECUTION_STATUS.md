# RouteDev — Phase 执行状态总表

> **最后更新：** 2026-06-25（Phase 47 完成 v3.8.0；开发者工作流产品化与体验闭环——AGENTS.md瘦身/description规范/exec非交互/权限双旋钮/对抗审查/Checkpoint可视化/自定义命令/fallback兼容/GitHub Action）
> **仓库 commit：** 待提交（Phase 20-32 + 0c）
> **测试基线：** 1418 测试（Phase 30 后）；Phase 31 要求 ≥78；Phase 32 要求 ≥45（60 通过）；Phase 33 要求 ≥15；Phase 34 要求 ≥20；Phase 35 要求 ≥18；Phase 36 要求 ≥16；Phase 37 要求 ≥30（需求澄清 + 调度 + Git 实验 + 插件兼容）；Phase 38 要求 ≥35（中间件激活 + 子Agent工具化 + 知识管理增强）；Phase 40 要求 ≥30（渐进式信任 + 确定性路由 + 质量监测 + 经验适配）；Phase 46 要求 ≥35（IPC 桥接 + Hook 接线 + HTTP 客户端 + 事件修复 + 命令注册 + 死代码清理 + 集成测试，65 通过）；Phase 47 要求 ≥40（AGENTS.md瘦身 + description规范 + exec非交互 + 权限双旋钮 + 对抗审查 + Checkpoint可视化 + 自定义命令 + fallback兼容 + GitHub Action + 集成测试，256 通过）
> **维护人：** 架构师（QoderWork）

---

## 状态图例

| 标记 | 含义 |
|------|------|
| ✅ DONE | 全部 Task 完成，已提交，无遗留 |
| ⚠️ PARTIAL | 部分 Task 完成，有遗留债务 |
| ❌ NOT STARTED | 未开始 |
| 🔄 REMEDIATION | 返工 Phase，修复前序 Phase 遗留 |

---

## Phase 状态一览

| Phase | 主题 | 状态 | 版本 | Commit |
|-------|------|------|------|--------|
| 01 | 项目骨架与配置系统 | ✅ DONE | v0.1.0 | 已提交 |
| 02 | 核心类型与 LLM 客户端 | ✅ DONE | v0.2.0 | 已提交 |
| 03 | Router 层：分类器 / 路由 / Token 追踪 | ✅ DONE | v0.3.0 | 已提交 |
| 04 | 基础 CLI 对话 | ✅ DONE | v0.4.0 | 已提交 |
| 05 | Agent Loop 核心 ReAct 循环 | ✅ DONE | v0.5.0 | 已提交 |
| 06 | 工具框架与基础工具 | ✅ DONE | v0.6.0 | 已提交 |
| 07 | 进阶工具与安全增强 | ✅ DONE | v0.7.0 | 已提交 |
| 08 | MCP 客户端 | ✅ DONE | v0.8.0 | 已提交 |
| 09 | 自主模式与目标系统 | ✅ DONE | v0.9.0 | 已提交 |
| 10 | 检查点系统 | ✅ DONE | v0.10.0 | 已提交 |
| 11 | 增量 Checkpoint 与上下文压缩 | ✅ DONE | v0.11.0 | 已提交 |
| 12 | 多模态视觉与分支对话 | ✅ DONE | v0.12.0 | 已提交 |
| 13 | 渠道集成层 | ✅ DONE | v0.13.0 | 已提交 |
| 14 | 多 Agent 基础 | ✅ DONE | v0.14.0 | 已提交 |
| 15 | 可观测性 | ✅ DONE | v0.15.0 | 已提交 |
| 16 | Prompt 模板系统与项目记忆 | ✅ DONE | v0.16.0 | 已提交 |
| 17 | App 重构与缺陷修复 | ⚠️ PARTIAL | — | bc2f0ee |
| 18 | CLI 基础设施增强 | ⚠️ PARTIAL | — | bc2f0ee |
| 19 | 渠道完善与 UX 打磨 | ⚠️ PARTIAL | — | bc2f0ee |
| **17b** | **返工修复（17/18/19 收束）** | **✅ DONE** | v0.17b.0 | 待提交 |
| **17c** | **工程基础设施与记忆增强** | **✅ DONE** | v0.17c.0 | 待提交 |
| 20 | 工作模式与步骤编辑器 | ✅ DONE | v0.18.0 | 待提交 |
| 21 | Agent Guardrails 增强 | ✅ DONE | v0.19.0 | 待提交 |
| 22 | Plugin 系统 | ✅ DONE | v0.20.0 | 待提交 |
| 23 | 高级 UX 与收尾打磨 | ✅ DONE | v1.0.0 | 待提交 |
| **0c** | **审计修复（GPT 5.5 复审）** | **✅ DONE** | v1.0.1 | 待提交 |
| 24 | 功能补全与产品完善 | ✅ DONE | v1.1.0 | 待提交 |
| 25 | UI 与交互优化 | ✅ DONE | v1.2.0 | 待提交 |
| 26 | 技术债务清零与架构加固 | ✅ DONE | v1.3.0 | 待提交 |
| 27 | 产品完善与商业交付标准 | ✅ DONE | v1.4.0 | 待提交 |
| 28 | 质量验收与发布准备 | ✅ DONE | v2.0.0 | 待提交 |
| **29** | **安全加固与收尾闭环** | **✅ DONE** | v2.1.0 | 待提交 |
| **30** | **可观测性与提示词工程** | **✅ DONE** | v2.2.0 | 待提交 |
| **31** | **统一工作流编排** | **✅ DONE** | v2.3.0 | 待提交 |
| **32** | **接线、验证与收尾** | **✅ DONE** | v2.4.0 | 待提交 |
| **33** | **设置补全与默认值校准** | **✅ DONE** | v2.5.0 | 待提交 |
| **34** | **交互展示重塑与代码检索增强** | **✅ DONE** | v2.6.0 | 待提交 |
| **35** | **上下文选择性传递与执行基础设施激活** | **✅ DONE** | v2.7.0 | 待提交 |
| **36** | **上下文智能增强与工程方法论集成** | **✅ DONE** | v2.8.0 | 待提交 |
| **37** | **智能交互、自动化与开发者工作流增强** | **✅ DONE** | v2.9.0 | 待提交 |
| **38** | **Harness中间件、子Agent工具化与知识管理增强** | **✅ DONE** | v3.0.0 | 待提交 |
| **39** | **代码地图增强、Skill/Hook 自动生成** | **✅ DONE** | v3.1.0 | 待提交 |
| **40** | **渐进式信任权限、确定性路由与Agent质量监测** | **✅ DONE** | v3.2.0 | 待提交 |
| **41** | **代码地图自研引擎升级（tree-sitter+SQLite+PageRank）** | **✅ DONE** | v3.3.0 | 待提交 |
| **42** | **代码地图引擎落地、多Agent编排升级与Skill/Hook市场** | **✅ DONE** | v3.3.0 | 待提交 |
| **43** | **子Agent上下文控制与自主配置体系** | **✅ DONE** | v3.4.0 | 待提交 |
| **44** | **消息节点化与分支化对话增强** | **✅ DONE** | v3.5.0 | 待提交 |
| **45** | **Pi人格化交互与主动记忆落地** | **✅ DONE** | v3.6.0 | 待提交 |
| **46** | **死代码清零与接线收尾** | **✅ DONE** | v3.7.0 | 待提交 |
| **47** | **开发者工作流产品化与体验闭环** | **✅ DONE** | v3.8.0 | 待提交 |

---

## 并行执行说明（Phase 33/34/35/36）

Phase 33、34、35、36 共享同一个前置（Phase 32 v2.4.0），各自修改不同文件，**支持同时派发执行**：

| Phase | 核心修改面 | 共享文件 |
|-------|-----------|---------|
| 33 | desktop/renderer/、SettingsPage.tsx | app-init.ts（添加配置服务注入） |
| 34 | CLI 渲染组件、search 工具 | app-init.ts（添加 RepoMap 服务）、AuditLogger（追加字段） |
| 35 | worker-executor.ts、hooks.ts、durable-executor.ts | app-init.ts（HookRunner + StepExecutor） |
| 36 | MCP 集成、KnowledgeGraph、Skill 文件 | worker-executor.ts（Task 2 增强 P35 Task 1） |

**app-init.ts 合并策略：** Phase 33/34/35 修改不同行区间，均为加法操作，按 Phase 编号顺序 merge 即可。Phase 36 不修改 app-init.ts。

**替代关系：** Phase 36 Task 1（codebase-memory-mcp 集成）可替代 Phase 34 Task 4（Repo Map 从零自建）。如果并行执行，建议 Phase 34 Task 4 暂停等待 Phase 36 Task 1 结果。

**增强关系：** Phase 36 Task 2（任务感知裁剪）增强 Phase 35 Task 1（Worker 上下文过滤）。需要 Phase 35 Task 1 的 `filterContext()` 签名确定后再开发。

**条件接入：** Phase 34 Task 5（过程评测）写入 AuditLogger 的字段需与 Phase 35 Task 4（轨迹导出）的读取 schema 一致。合并时验证字段名对齐。

---

## Phase 17/18/19 部分执行详情

### Phase 17 — App 重构与缺陷修复 ⚠️

| Task | 描述 | 状态 | 说明 |
|------|------|------|------|
| Task 1 | ServiceContext 抽取 | ✅ 已交付 | `src/cli/service-context.ts` 109 行，22 字段 |
| Task 2 | CommandRegistry 建立 | ✅ 已交付 | `src/cli/command-registry.ts` 76 行，注册了 7 个命令 |
| Task 3 | App.tsx 瘦身到 ≤400 行 | ❌ 未完成 | App.tsx 反而从 1450→1548 行，switch 块 580 行未删除 |
| Task 4 | vision.ts 路径遍历修复 | ❌ 未完成 | `loadImage()` 仍无路径边界检查 |
| Task 5 | branch.ts 状态不一致修复 | ❌ 未完成 | `append()` 仍每次删除重建 BranchInfo |

**遗留债务转入 Phase 17b：Task 1（commandBridge + 11个命令文件）、Task 2（安全修复）、Task 4-7（vision/branch/cost/history/token）。**

### Phase 18 — CLI 基础设施增强 ⚠️

| Task | 描述 | 状态 | 说明 |
|------|------|------|------|
| Task 1 | CLI 参数解析增强 | ✅ 已交付 | `src/utils/args.ts` 存在 |
| Task 2 | Tab 补全 | ✅ 已交付 | `src/cli/completion.ts` 存在 |
| Task 3 | 重试与熔断 | ✅ 已交付 | `src/utils/retry.ts` 存在（RetryPolicy + CircuitBreaker） |
| Task 4 | 配置文件监听 | ✅ 已交付 | `src/config/watcher.ts` 存在 |
| Task 5 | 与 App.tsx 集成 | ❌ 未完成 | 以上模块存在但未在 App.tsx 中使用 |

**遗留债务转入 Phase 17b：Task 5 的集成工作。**

### Phase 19 — 渠道完善与 UX 打磨 ⚠️

| Task | 描述 | 状态 | 说明 |
|------|------|------|------|
| Task 1 | Telegram 适配器 | ✅ 已交付 | 存在且功能正常 |
| Task 2 | Discord 适配器 | ❌ 未完成 | 不存在 |
| Task 3 | 渠道管理 /channels 命令 | ❌ 未完成 | 不存在 |
| Task 4 | WebhookServer 安全加固 | ❌ 未完成 | server.ts 无 rate limit / auth / body limit |
| Task 5 | 企业微信安全修复 | ❌ 未完成 | timing-unsafe 比较 + credential-in-URL 未修 |
| Task 6 | 中文 token 估算改进 | ❌ 未完成 | 仍为 Math.ceil(text.length / 4) |

**遗留债务转入 Phase 17b：Task 2（Discord 可选）、Task 3-6（安全+功能）。**

---

## Phase 17b 验证清单

架构师对 Phase 17/18/19 的验证结果（Phase 17b 完成后全部 PASS）：

| # | 检查项 | Phase 17 验证 | Phase 17b 完成后 | 说明 |
|---|--------|:---:|:---:|------|
| 1 | ServiceContext 接口定义 | ✅ PASS | ✅ PASS | 25 字段（原 22 + 3 新增） |
| 2 | CommandRegistry 注册机制 | ✅ PASS | ✅ PASS | 19 个命令全部注册 |
| 3 | App.tsx 瘦身 ≤ 400 行 | ❌ FAIL | ✅ PASS | 1548→369 行，无 switch 块 |
| 4 | /cost 命令 | ❌ FAIL | ✅ PASS | cost.ts 已创建 |
| 5 | /history 命令 | ❌ FAIL | ✅ PASS | history.ts 已创建 |
| 6 | 中文 token 估算 | ❌ FAIL | ✅ PASS | estimateTokens 替换全部旧写法 |
| 7 | WebhookServer 安全 | ❌ FAIL | ✅ PASS | 限流 + auth + body 限制 |
| 8 | 企业微信 timing-safe | ❌ FAIL | ✅ PASS | timingSafeEqual |
| 9 | vision.ts 路径遍历 | ❌ FAIL | ✅ PASS | projectRoot 边界检查 |
| 10 | retry 模块可用性 | ✅ PASS | ✅ PASS | 已集成（Phase 17c 补集成） |

---

## Phase 17c 验证清单

架构师对 Phase 17c 的验证结果（基于执行人报告自评，12/12 PASS）：

| # | 检查项 | 结果 | 说明 |
|---|--------|------|------|
| 1 | AGENTS.md ≤ 80 行 | ✅ PASS | 47 行，10 条陷阱警告 |
| 2 | CODEMAP.md 覆盖所有 src/ 子模块 | ✅ PASS | 10 个一级模块 + tests/ |
| 3 | verify.ts 硬验收门 | ✅ PASS | 9/9 通过 |
| 4 | ContextCompactor 五阶段压缩 | ✅ PASS | 14 测试，L1-L4 零 LLM 调用 |
| 5 | DreamConsolidator 集成 Compactor | ✅ PASS | 4 集成测试 |
| 6 | KnowledgeGraph PPR + 双路径 + 社区 | ✅ PASS | 25 测试 |
| 7 | ContextManager 集成 KnowledgeGraph | ✅ PASS | 5 集成测试 |
| 8 | executor.ts 空桩处理 | ✅ PASS | 已删除 |
| 9 | retry/watcher/completion 集成 | ✅ PASS | 三个模块已接入主流程 |
| 10 | 版本号一致 | ✅ PASS | args.ts + splash.ts 从 package.json 读取 |
| 11 | 全量测试 | ✅ PASS | 52 文件 / 545 测试 |
| 12 | 新增测试 ≥ 25 | ✅ PASS | +59 个新测试 |

---

## 前任执行人的 CONCERN 列表

**注意：** 前任执行人的完成报告仅存在于聊天记录中，未写入文件。以下是从聊天历史中提取的关键 CONCERN：

| # | CONCERN | 来源 | 状态 |
|---|---------|------|------|
| 1 | App.tsx 非流式调用：Agent Loop 是流式的但 App.tsx 的某些路径未用 stream() | Phase 2-4 审阅 | 架构师已确认为观察项，不阻塞 |
| 2 | ModelConfig 字段名用 `provider` 而非 `providerId` | Phase 2-4 审阅 | 架构师已确认为观察项 |
| 3 | SDK 版本差异：Anthropic SDK 版本可能与最新 API 不完全对齐 | Phase 2-4 审阅 | 架构师已确认为观察项 |
| 4 | TokenTracker 无磁盘持久化：重启后数据丢失 | Phase 2-4 审阅 | 架构师已确认为观察项 |
| 5 | Ink 7 + React 19 兼容性：部分 React 19 特性在 Ink 中未完全支持 | Phase 2-4 审阅 | 架构师已确认为观察项 |

---

## 测试覆盖基线

截至 Phase 28 完成：
- 源文件：约 140 个
- 测试文件：107 个
- 测试总数：1242 个（Phase 26 +30，Phase 27 +81，Phase 28 +69）
- Phase 26 目标：≥ 30 个新增测试 ✅ 达成
- Phase 27 目标：≥ 35 个新增测试 ✅ 达成
- Phase 28 目标：≥ 40 个新增测试（含 10 个 E2E）✅ 达成
- **Phase 29 目标：≥ 25 个新增测试** ✅ 达成（+97 个新测试，16 个新文件）

---

## Phase 24-29 规划摘要

### Phase 24 — 功能补全与产品完善 ✅ DONE（v1.1.0）

8 个 Task：CLI 设计系统、Compose 管线自动化、DurableExecutor、HookRunner、/permissions、提示词规范、错误消息+路由透明化、Provider 校验。993 测试通过。

### Phase 25 — UI 与交互优化 ✅ DONE（v1.2.0）

7 个 Task：BranchSwitcher、ConfirmDialog、Progressive Disclosure、进度可视化、Anti-Yes-Engineer、DiffView、通知系统。1062 测试通过。

### Phase 26 — 技术债务清零与架构加固 ✅ DONE（v1.3.0）

10 个 Task，消除所有已知技术债务：
1. **搜索工具路径遍历修复** — code-search/file-search 缺失路径边界检查
2. **企业微信凭据脱敏** — corpSecret 不出现在日志
3. **CommandRegistry 纳入 ServiceContext** — 消除 help 命令的 `as any`
4. **/permissions 命令修复** — 读取运行时实例而非默认快照
5. **同步 I/O 异步化** — TokenTracker.persist + DurableExecutor.listRecoverable
6. **硬编码提示词迁移** — agent/prompts.ts 接入 PromptTemplateManager
7. **自定义错误类体系** — 5 个错误类替代字符串模式匹配
8. **剩余模板五块结构** — 5 个模板改造完成
9. **测试覆盖补全 + CONCERN 关闭** — 4 个无测试模块 + 5 个遗留 CONCERN
10. **文档同步** — AGENTS.md / CODEMAP.md / README.md 更新

### Phase 27 — 产品完善与商业交付标准 ✅ DONE（v1.4.0）

10 个 Task，补全所有"差一步"的功能：
1. **DurableExecutor 运行时集成** — 接入 App.tsx 主循环
2. **RouterPlugin 集成** — ModelRouter 先问插件再 fallback
3. **ThemePlugin 渲染接入** — StatusBar/ChatView 读取主题配置
4. **插件状态持久化** — enable/disable 写入磁盘
5. **DiffView 动作绑定** — [A]/[R]/[S] 接入 git 操作
6. **/resume 交互式 UI** — 键盘导航选择可恢复执行
7. **通知持久化到审计日志** — critical/important 写入 JSONL
8. **Compose + HookRunner TracePanel** — 阶段/钩子时间线可视化
9. **notes.md 模块** — 蓝图规定的 Agent 唯一写通道
10. **Discord 适配器**（可选）

### Phase 28 — 质量验收与发布准备 ✅ DONE（v2.0.0）

8 个 Task，最终验收考试：
1. **端到端用户旅程测试** — 10 个 E2E 场景覆盖主要用户流程
2. **性能基线强制门** — 性能退化即构建失败
3. **安全终审** — 9 项安全审计全部 PASS
4. **测试覆盖率强化** — 零覆盖模块清零 + 边界条件 + 回归测试
5. **文档完整度审查** — 8 份文档完整准确
6. **蓝图合规度终审** — 合规度 ≥ 95%
7. **发布前检查清单** — 逐项验证
8. **版本号升级 + Git Tag** — v2.0.0

### Phase 29 — 安全加固与收尾闭环 ✅ DONE（v2.1.0）

6 个 Task，回应代码审查报告（安全性 5/10 → 8/10），修复 Phase 26/27/28 遗漏的安全缺口和关键缺陷。项目最后一个开发 Phase，完成后进入维护模式。

1. **渠道适配器安全加固** — 签名验证生产模式拒绝降级(S5/S6)、环境变量 fail-fast(S9)、API Key 占位符移除(S11)、PKCS#7 padding 严格验证(S8)、parseInt NaN 防护
2. **渠道管理器架构修复** — Slack 适配器 switch 注册(A1)、末尾 import 移至顶部(A2)
3. **命令解析统一与加固** — 引入 tokenize 解析替代正则/子串匹配，修复 S1/S2/S3/env 注入四个关联漏洞，新增 find -delete 和 dd of=/dev/ deny 规则
4. **运行时健壮性修复** — isModelAvailable 真实检查(B3)、分类器回退改 complex(B4)、rollback 前置工作区检查(B10)、orchestrator 环检测添加警告(B13)
5. **边界案例修复** — isError 结构化判断(B1)、vision 路径检查 path.relative 改造(S12)、搜索工具代码去重(A4)
6. **测试覆盖与文档同步** — ≥ 25 个新测试、AGENTS.md/CODEMAP.md/README.md/CHANGELOG.md 更新

**审查报告纠错：** B8/P7（Slack Array.shift）实际用 Set，审查错误；B13（orchestrator 环检测"抛错"）实际静默追加，审查描述不准确但问题更严重。

**v2.x 技术债务清单（12 项非紧急遗留）：** S10(Telegram botToken URL)、A3(双引擎不统一)、B2(resumeFrom 单步)、B5(图片 token 估算)、B7(pollIntervalMs 类型)、B11(plugin validateArgs)、B12(L5 fallback)、B14(web-search HTML)、B15(分支索引)、P4(trace 背压)、P6(Map 无上限)、P8(压缩全量扫描)。

### Phase 30 — 可观测性与提示词工程 ✅ DONE（v2.2.0）

5 个 Task，聚焦"装水表"——Token 分组件可观测性 + PromptTemplateManager 正式通电 + 系统提示词 8 区块重构。新增 79 个测试（5 个文件）。

1. **Token 可观测性基础设施** — TokenProfiler 五分表 + /token 命令 + loop 埋点 + goal-runner token 记录修复 + checkBudget 接入（19 测试）
2. **结构化实体状态（实验性）** — EntityManager + toPromptBlock < 200 tokens（19 测试）
3. **声明式上下文获取（实验性）** — DeclarativeContextAcquirer 两步调用 + 5秒超时降级（13 测试）
4. **简洁思考约束（实验性）** — CONCISE_THINKING_BLOCK + trimToolResult + shouldSkipConcise（17 测试）
5. **系统提示词重构** — main.system 8 区块 XML 结构 + PromptTemplateManager 接入主路径 + systemPromptRef 模式 + fallback 机制（11 测试）
6. **集成测试与文档同步** — AGENTS.md 陷阱 20-22 + CODEMAP.md 4 个新文件 + CHANGELOG.md v2.2.0 + config.example.yaml optimization section + package.json v2.2.0

**关键设计决策：**
- tokenTracking 默认开启（可观测性不应是实验性），其余三项实验性功能默认关闭
- systemPrompt 改为 ref 模式支持异步渲染热更新，渲染失败保留 fallback 不阻断启动
- TokenProfiler 会话级累计不因上下文压缩重置（借鉴 Reasonix Layer 5）

### Phase 31 — 统一工作流编排 ❌ NOT STARTED（v2.3.0）

6 个 Task + pi-mono 学习集成，≥78 新增测试。统一工作流编排系统：TaskOrchestrator 意图分发（quick_answer/development/explicit_goal/planning 四种意图 + Steering Queue）、ExecutionOrchestrator 自适应执行（单 Agent 串行 / 多 Agent 并行）、CompletionGate 独立验证、ReadTracker 读后写追踪、ToolResultSanitizer 输出净化、FailureReport 结构化失败报告。整合 pi-mono 极简 Agent 设计（1.6 转向队列、4.6 有序发射、6.6 智能截断、6.7 扩展钩子）。

**审查报告关键发现（2026-06-19 架构师全量审查）：**
- Phase 31 的 8 个模块 100% 死代码——全部实现并测试但零生产路径导入
- App.tsx handleSubmit 仍直达 ChatRunner，绕过 TaskOrchestrator
- 接口对齐表 24 项：15 PASS / 5 PARTIAL / 4 FAIL
- 安全防护层（ReadTracker/Sanitizer/CompletionGate/filterSensitiveFields）全部未通电

### Phase 32 — 接线、验证与收尾 ❌ NOT STARTED（v2.4.0）

5 个 Task，≥45 新增测试。核心目标："让已有的东西真正跑起来"——Phase 31 的 8 个模块全部实现但零接入，本 Phase 完成接线、缓存架构激活、Agent 行为 Eval、安全加固。

1. **Phase 31 模块接线（C1/C2 修复）** — TaskOrchestrator 接入 App.tsx + ToolResultSanitizer 接入 loop.ts + ReadTracker 接入 GuardedToolExecutorAdapter + CompletionGate 接入 goal-runner + Task 级 Token 预算激活（修复 double-counting bug）+ filterSensitiveFields 接入（15 测试）
2. **缓存架构激活与实测** — 激活 enableCache + Anthropic cache_control 优化 + CacheAwarePromptBuilder/CacheStatsTracker 接入 + 六层验证测试（10 测试）
3. **Agent 行为 Eval 最小版本** — 分类器准确率黄金测试集（≥30 cases）+ 降级链正确性测试 + ConflictDetector 盲区记录（8 测试）
4. **安全加固与细节修复** — MCP 工具 Schema 校验 + 工具描述注入检测 + MCP Client 版本号修复 + agents.md 陷阱 #22 修正 + goal-runner 添加 checkBudget + chat-runner 传 context（8 测试）
5. **集成测试与文档同步** — E2E 接线验证 + AGENTS.md/CODEMAP.md/CHANGELOG.md/README.md 更新（4 测试）

**设计决策：**
- 回应执行人 C1/C2 实用性质疑：每个模块附"不接线会怎样 / 接线后解决什么"场景表
- Claude 改进建议已核验并分级：P0-1 缓存激活（Task 2）、P0-2 Eval 体系（Task 3）、P1-1 安全加固（Task 4）纳入；P1-2 可观测性闭环、P1-3 License 推迟到 Future Work
- P2 细节修复（MCP 版本号、陷阱 #22 修正）纳入 Task 4

**Phase 32 执行结果（执行人报告）：**
- typecheck 通过，build 通过（dist/index.js 681.39 KB）
- 60 测试全部通过（要求 ≥45）：agent-eval 44 + safety-hardening 9 + integration 7
- GoalStep 类型补 `modifiedFiles?: string[]` 修复 typecheck 错误
- 版本号升级到 v2.4.0
- AGENTS.md 陷阱 #35-40，CHANGELOG.md v2.4.0 条目

### Phase 33 — 设置补全与默认值校准 ❌ NOT STARTED（v2.5.0）

4 个 Task + 思考引导，≥15 新增测试。核心目标：修复 SettingsPage 的功能性残缺和缺失模块，并引导执行人审视影响 Agent 质量的默认值。

1. **MCP 服务器表单补全** — stdio 添加 args/env/cwd 字段、http 添加 headers 字段、connectTimeout 通用字段、已有服务器编辑能力（4 测试）
2. **渠道选项表单补全** — 按渠道类型动态渲染 options 凭据表单（Telegram: botToken/allowedUserIds; 企业微信: corpId/corpSecret/token/encodingAESKey/agentId; Slack: botToken/signingSecret/appToken）、凭据安全（password 类型 + 环境变量引用）、Discord 未实现提示（4 测试）
3. **缺失模块与字段补全** — goalVerifier/adversarial/updates/prompts 四个模块 UI 入口 + 模型编辑模态 fallbackModelId + Checkpoint triggers 编辑 + 版本号修复（4 测试）
4. **默认值校准（思考引导）** — 7 个问题引导执行人审视默认值对 Agent 质量的影响：goalVerifier.modelId 选择、maxToolOutputChars 够不够、gateTimeout 大型项目适应性、gateRetry 修复循环、reviewStrictness 标准定义、adversarial.threshold 精度、checkpoint.triggers 阈值合理性
5. **集成测试与文档同步** — SettingsPage 渲染测试 + 配置保存测试 + AGENTS.md/CODEMAP.md/CHANGELOG.md 更新（3 测试）

**设计理念：**
- 4 个功能性残缺是必修项——MCP 和渠道表单缺字段导致"配了也不能用"
- 4 个缺失模块不强制全部实现——goalVerifier 和 adversarial 优先级高（影响 Agent 功能），updates 和 prompts 优先级低（改 YAML 即可）
- Task 4 不写代码，写思考——默认值直接影响 Agent 质量，执行人需要理解取舍后再定稿

### Phase 34 — 交互展示重塑与代码检索增强 ❌ NOT STARTED（v2.6.0）

5 个 Task，≥20 新增测试。依据两份深度研究报告：《Agent 工具交互展示方案研究报告》和《实用型 Coding Agent 功能体系解构》。

1. **Output Style 系统** — 将 `disclosureLevel` 升级为 `outputStyle`（minimal/standard/verbose），CLI 和 Desktop 端各自按 UI 范式实现信息密度控制，运行时可切换（6 测试）
2. **完成后折叠与微摘要** — 成功时折叠过程展示微摘要（步骤数/耗时/文件变更/关键决策），失败时自动展开高亮错误，非对称设计（5 测试）
3. **动作动词体系与执行反馈** — 过去时动词展示已完成操作，工具执行时简洁 Spinner + 30s 计时器，LLM 推理阶段无动效（4 测试）
4. **代码检索增强（Repo Map）** — 借鉴 Aider 的 Repo Map 思路，用 tree-sitter 或 TS Compiler API 提取函数签名注入上下文，解决"Agent 盲找代码"问题（3 测试）
5. **过程评测指标（Harness-level Evaluation）** — 在 TraceCollector 基础上增加 trajectory 级汇总（token/工具调用次数/LLM 调用次数/重试次数/首次成功率），写入 AuditLogger JSONL（2 测试）

**设计理念：**
- 交互展示部分来自报告二的竞品调研——Codex/Claude Code/Cursor 的共性是"信息减法"和"用户控制权"，Phase 34 将这两个原则落地为 outputStyle 配置
- 代码检索和过程评测来自报告一的架构建议——Repo Map 是投入产出比最高的检索增强，trajectory 级评测为未来的"Agent 质量看板"提供数据基础
- 每个 Task 都包含"需要你决定的"思考引导，而非强制指令——outputStyle 的层级定义、微摘要的关键决策提取方式、Repo Map 的技术选型、评测的触发时机都需要执行人读代码后自行判断

### Phase 35 — 上下文选择性传递与执行基础设施激活 ❌ NOT STARTED（v2.7.0）

4 个 Task + 集成测试，≥18 新增测试。依据《实用型 Coding Agent 功能体系解构》的架构改进建议：选择性上下文传递（97% token 节省潜力）、Agent Harness 理论（代码即 Agent）、逐步自验证体系。

1. **Worker 上下文选择性传递** — `WorkerExecutor.execute()` 当前把完整 20 条消息传给每个 Worker。增加 `filterContext()` 方法做角色感知过滤（Tail+Blackboard / 关键词相关性 / Token 预算裁剪三种策略），配置开关控制（6 测试）
2. **HookRunner 生产激活与文件变更验证** — `app-init.ts` 当前未创建 HookRunner 实例，8 个事件类型零注册。创建 HookRunner + 注册内置钩子（post-tool-call 文件验证 + session 生命周期），传入 DurableExecutor（5 测试）
3. **DurableExecutor 真实接线与会话恢复** — `app-init.ts:379-389` 的 StepExecutor 是假桩（永远返回 success）。替换为真实的 `AgentLoopStepExecutor`，传入 HookRunner，启动时检查可恢复执行并提示用户（4 测试）
4. **执行轨迹导出与聚合分析** — 审计/追踪/token 三系统数据分散。创建 `TrajectoryExporter`（单会话导出）+ `TrajectoryAggregator`（跨会话聚合），CLI 入口 `/trajectory`（3 测试）
5. **集成测试与文档同步** — AGENTS.md 陷阱 #45-48 + CODEMAP.md + CHANGELOG.md v2.7.0（验证通过）

**设计理念：**
- 不是写新功能，而是让已有基础设施真正通电——HookRunner（8 事件类型零注册）、DurableExecutor（StepExecutor 假桩）、Worker 上下文（全量传递浪费 token）
- 三个核心洞察来自研究报告：选择性上下文是 token 节省最大杠杆、Agent Harness 要求代码可执行可检视有状态、自验证应该逐步而非最终一次
- 每个 Task 的思考引导涵盖策略选择（过滤策略/验证深度/StepExecutor 实现方式）、配置设计（是否加 schema 字段）、向后兼容（过滤失败的回退机制）

### Phase 36 — 上下文智能增强与工程方法论集成 ❌ NOT STARTED（v2.8.0）

4 个 Task + 集成测试，≥16 新增测试。依据 6 个外部来源：SWE-Pruner 论文（任务感知裁剪）、codebase-memory-mcp（代码智能 MCP）、Ponytail（极简优先级）、ECC（持续学习）、Superpowers（工程方法论）、费曼学AI 视频系列（Agent 记忆系统设计铁律）。

1. **codebase-memory-mcp 集成（替代 P34 Task 4）** — 集成开源的 codebase-memory-mcp 服务器（纯 C 零依赖、tree-sitter 158 种语言、SQLite 知识图谱、14 个 MCP 工具、125 倍 token 节省）。编写安装辅助脚本 + Skill 引导 Agent 使用 + 验证 MCP 工具链路（4 测试）
2. **任务感知上下文裁剪（增强 P35 Task 1）** — 受 SWE-Pruner 启发，在 Worker 上下文过滤前依次增加两个步骤：`classifyInfoValue()` 信息三分类（该扔/该缓存/该存，来自费曼学AI"7 步设计 Agent 记忆系统"）+ `declareFocus()` 关注点声明（从 task.description 提取 3-5 个关键词，纯文本处理不调用 LLM），用分类+关键词双重机制指导过滤（5 测试）
3. **极简编码优先级 Skill（Ponytail 6 层）** — 创建 `minimalist-coding` Skill（6 层决策树：丢弃→标准库→原生→已有依赖→单行→最小实现）+ `/tech-debt` 命令（add/list/resolve）+ 技术债 JSON 持久化（3 测试）
4. **KnowledgeGraph 模式聚类与置信度** — 内容相似性聚类（Jaccard 相似度合并重复节点）+ 置信度评分（validatedCount × 时间衰减 × 多源验证）+ 过时标记（validUntil/supersededBy，来自费曼学AI"过时记忆是毒药"洞察）+ Dream → KnowledgeGraph 信息流桥接（含归纳三步：合并同类→冲突检测→时效淘汰）（4 测试）
5. **集成测试与文档同步** — AGENTS.md 陷阱 #49-54 + CODEMAP.md + CHANGELOG.md v2.8.0（验证通过）

**设计理念：**
- 从 6 个外部来源中提取经过验证的思路，不从零造轮子——codebase-memory-mcp 直接集成、SWE-Pruner 的洞察用轻量 NLP 落地、Ponytail 6 层写成 Skill、费曼学AI 的信息三分类和过时标记补充记忆系统设计
- Task 1 与 Phase 34 Task 4 是替代关系（集成现成 MCP vs 从零自建 Repo Map），Task 2 与 Phase 35 Task 1 是增强关系（分类+关注点声明叠加在基础过滤之上）
- 每个 Task 的思考引导涵盖技术选型（Jaccard vs embedding）、触发时机（聚类何时执行）、配置设计（置信度衰减率）、存储策略（计算字段 vs 持久化字段）、分类粒度（宁严勿松 vs 宁松勿严）

### Phase 37 — 智能交互、自动化与开发者工作流增强 ❌ NOT STARTED（v2.9.0）

4 个 Task + 集成测试，≥30 新增测试。前置依赖：Phase 36（v2.8.0）。合并原 Phase 37（智能交互自动化）与 Phase 38（Git 分支实验）的需求，重新组织为四个主题内聚的 Task。

1. **`/goal` 需求澄清追问系统（≥7 测试）** — 新建 `RequirementsClarifier` 模块，对 `/goal` 输入做 LLM 歧义评分（0-1），阈值触发 1-3 个追问问题，合并用户回答生成 `enrichedGoalText`。配置项 `clarification.threshold`/`maxQuestions`/`autoSkip`。SettingsPage 新增"需求澄清"Card（目标验证器标签页内）
2. **自动化调度与后台行为控制（≥13 测试）** — 新建 `ScheduleEngine` 模块（Cron 解析 + JSON 持久化 + 主进程定时器），`/schedule` 命令（add/list/remove/run），`backgroundBehavior`（exit/minimize-to-tray/ask）+ `activeTaskOnClose`（terminate/continue-in-background/prompt）配置，SettingsPage 新增"自动化调度"和"后台行为"Card
3. **Git 分支实验与选择性回滚（≥10 测试）** — 新建 `ExperimentManager`（Git Worktree 创建/运行/对比/采纳/丢弃），`/experiment` 命令族，扩展 `/rollback` 支持文件级（`git checkout <commit> -- <file>`）和预览模式，实验分支检查点隔离（`experimentId` 标记）
4. **插件生态兼容研究（≥3 测试）** — 研究 Codex/Claude Code 插件格式与 MCP 协议的互操作性，产出兼容性矩阵文档，编写 `mcp-bridge-adapter` 原型验证 MCP 工具双向桥接，评估 AGENTS.md/CLAUDE.md 约定文件统一方案

**设计理念：**
- 按"主题内聚"而非原始分组组织 Task——调度+后台行为合并（都关于"用户不在场时 Agent 如何运行"），Git 实验+选择性回滚合并（都关于"安全地尝试代码变更"）
- 浏览器自动化（原 Phase 38 Task 3）降级为未来 MCP 桥接扩展项，不在本 Phase 实现——Playwright MCP 已可作为外部 MCP 服务器直接接入
- SettingsPage UI 分散到各 Task（Task 1 加"需求澄清"Card，Task 2 加"调度"+"后台行为"Card），避免单独 UI Task 的"写了但没接线"问题
- 插件兼容定位为研究+原型验证（不是完整实现），产出兼容性矩阵文档和最小可行桥接器

### Phase 38 — Harness 中间件、子 Agent 工具化与知识管理增强 ❌ NOT STARTED（v3.0.0）

4 个 Task + 集成测试，≥35 新增测试。前置依赖：Phase 37（v2.9.0）。依据 DEEP_RESEARCH_agent_frameworks_2026-06-23.md（deepagents-in-action / deer-flow / cognee / multica 四项目对标调研）和 AUDIT-REPORT-2026-06-21.md（全量代码审查）。

1. **中间件管道全面激活（≥8 测试）** — 激活 `AgentMiddlewarePipeline` 的 4 个未使用阶段（`onSystemPrompt`/`onModelCall`/`onReasoning`/`onAgent`），新增 `LoopDetectionMiddleware`（参考 deer-flow 检测重复工具调用循环），从 loop.ts 提取已有逻辑为中间件（TokenTracking/ResultSanitize/Steering），形成完整洋葱模型
2. **子 Agent 工具化与防递归增强（≥7 测试）** — 完善 `SpawnAgentTool` 为 deer-flow 式 `task` 工具（`description`/`prompt`/`subagentType`/`maxIterations`/`isolated`），子 Agent 工具集移除 `spawn_agent` 从设计层面杜绝递归，4 种角色类型（general/researcher/coder/reviewer）各自工具集，并行上限控制
3. **知识图谱反馈闭环与遗忘机制（≥10 测试）** — 修复 `/dream` → `ingestToGraph()` 死代码桥接，新增 `improve()` 反馈方法（参考 cognee 的 4-method API），新增 `forget()` 主动遗忘（dryRun 预览 + 入边保护），扩展 `/memory` 命令族（list/forget/feedback）
4. **多策略记忆检索与图谱持久化（≥7 测试）** — 重构 `recall()` 支持 5 种策略（semantic/graph/temporal/type_weighted/hybrid），自动策略路由器（纯关键词不调 LLM），KnowledgeGraph 跨会话持久化（JSON + debounce + 文件锁），评估 `embedding?` 字段去留
5. **集成测试与文档同步（≥3 测试）** — AGENTS.md 陷阱 #60-64 + CODEMAP.md + CHANGELOG.md v3.0.0 + package.json 3.0.0

**设计理念：**
- 三个系统性架构缺口来自调研对标：中间件"五用一"（deepagents-in-action ETCLOVG 七层分类）、子 Agent 硬编码（deer-flow"子 Agent 即工具"模式）、知识图谱只进不出（cognee `remember/recall/forget/improve` 四方法闭环）
- 以最小改动量补齐——`AgentMiddlewarePipeline` 已存在只需激活、`SpawnAgentTool` 已定义只需增强接线、`KnowledgeGraph` 已有丰富能力只需补反馈和遗忘
- 每个 Task 的思考引导涵盖性能开销（中间件链 5N 次调用）、隔离策略（子 Agent 上下文独立 vs 继承）、反馈粒度（离散等级 vs 数值分数）、持久化时机（每次修改 vs 批量）

### Phase 39 — 代码地图增强、Skill/Hook 自动生成 ❌ NOT STARTED（v3.1.0）

前置依赖：Phase 38（v3.0.0）。尚未完成详细设计，当前为占位 Phase。方向包括代码地图（CodeMap）增强（自动化代码索引与依赖可视化）、Skill 自动生成（从成功工作流中自动提取可复用 Skill）、Hook 自动生成（从常见操作模式中自动注册钩子）。

### Phase 40 — 渐进式信任权限、确定性路由与 Agent 质量监测 ❌ NOT STARTED（v3.2.0）

5 个 Task + 集成测试，≥32 新增测试。前置依赖：Phase 38（v3.0.0）。依据 PRODUCT-INSIGHT-2026-06-24.md（字节跳动 Agent 实践手册解析 + 社区痛点调研）和 AI编程Agent用户痛点研究报告.md（20 痛点 × 25+ 来源）。

0. **构建管道加固与自动清理（≥2 测试）— 最高优先级** — 解决 Windows Defender（MsMpEng.exe）实时扫描锁 `app.asar` 导致 electron-builder 构建失败的问题。新增 `scripts/setup-dev-env.ps1`（Defender 排除项引导）、`predist:electron` pre-hook（构建前清理进程+目录）、`afterPack` 钩子（构建后清理 stale 目录）、electron-builder 重试包装。根因：Defender 扫描 `app.asar` → 文件锁 → 构建失败 → 执行人改目录名绕过 → stale 目录膨胀（已积累 12 个 stale 目录占 2 GB）
1. **渐进式信任权限系统（≥8 测试）** — 激活 `TrustGradientManager` 死代码（7 级信任梯度 + 会话临时授权），接入 `PermissionEngine` 和 `app-init.ts`，五级操作风险分类（read/write/execute/network/push），跨会话偏好持久化（`.routedev/trust-preferences.json`），`/trust` 命令（status/level/prefs/reset），Windows 危险命令 deny 规则补全（format/diskpart/reg delete/bcdedit）
2. **确定性路由与混合决策（≥7 测试）** — `ScenarioTier` 新增 `'deterministic'` 级别，分类策略链插入确定性快速通道（命令正则 → **确定性规则** → LLM → 关键词回退），覆盖斜杠命令查询、简单信息查询、纯文件读取等零 LLM 场景，与 `TaskComplexityAnalyzer` 共享规则源，ModelRouter 对 deterministic 直接走最低成本路径
3. **Agent 质量监测与隐式反馈闭环（≥8 测试）** — 新增 `QualitySignalMiddleware`（onActing 阶段采集质量信号），`ImplicitFeedbackDetector`（检测 output_edited / action_rolled_back / intent_repeated / execution_interrupted / confirmation_rejected 五种行为模式），AuditLogger 扩展 `user_feedback` 和 `quality_signal` 审计动作，`QualityAggregator` 按模型聚合负面信号率触发降级建议，`/quality` 命令展示质量仪表盘，KnowledgeGraph `improve()` 自动触发
4. **用户经验适配层（≥5 测试）** — `userExpertise` 三级配置（beginner/intermediate/expert），六维度行为差异化（解释详细度/确认频率/代码注释/批量操作/错误处理/学习提示），通过 `onSystemPrompt` 中间件注入系统提示词，与 Phase 34 的 OutputStyle 协同（expertise 影响 outputStyle 默认值但不锁定），首次启动引导式等级选择
5. **集成测试与文档同步（≥2 测试）** — 跨 Task 联动测试（deterministic+信任 / 反馈+降级 / 经验+权限 / deterministic+安全中间件）+ AGENTS.md 陷阱 #53-58 + CODEMAP.md + CHANGELOG.md v3.2.0

**设计理念：**
- Task 0（最高优先级）来自开发实践痛点：Windows Defender 锁 `app.asar` → 构建失败 → stale 目录膨胀 2 GB。三层解决方案：排除项（治本）+ pre-build 清理（治标）+ 重试（兜底）
- Task 1-4 来自字节手册 × 社区痛点的交叉分析：渐进式信任（手册混合决策 × 痛点 11 权限极化）、确定性路由（手册规则引擎 × 痛点 4 Token 成本）、质量监测（手册数据闭环 × 痛点 9 信任赤字）、经验适配（手册人才培养 × 痛点 13 效率悖论）
- 执行顺序：Task 0 最先（5 分钟环境配置），然后 Task 1+2 可并行，Task 3+4 需要前两者稳定
- 核心发现：`TrustGradientManager` 是已实现的死代码（7 级梯度 + SHA-256 参数哈希 + 30 分钟 TTL），激活成本远低于从零构建；`ScenarioClassifier` 缺少 `deterministic` 级别导致所有请求都经过 LLM
- 每个 Task 的思考引导涵盖优先级冲突（deny > trust gradient > confirm/auto）、误判风险（确定性通道的保守策略）、去抖设计（隐式反馈的 3 秒窗口）、冷启动（质量监测的前 50 次调用豁免）、Token 预算（beginner 系统提示词更长但不挤占用户上下文）

### Phase 46 — 死代码清零与接线收尾 ✅ DONE（v3.7.0）

10 个 Task，≥35 新增测试（实际 65 通过）。核心目标："所见即所用"——系统性清零 45 个 Phase 积累的死代码与断链：IPC 桥接接上、未注册命令注册上、零引用代码删除、过时文档同步。

**执行结果：**
- typecheck ✅ 通过（exit 0）
- 65 个 Phase 46 测试 ✅ 全部通过（6 文件：phase46/adapter/ipc-bridge/registry-client-http/event-fix/command-registration）
- Electron 构建 ⚠️ 被 Windows Defender 锁 `app.asar` 阻塞（环境问题，非代码问题）

**Task 完成详情：**

| Task | 描述 | 状态 | 测试 |
|------|------|------|------|
| 1 | IPC Handler 桥接（CodeGraph/Experiment/Hook） | ✅ | 9 测试（ipc-bridge.test.ts） |
| 2 | HookConfigRegistry → HookRunner 接线 | ✅ | 6 测试（adapter.test.ts） |
| 3 | HttpRegistryClient 实现 | ✅ | 9 测试（registry-client-http.test.ts） |
| 4 | token-alert.json 事件类型修复 | ✅ | 6 测试（event-fix.test.ts） |
| 5 | 注册 5 个未注册的 CLI 命令 | ✅ | 6 测试（command-registration.test.ts） |
| 6 | 清理 9 个未引用的桌面渲染组件 | ✅ | typecheck 验证 |
| 7 | 清理 6 个生产零引用的导出 | ✅ | typecheck 验证 |
| 8 | 清理死测试代码 | ✅ | 4 个受影响测试已修复 |
| 9 | 文档同步（AGENTS.md/CODEMAP.md/config.example.yaml） | ✅ | 文档验证 |
| 10 | 集成测试与最终验证 | ✅ | 29 测试（phase46.test.ts） |

**主要改动：**
- **IPC 桥接**：`desktop/main/engine-bridge.ts` 新增 10 个 public 方法，`desktop/main/index.ts` 9 个 IPC handler 从桩实现改为直接调用
- **Hook 接线**：新增 `src/hooks/adapter.ts`（HookConfig → HookDefinition 转换器），`src/cli/app-init.ts` 接线 HookConfigRegistry → HookRunner
- **HTTP 客户端**：`src/skills/registry-client.ts` 的 `HttpRegistryClient` 完整实现（fetch + URL 规范化）
- **事件修复**：`HookEvent` 类型新增 `on-model-call`，`registry.ts` 新增 `VALID_EVENTS` 白名单
- **命令注册**：`src/cli/App.tsx` 补注册 5 个命令（clarify/experiment/quality/schedule/trust）
- **死代码清理**：删除 15 个文件（9 桌面组件 + 3 源文件 + 3 测试文件），清理 `trust-gradient.ts` 中的 `CompactionAuditLog`/`createSandboxedRegistry`
- **构建脚本改进**：`scripts/clean-release.ts` 新增 `cleanOutputContents()` 清理 `release-v3/win-unpacked`（Defender 锁文件治理），重试次数 3→10、间隔 1s→3s

**构建阻塞说明：**
- `release-v3/win-unpacked/resources/app.asar` 被 Windows Defender (MsMpEng.exe) 在 OS 级别持续锁定
- 已尝试：PowerShell Remove-Item / .NET File.Delete / .NET File.Move / Rename-Item / NT 路径前缀 `\\?\` / 等待 60s 重试 / 10 次重试 × 3s / 3 次构建重试 — 均失败
- 已改进 `clean-release.ts` 在构建前清理 `win-unpacked`，但 Defender 锁文件超过 30 秒重试窗口
- **解决方式**：用户需重启系统释放文件锁，或以管理员身份运行 `Add-MpPreference -ExclusionPath 'C:\Users\杨铭\Desktop\Agent\routedev\release-v3'` 后重新执行 `pnpm run dist:electron:safe`

**新增陷阱警告（AGENTS.md #126-132）：**
- #126 IPC handler 桥接后必须保留 fail-open
- #127 HookConfig → HookDefinition 转换必须做变量替换而非字符串拼接
- #128 Hook shell command 必须设超时
- #129 on-model-call 事件触发点必须在 LLM 调用前 fire
- #130 HttpRegistryClient 必须校验 registryUrl 格式
- #131 删除导出时必须检查同文件其他导出
- #132 HookMarketManager 接线必须与 HookConfigRegistry 共存

### Phase 47 — 开发者工作流产品化与体验闭环 ✅ DONE（v3.8.0）

10 个 Task，≥40 新增测试（实际 256 通过，10 个测试文件）。核心目标：把已有能力「产品化」——让 Agent 自主帮用户完成配置、引导用户走通流程、而非只提一嘴「建议怎么做」。

**执行结果：**
- typecheck ✅ 通过（exit 0）
- 256 个 Phase 47 测试 ✅ 全部通过（10 文件）
- Electron 构建 ✅ 成功（`release-v4/RouteDev Setup 3.8.0.exe`，80.5 MB）
  - 注：因 `release-v3/win-unpacked/resources/app.asar` 仍被 Windows Defender 锁定（Phase 46 遗留），本次构建临时输出到 `release-v4` 目录

**Task 完成详情：**

| Task | 描述 | 状态 | 测试 |
|------|------|------|------|
| 1 | AGENTS.md 瘦身与按需加载 | ✅ | 12 测试 |
| 2 | Skill/Tool description 规范与自动审计 | ✅ | 23 测试 |
| 3 | routedev exec 非交互模式 | ✅ | 20 测试 |
| 4 | 沙箱级与审批级分离的权限模型 | ✅ | 39 测试 |
| 5 | /review 独立子代理对抗性审查 | ✅ | 31 测试 |
| 6 | Checkpoint 可视化时间轴与语义化摘要 | ✅ | 13 测试 |
| 7 | 自定义 Slash 命令 | ✅ | 9 测试 |
| 8 | AGENTS.local.md 与 CLAUDE.md fallback 兼容 | ✅ | 23 测试 |
| 9 | 官方 GitHub Action 与 CI 集成模板 | ✅ | 49 测试 |
| 10 | 集成测试与文档同步 | ✅ | 37 测试 |

**主要改动：**
- **AGENTS.md 瘦身**：从 136 行瘦身到 74 行，71 条陷阱迁移到 `.routedev/skills/pitfalls-guide/SKILL.md`
- **description 规范**：新增 `docs/DESCRIPTION_GUIDE.md` + `scripts/lint-descriptions.ts`，14 个内置工具 description 全部改写
- **exec 非交互模式**：新增 `src/cli/exec-runner.ts` + `parseExecArgs()`，支持 `--json`/`--timeout`/`--workMode`/`--allowedTools`
- **权限双旋钮**：PermissionEngine 新增 `SandboxLevel`（read-only/workspace-write/full-access）+ `ApprovalLevel`（always-ask/on-request/never-ask），向后兼容
- **/review 对抗审查**：新增 `src/cli/commands/review.ts`，独立子代理会话 + read-only 沙箱 + 4 种审查 focus
- **Checkpoint 可视化**：新增 `CheckpointTimeline.tsx` 组件 + LLM 语义化摘要（3 秒超时降级）+ IPC 桥接
- **自定义命令**：新增 `src/cli/custom-commands.ts`，支持 `.routedev/commands/*.md` + 模板变量替换（一次性不递归）
- **fallback 兼容**：新增 `loadProjectDoc()`，支持 AGENTS.md/AGENTS.local.md/AGENTS.override.md/CLAUDE.md 加载链
- **GitHub Action**：新增 `action.yml` + `scripts/action-entry.ts` + `.github/workflows/routedev-example.yml` + `docs/CI_SECURITY.md`

**新增陷阱警告（AGENTS.md #133-142 + SKILL.md 完整版）：**
- #133 AGENTS.md 瘦身后必须保留 Top 10 核心陷阱在正文
- #134 description lint 不能阻断开发流程（过渡期 warning）
- #135 routedev exec 必须设总超时，headless 下 always-ask 自动 deny
- #136 沙箱级判断必须在审批级之前
- #137 /review 子代理必须用 read-only 沙箱
- #138 Checkpoint 语义化摘要的 LLM 调用必须设超时与降级
- #139 自定义命令的模板变量替换必须转义（一次性替换不递归）
- #140 AGENTS.override.md 的语义是「跳过」而非「合并」
- #141 GitHub Action 的 config 必须用 Base64 传输
- #142 沙箱级切换需要刷新工具可用性缓存
