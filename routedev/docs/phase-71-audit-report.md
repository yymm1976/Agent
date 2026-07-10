# Phase 71 审计报告

> 本报告汇总 Phase 71 各 Task 的审计结论，依据实际 git commit 历史与各 Task 报告中已识别的 RISK。
>
> 审计流程参见 [subagent-audit-process.md](./subagent-audit-process.md)。
>
> 报告生成时间：Phase 71 Task F2（纪律层收尾）。
> 本报告反映 Phase 71 时点状态，后续 Phase 可能已变更相关实现。

---

## 1. 审计范围

Phase 71 主题：**严禁死代码 + 自审** 纪律层落地。覆盖以下 5 个能力域：

- A 档：CodeMap 与上下文工程（A1-A5）
- B 档：协议层（@-mention、recall）（B1-B4）
- C 档：质量门与审计链（C1-C2）
- D 档：上下文工程核心机制（ContextPacker / Memory / progressive-disclosure / offload）（D1-D7）
- E 档：Agent 工具与 prompt 纪律（E1-E3）
- F 档：纪律层工具与流程（F1-F2）

Task 总数：A1-A5（5）+ B1-B4（4）+ C1-C2（2）+ D1-D7（7）+ E1-E3（3）+ F1-F2（2）= **23 个 Task**。其中 F2 为本审计报告任务，前 22 个 Task 已完成。

---

## 2. 各 Task 完成状态 + CONCERN 索引

### 2.1 A 档：CodeMap 与上下文工程

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| A1 | CodeMap 基础结构 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| A2 | PageRank 计算 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| A3 | CodeMap 接入 loop.ts | 前序已提交 | 已完成 | 0 | 0 | 0 |
| A4 | 上下文工程 wiring | 前序已提交 | 已完成 | 0 | 0 | 0 |
| A5 | content hash 缓存 + 增量 PageRank + watch mode | `b7b5251` | 已完成 | 0 | 1 | 0 |

**A5 RISK**：原计划使用 `chokidar` 实现 watch mode，但 `chokidar` 未安装，改用 Node 原生 `fs.watch`。原生 `fs.watch` 在 Windows 下递归监听行为不稳定，后续 Phase 需评估是否补装 `chokidar`。

### 2.2 B 档：协议层

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| B1 | recall 协议基础 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| B2 | @-mention 统一引用协议 | `967fe4f` | 已完成 | 0 | 1 | 0 |
| B3 | recall 工具注册 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| B4 | recallToPromptWithEpisodes | 前序已提交 | 已完成 | 0 | 1 | 0 |

**B2 RISK**：`@-mention` 协议仅在 `loop.ts` 接入，未覆盖 `spawn-agent.ts` 的子 Agent 输入路径。后续 Phase 评估是否在子 Agent 输入也启用 @-mention。

**B4 RISK**：`recallToPromptWithEpisodes` 无生产调用方，`loop.ts` 仍用同步版 `recallToPrompt`。该异步版函数仅被测试 import，存在 test-only 嫌疑。

### 2.3 C 档：质量门与审计链

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| C1 | 质量门扩展 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| C2 | 审计链接入 | 前序已提交 | 已完成 | 0 | 0 | 0 |

### 2.4 D 档：上下文工程核心机制

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| D1 | ContextPacker 基础 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| D2 | ContextPacker 接入 | 前序已提交 | 已完成 | 0 | 0 | 0 |
| D3 | setToolOutputPipeline | 前序已提交 | 已完成 | 0 | 1（交叉审查补齐闭环） | 0 |
| D4 | ContextPacker 启用 + tiktoken | 无独立 commit | 已完成 | 0 | 0 | 0 |
| D5 | CodebaseMemory 升级为语义检索 | `b216b58` | 已完成 | 0 | 1 | 0 |
| D6 | progressive-disclosure | 无独立 commit | 已完成 | 0 | 0 | 0 |
| D7 | offload 文件清理机制 | `5b05e07` | 已完成 | 0 | 0 | 0 |

**D3 RISK（交叉审查补齐闭环）**：`setToolOutputPipeline` 在 D3 提交时无调用方注入（test-only 嫌疑）。D7 在 `loop.ts` 加了调用点（L638-641），但 `app-init.ts` 的实例化与注入在 D7 commit 时遗漏——pipeline 在生产环境永远为 `null`，`phase70Integration.toolOutputBudget.enabled` 沦为僵尸配置。Phase 71 交叉审查阶段发现此事实错误并补齐：在 `app-init.ts` L1664-1675 构造 `ToolOutputPipeline` 实例并调用 `setToolOutputPipeline`，复用 `resultSanitizer` + `offloadRootDir` + `offloadSessionId`，消费 `p70Cfg.toolOutputBudget` 配置。本 RISK 在 Phase 71 交叉审查阶段闭环，不计入跨 Phase RISK 清单。

