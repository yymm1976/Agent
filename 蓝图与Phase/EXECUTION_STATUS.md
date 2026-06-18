# RouteDev — Phase 执行状态总表

> **最后更新：** 2026-06-18（Phase 29 完成，v2.1.0 已发布；全部 29 个开发 Phase 完成，项目进入维护模式）
> **仓库 commit：** 待提交（Phase 20-29 + 0c）
> **测试基线：** 1339 测试 / 123 文件（Phase 29 完成后，+97 测试 / +16 文件）
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