**D5 RISK**：`defaults.ts` 包含前序任务未提交改动。D5 commit `b216b58` 中 `defaults.ts` 的 diff 含 D1-D4 期间累积的配置字段，与"单 Task 单 commit"原则不符。属历史遗留，不影响功能。

**D4 / D6 commit 缺失说明**：D4（ContextPacker 启用 + tiktoken）与 D6（progressive-disclosure）未发现独立 commit，其改动可能被合并到 D5 / D7 或更早 commit 中。审计时如需追溯具体改动，建议 `git log -p --all -- src/agent/context-packer.ts src/agent/progressive-disclosure.ts`。

### 2.5 E 档：Agent 工具与 prompt 纪律

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| E1 | 进程内 VFS + 4 个 VFS 工具 | `81e2c43` | 已完成 | 0 | 1 | 0 |
| E2 | 显式 plan 可读写状态 + 5 个 plan 工具 | `8ce6e27` | 已完成 | 0 | 0 | 0 |
| E3 | prompt 引导上下文工程纪律 | `b4dabfb` | 已完成 | 0 | 1 | 0 |

**E1 RISK**：git commit 一度被取消（提交过程中断），父 Agent 已补提交为 `81e2c43`。补提交时改动完整性已复核，但建议后续 Phase 在 commit 完成后立即 `git log -1 --stat` 验证文件清单。

**E3 RISK**：`system-prompt-builder.ts` 含 D1/D2 残留改动。E3 commit `b4dabfb` 的 `system-prompt-builder.ts` diff 中混入了 D1/D2 期间的 prompt 文本调整，与"单 Task 单 commit"原则不符。属历史遗留，不影响功能。

### 2.6 F 档：纪律层工具与流程

| Task | 标题 | Commit | 状态 | FATAL | RISK | SUGGEST |
|------|------|--------|------|-------|------|---------|
| F1 | 死代码检测脚本 | `e3fdcaa` | 已完成 | 0 | 1 | 0 |
| F2 | 子 Agent 独立审计流程文档 | 本 commit | 进行中 → 已完成 | 0 | 0 | 0 |

**F1 RISK**：`dead-code-report.json` 与 Phase 53 `scripts/audit-dead-code.ts` 双写冲突。两脚本都向项目根的 `dead-code-report.json` 写入，后执行者覆盖先执行者。后续 Phase 应统一为单一脚本（建议保留 `detect-dead-code.ts`，废弃 `audit-dead-code.ts` 的 JSON 写入）。

**F2**：本任务，新增 `docs/subagent-audit-process.md` + `docs/phase-71-audit-report.md`（本文件）。无代码改动，无 FATAL / RISK / SUGGEST。

---

## 3. 已知 RISK 清单（跨 Phase 跟踪）

以下 RISK 在 Phase 71 内未闭环，需在 Phase 72+ 评估是否修复。按"维度 + Task"索引：

| # | 维度 | Task | 文件 / 符号 | 描述 | 建议处理 Phase |
|---|------|------|-------------|------|----------------|
| R1 | 调用方完整性 | B4 | `recallToPromptWithEpisodes` | 无生产调用方，loop.ts 仍用同步版 | Phase 72 评估接入或删除 |
| R2 | 调用方完整性 | B2 | `src/agent/spawn-agent.ts` | @-mention 未覆盖子 Agent 输入路径 | Phase 72 评估扩展 |
| R3 | 配置消费链 | D5 | `src/config/defaults.ts` | 含前序任务未提交改动 | Phase 72 在首个 commit 中清理 |
| R4 | 工具链 | A5 | watch mode 实现 | chokidar 未安装，改用 Node 原生 fs.watch | Phase 72 评估补装 chokidar |
| R5 | 工具链 | F1 | `dead-code-report.json` 双写 | detect-dead-code.ts 与 audit-dead-code.ts 冲突 | Phase 72 统一为单一脚本 |
| R6 | 调用方完整性 | E3 | `system-prompt-builder.ts` | 含 D1/D2 残留改动 | Phase 72 在首个 commit 中清理 |
| R7 | 流程 | E1 | git commit 中断 | 父 Agent 已补提交，需后续 Phase 验证 | Phase 72 起强制 `git log -1 --stat` 复核 |

### 3.0 RISK 闭环状态（2026-07-10 技术债修复阶段 5 更新）

| # | 状态 | 闭环说明 |
|---|------|----------|
| R1 | ✅ 已闭环 | `recallToPromptWithEpisodes` 已在后续 Phase 删除（grep 零结果） |
| R2 | ⏸️ 评估后保持现状 | 子 Agent 输入为结构化参数，不需要 @-mention 解析；MentionResolverMiddleware 仅服务于用户消息层 |
| R3 | ⏸️ 已接受 | `defaults.ts` 历史遗留不影响功能，schema.ts 已独立维护 |
| R4 | ✅ 已闭环 | TD-18 增强：watcher.ts 添加自动重连机制（最多 5 次，延迟 3s），保持 Node 22 原生 fs.watch，不依赖 chokidar |
| R5 | ✅ 已闭环 | `audit-dead-code.ts` 已删除（grep 仅在本文档中有引用），`detect-dead-code.ts` 为唯一脚本 |
| R6 | ✅ 已闭环 | `system-prompt-builder.ts` 已删除（文件不存在） |
| R7 | ✅ 已闭环 | CONTRIBUTING.md 已包含 commit 验证规范 |

### 3.1 RISK 升级评估

依据 [subagent-audit-process.md §5.2](./subagent-audit-process.md#52-risk-升级为-fatal-的条件)，RISK 在连续 2 个 Phase 内未解决将升级为 FATAL。Phase 71 内的 7 项 RISK 在 Phase 73 之前必须闭环或显式说明延后理由，否则 Phase 73 交叉审查时自动升级。

### 3.2 D3 跨 commit 拆分（交叉审查补齐闭环，不计入跨 Phase RISK）

D3 的 `setToolOutputPipeline` 在 D3 commit 时无调用方，属于"跨 commit 拆分"RISK。D7 commit `5b05e07` 在 `loop.ts` 加了调用点但遗漏了 `app-init.ts` 的实例化注入，导致 pipeline 在生产环境永远为 `null`。Phase 71 交叉审查阶段发现此事实错误并补齐 `app-init.ts` L1664-1675 的注入，本 RISK 在 Phase 71 内闭环。后续 Phase 无需跟踪。

---

## 4. Phase 71 审计结论

### 4.1 合入判定

| 维度 | 数值 |
|------|------|
| Task 总数 | 23（含本 F2） |
| 已完成 Task | 23 |
| FATAL 总数 | 0 |
| RISK 总数（去重） | 7（见 §3） |
| SUGGEST 总数 | 0 |
| 跨 Phase 未闭环 RISK | 7 |

**结论**：Phase 71 无 FATAL，可合入。7 项 RISK 已记录到 §3 清单，转入 Phase 72+ 跟踪。

### 4.2 纪律层达成度

Phase 71 的目标是"严禁死代码 + 自审"纪律层落地。达成度评估：

| 纪律层目标 | 达成 | 证据 |
|------------|------|------|
| 死代码检测脚本可用 | 是 | `scripts/detect-dead-code.ts`（commit `e3fdcaa`） |
| 审计流程文档化 | 是 | `docs/subagent-audit-process.md`（本 Phase F2） |
| Phase 级审计报告固化 | 是 | `docs/phase-71-audit-report.md`（本 Phase F2，本文件） |
| 5 维审计维度可执行 | 是 | subagent-audit-process.md §2-§3 给出可执行命令 |
| RISK 跨 Phase 跟踪机制 | 是 | 本报告 §3 + subagent-audit-process.md §5.2 升级规则 |

### 4.3 后续 Phase 必做项

Phase 72 起每个 Phase 必须产出：

1. `docs/phase-{N}-audit-report.md`（按本文件格式）
2. 跑 `node --import tsx/esm scripts/detect-dead-code.ts` 并附 `dead-code-report.json` 摘要
3. 把新 RISK 追加到本文件 §3 表格（或标注已闭环）
4. **技术债同步**：新发现的技术债追加到 `docs/TECH_DEBT_TRACKER.md` §1；修复完成的项移至 §3。后续审查报告 findings 前必须对照该表，已排期项不重复报告。

---

## 5. 审计依据

本报告所有结论基于以下事实来源：

| 来源 | 用途 | 获取方式 |
|------|------|----------|
| `git log --oneline \| rg "Phase 71"` | Phase 71 commit 清单 | shell |
| `git show <hash> --stat` | 单 commit 改动文件清单 | shell |
| `scripts/detect-dead-code.ts` 头部注释 | 死代码检测脚本用法 | 文件读取 |
| 各 Task 报告中的 RISK 声明 | 已知 RISK 清单 | Task 描述传递 |
| `docs/DEAD_CODE_AUDIT.md` | Phase 50 历史 RISK 对照 | 文件读取 |

凡无法通过上述来源验证的事项，本报告显式标注"无独立 commit"或"建议后续追溯"，不编造结论。

---

## 相关文档

- [subagent-audit-process.md](./subagent-audit-process.md) — 子 Agent 独立审计流程（本 Phase F2 新增）
- [DEAD_CODE_AUDIT.md](./DEAD_CODE_AUDIT.md) — Phase 50 死代码全量审计
- [QUALITY_GATE.md](./QUALITY_GATE.md) — Skill 质量门
