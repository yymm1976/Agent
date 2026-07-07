# Phase 75：外部开源借鉴落地——tau 工程实践 + Superpowers v6 上下文流动优化

> **输入**：tau (taubyte/tau) 源码调研（CONTRIBUTING.md / .pre-commit-config.yaml / dream 测试床 / pkg 基础包） × Superpowers v6 (obra/superpowers) 完整 SKILL 源码调研（writing-plans / subagent-driven-development / implementer-prompt / task-reviewer-prompt / code-reviewer / review-package 脚本 / task-brief 脚本 / CLAUDE.md 贡献者规范）+ 用户提供的 v6 核心分析
>
> **日期**：2026-07-07（v2 重写：基于完整 SKILL 源码而非摘要）
>
> **目标**：将两个开源项目的工程智慧落地为 RouteDev 的实际能力增强——tau 提供工程组织与配置管理范式，Superpowers v6 提供 Agent 上下文流动、模型分层与 plan 结构方法论
>
> **核心命题**：AI 编程贵不全是模型贵，更多是 Agent 反复读同一批上下文、重复跑确定性命令造成的浪费。Phase 75 把"确定性工作交给脚本、把昂贵上下文留给判断"作为指导思想，落到 RouteDev 的多 Agent 协作、配置系统、Skill 框架与可观测性上。

---

## 一、调研发现（基于完整源码）

### 1.1 tau（Taubyte）基础工程实践

tau 是分布式 PaaS / Serverless 云平台（Go 91%），核心承诺 "Prompt → Local → Prod"。技术栈含 libp2p / IPFS-lite / wazero / Raft + CRDT。**对 RouteDev 有借鉴价值的是其"基础工程内容"，而非分布式技术栈**。

**CONTRIBUTING.md 揭示的基础规范**（这是上次调研浮于表面漏掉的部分）：

1. **Issue-driven workflow**：所有 PR 必须先开 issue，issue 用 `[scope] description` 格式命名，scope 包括 `bug / feature / dream / tau-cli / auth / seer / tns / spore-drive / cicd`。commit message 也用同样格式：`[bug] fix memory leak in request handler`。
2. **串行测试**：`go test -p 1 ./...`——`-p 1` 让测试一个包一个包跑，避免并发测试互相污染共享资源（如端口、文件系统）。这对 RouteDev 的 e2e 测试有直接启发。
3. **dream 本地云测试床**：`dream/` 是一套完整的本地测试基础设施，含 `api / common / cors` 等子目录。一行命令拉起整个本地云，既做演示也做 e2e 测试床。所有贡献者一行命令复现完整环境。

**.pre-commit-config.yaml 揭示的代码质量基线**：

```yaml
- id: check-yaml
- id: check-added-large-files  # 100MB 上限
- id: go-fmt                   # 排除 gen/ 和 .pb.go
- id: go-imports               # 排除生成代码
```

**pkg/ 揭示的可复用包分层**：`builder / cli / config-compiler / spore-drive / taucorder`——每个 pkg 是一个独立可复用包，有清晰边界。tau 把"工具链代码"与"服务代码"严格分层（pkg/ vs services/）。

**三个工程哲学**（上次已识别，本次保留）：
1. "单 DSL 多产物"——配置 schema 只写一次，`tcc-gen` 同时生成 Go + TS + wasm 三端访问器
2. "诚实标注技术债"——commit message 把 known race、迁移代码、移除日期全部写清楚
3. "local-first 测试床"——dream 让所有贡献者一行命令复现完整环境

### 1.2 Superpowers v6 完整 SKILL 调研（核心）

v6 通过三项改造实现约 50% 速度提升、约 60% token 下降。**核心不是换更便宜的模型，而是优化上下文流动，让 Agent 少看废话**。本次调研读取了 6 个核心 SKILL 文件 + 2 个脚本 + CLAUDE.md 贡献者规范，发现大量上次摘要漏掉的硬核细节。

#### 1.2.1 writing-plans skill 的完整结构（用户特别强调"计划本身也可以学习"）

**Plan Document Header（强制）**：
```markdown
# [Feature Name] Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
**Goal:** [一句话]
**Architecture:** [2-3 句]
**Tech Stack:** [关键技术]
## Global Constraints
[spec 的 project-wide 要求逐行 verbatim——version floors / dependency limits / naming rules / platform requirements]
```

**Task Right-Sizing 原则**（关键）：
> A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. **Fold setup, configuration, scaffolding, and documentation steps into the task whose deliverable needs them**; split only where a reviewer could meaningfully reject one task while approving its neighbor.

即：**不要独立的"setup task"**，setup 要折进第一个需要它的 deliverable task。只在"reviewer 能有意义地拒绝 A 而通过 B"时才 split。

**Bite-Sized Granularity**：每步 2-5 分钟，5 步 TDD：
1. Write the failing test
2. Run to verify FAIL
3. Minimal implementation
4. Run to verify PASS
5. Commit

**Task Structure**：
```markdown
### Task N: [Component]
**Files:** Create/Modify/Test (exact paths + 行号)
**Interfaces:**
- Consumes: [从前面 task 消费的精确签名]
- Produces: [后续 task 依赖的精确签名]
- [ ] Step 1-5: (含真实代码，非占位符)
```

**No Placeholders 硬规则**（plan failures）：
- 禁 "TBD" / "TODO" / "implement later" / "fill in details"
- 禁 "Add appropriate error handling" / "add validation" / "handle edge cases"
- 禁 "Write tests for the above"（必须含真实测试代码）
- 禁 "Similar to Task N"（必须重复代码，因为 engineer 可能乱序读 task）
- 禁 引用未在任何 task 定义的 type/function/method

**Self-Review 三项**（plan 作者自检，非 subagent）：
1. **Spec coverage**：spec 每条要求能否指向一个实现它的 task
2. **Placeholder scan**：搜上述禁语模式
3. **Type consistency**：Task 3 的 `clearLayers()` 与 Task 7 的 `clearFullLayers()` 是否一致

**Execution Handoff**：plan 完成后给用户两个选择：
1. Subagent-Driven（推荐）：fresh subagent per task + 两阶段 review
2. Inline Execution：批量执行 + checkpoint

#### 1.2.2 subagent-driven-development skill 的 controller 硬规则（上次漏掉的核心）

**Continuous execution**（关键）：
> Do not pause to check in with your human partner between tasks. Execute all tasks from the plan without stopping. The only reasons to stop are: BLOCKED status you cannot resolve, ambiguity that genuinely prevents progress, or all tasks complete. **"Should I continue?" prompts and progress summaries waste their time** — they asked you to execute the plan, so execute the plan.

**Narration 纪律**：tool call 间最多一行旁白——ledger 和 tool results carry the record。

**Pre-Flight Plan Review**（执行 Task 1 前扫一次）：
- 找 task 互相矛盾 / 与 Global Constraints 矛盾
- 找 plan 显式 mandate 但 review rubric 视为 defect 的内容（如 assert nothing 的测试、verbatim 重复逻辑块）
- **批量上报人类**（每条 finding 旁边附 plan 原文，问哪个 governs），而非逐条打断
- scan 干净则静默继续

**Handling Implementer Status 四态**：
- **DONE**：生成 review package，dispatch task reviewer
- **DONE_WITH_CONCERNS**：先读 concerns，correctness/scope 问题先解决再 review；observation 类 note 后继续
- **NEEDS_CONTEXT**：补 context 后 re-dispatch
- **BLOCKED**：context 问题补 context / 需要更多推理换更强模型 / task 太大拆小 / plan 错误升级人类。**绝不忽略 escalation 或强制同模型重试**

**Handling Reviewer ⚠️ Items**：
> reviewer 可报 "⚠️ Cannot verify from diff"（需求在未变更代码或跨 task）。这不阻塞本次 review 其余部分，但 **controller 必须自己解决每一条** 后才能 mark task complete——因为 controller 持有 plan 和跨 task 上下文。确认是真实 gap 则按 spec review 失败处理（打回 implementer + re-review）。

**Constructing Reviewer Prompts 的硬规则**（上次完全漏掉）：
- **不要开放指令**：禁 "check all uses" / "run race tests if useful"（除非有具体 task-specific 理由）
- **不要让 reviewer 重跑 implementer 已跑的测试**——implementer report 已带 test evidence
- **禁止 controller 预判 reviewer**：禁语 "do not flag" / "don't treat X as defect" / "at most Minor" / "the plan chose"。若 prompt 含这些 → 停下，你在 pre-judging，通常是为 spared 自己一个 review loop
- **global-constraints block 是 reviewer 的 attention lens**：逐条 verbatim（exact values/formats/relationships），不是 process rules（YAGNI/test hygiene 已在模板里）
- **不要粘贴前序 task summary**：一个真实 session 的 dispatch hit **42k chars，99% 是粘贴的历史**。fresh subagent 只需 task + interfaces + global constraints
- **一次 fix subagent 处理所有 findings**：per-finding fixer 各自重建 context + 重跑 suite，真实 session 的最终 fix wave 成本**超过所有 task 总和**
- **fix dispatch 带 implementer contract**：fix subagent 必须重跑覆盖其改动的测试并报告结果；re-dispatch reviewer 前确认 fix report 含 covering tests + command + output
- **最终 whole-branch review 也要 review package**：`scripts/review-package MERGE_BASE HEAD`，reviewer 一次 Read 而非重跑 git

#### 1.2.3 Durable Progress Ledger（上次漏掉关键引述）

> Conversation memory does not survive compaction. In real sessions, **controllers that lost their place have re-dispatched entire completed task sequences — the single most expensive failure observed**.

**机制**：
- skill start 时 `cat .superpowers/sdd/progress.md`，已 complete 的 task 不重跑
- task review clean 后 append 一行：`Task N: complete (commits <base7>..<head7>, review clean)`
- ledger 是恢复地图：commits 在 git 里即使 context 忘了也存在
- `git clean -fdx` 会摧毁 ledger（git-ignored scratch），从 `git log` 恢复
- **trust the ledger and `git log` over your own recollection**

#### 1.2.4 Model Selection 完整论述（上次漏掉"地板"概念）

> **Turn count beats token price.** Wall-clock and context cost scale with how many turns a subagent takes, and the cheapest models routinely take 2-3× the turns on multi-step work — costing more overall. **Use a mid-tier model as the floor for reviewers and for implementers working from prose descriptions.** When the task's plan text contains the complete code to write, the implementation is transcription plus testing: use the cheapest tier.

**Task complexity signals**：
- 1-2 文件 + 完整 spec → cheap
- 多文件 + 集成 → standard
- 设计判断 / 广 codebase 理解 → most capable
- **最终 whole-branch review 必须用 most capable**，不能用 session 默认

**强制写明 model**：省略则继承 session 最贵模型——v6 实测一次 run 把 26 个 reviewer 全跑到顶配。

#### 1.2.5 review-package 脚本细节（上次漏掉命名规则）

```bash
# 输出：commit list + stat + git diff -U10（10 行上下文）
# 命名：review-<base7>..<head7>.diff（按 range 命名，re-review 不覆盖旧文件）
# BASE 必须用 dispatch 前记录的 commit，禁止 HEAD~1（多 commit 任务会被截断只剩最后一个）
```

#### 1.2.6 task-brief 脚本细节

```bash
# awk 提取 task N 全文，跳过 fence 内伪 heading（``` 内的 # Task 2 不算）
# 输出：.superpowers/sdd/task-N-brief.md
# 避免 task 文本粘贴进 controller context
```

#### 1.2.7 CLAUDE.md 贡献者规范（superpowers 自己的贡献规范，上次完全漏掉）

- **"94% PR rejection rate"**——几乎每个被拒 PR 都是 agent 没读规范
- **"Skills are not prose — they are code that shapes agent behavior"**——skill 修改门槛极高，需 eval 证据
- **PR 必须披露 model / harness / harness version / 所有 plugin**——隐藏 agent 身份是关闭理由
- **"your human partner" 是刻意用词**，不是 "the user"——改写项目 voice 的 PR 会被拒
- **接受测试**：新 harness 集成必须用 "Let's make a react todo list" 测试，brainstorming skill 必须自动触发
- **禁止批量 PR**：一个 session 只解决一个 issue，禁止 trawl issue tracker

#### 1.2.8 失败的反向实验（用户已提供，保留）

- 限制 controller 思考预算：turn 数 92→138，省的 token 被修复轮次吃回
- 压缩 plan 词数：测试信号掉 62%，被砍的正是测试/接口/任务结构
- 用 Sonnet 写 plan：任务数 5.8→3.6，review 颗粒度没了

---

## 二、综合借鉴点清单（按落地优先级排序，基于完整源码）

### 第一波：低成本、立竿见影（低难度）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-A1 | **Review Package 预生成脚本** | Superpowers `scripts/review-package` bash 脚本：commit list + stat + `git diff -U10`，按 `<base7>..<head7>.diff` 命名 | 多 Agent 在 prompt 里粘贴 diff，reviewer 重复跑 git | 新增 `scripts/review-package.mjs`（Node ESM，调用 simple-git）；输出 `.routedev/review/<base7>..<head7>.diff`；BASE 必须用 dispatch 前记录的 commit，禁止 `HEAD~1`；reviewer 一次 Read，禁止重跑 git |
| 75-A2 | **task-brief 抽取脚本** | Superpowers `scripts/task-brief` awk 脚本：提取 task N 全文到文件，跳过 fence 内伪 heading | task 文本粘贴进 controller context | 新增 `scripts/task-brief.mjs`：从 plan 文件提取 task N 全文到 `.routedev/sdd/task-N-brief.md`；implementer dispatch 只引用 brief 路径 |
| 75-A3 | **强制 dispatch model 字段** | Superpowers `model: [MODEL — REQUIRED]`；省略继承 session 最贵模型；v6 实测 26 个 reviewer 全跑顶配 | Router 层有分类器路由，但 dispatch 时未必强制写明 | SubAgent 调度 API 加 `model` 必填校验；省略则报错而非继承；保留 `model: 'inherit'` 显式值作过渡 |
| 75-A4 | **Pre-flight plan review** | Superpowers controller 执行 Task 1 前扫 plan 找冲突，批量上报人类 | plan 生成后直接执行 | 新增 `review-plan` subagent 类型；执行第一个 task 前对 plan 做内部一致性扫描（任务依赖闭环、接口签名匹配、No Placeholders 检查）；冲突 batched 上报用户 |
| 75-A5 | **CONTRIBUTING.md + scope commit 规范** | tau CONTRIBUTING.md：issue-driven + `[scope] description` commit + `go test -p 1` 串行测试 | 无 CONTRIBUTING.md，commit 规范不统一 | 新增 `CONTRIBUTING.md`：规定 issue-driven workflow + `[scope]` commit 格式（scope 列表：`router/agent/skill/ui/setting/cli/infra/docs`）；e2e 测试串行跑 |
| 75-A6 | **Pre-commit hook** | tau `.pre-commit-config.yaml`：check-yaml + check-added-large-files + fmt + imports | 仅有 ESLint/Prettier，缺 pre-commit 自动化 | 新增 `.husky/pre-commit` 跑 lint-staged（eslint --fix + prettier --write）；新增 `commitlint.config.js` 强制 Conventional Commits + scope 校验 |

### 第二波：中难度、长期价值（与上下文压缩方向协同）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-B1 | **File Handoff 替代 paste** | Superpowers：task-brief / report / review-package 三类 artifact 全落文件；implementer 只回 <15 行 summary（status + commits + one-line test summary + concerns + report path） | subagent 间 handoff 以 prompt 内联为主 | subagent 间传递数据落 `.routedev/sdd/<task-id>/`；brief→report 命名约定；parent agent 只收 summary |
| 75-B2 | **Durable Progress Ledger** | Superpowers `.superpowers/sdd/progress.md`；关键引述："controllers that lost their place have re-dispatched entire completed task sequences — the single most expensive failure observed" | Electron 进程内状态易丢失，长任务 compaction 后定位困难 | 新增 `.routedev/progress.jsonl`（append-only）；task clean 后追加 `{taskId,status,commitSha,timestamp}`；skill start 时 `cat` 检查；compaction 后从 ledger + git log 恢复；**trust ledger over recollection** |
| 75-B3 | **三态 review + ⚠️ 上移 controller** | Superpowers reviewer 输出 ✅/❌/⚠️；⚠️ "Cannot verify from diff" 上移给 controller（因 controller 持有跨 task 上下文） | review 多为二态通过/失败 | reviewer 输出格式加 `⚠️ Cannot verify: [items]`；parent agent 收到后必须自行校验，确认 gap 则打回 implementer + re-review |
| 75-B4 | **per-task Interfaces block** | Superpowers plan 每个 task 显式 `Consumes: [签名] / Produces: [签名]`，implementer 只看自己 task，靠此 block 学邻居接口 | 任务边界仅靠 Router 分类，缺接口契约层 | plan 模板新增 `**Interfaces:**` 字段；reviewer 校验 Produces 是否被后续 task 消费 |
| 75-B5 | **Global Constraints 机械传播** | Superpowers plan 顶部 `## Global Constraints` 逐行 verbatim，复制到每个 brief 和 reviewer prompt（作 attention lens） | plan 若有全局约束可能散落各处 | plan 模板新增 `## Global Constraints` 章节；task-brief 脚本自动 prepend 该章节；reviewer prompt 包含一份（exact values/formats，非 process rules） |
| 75-B6 | **writing-plans plan 结构全盘借鉴** | Superpowers `writing-plans/SKILL.md`：Plan Header + Task Right-Sizing（fold setup into deliverable）+ Bite-Sized 5 步 TDD + No Placeholders + Self-Review 三项 + Execution Handoff | RouteDev 现有 plan 格式不规范，常有占位符 | 重写 RouteDev 的 plan 生成 Skill：采用 Superpowers 完整结构；Task Right-Sizing 禁独立 setup task；No Placeholders 校验；Self-Review 在 plan 生成后自动跑 |
| 75-B7 | **controller 硬规则落地** | Superpowers controller：Continuous execution / 禁语 / 一次 fix / 禁粘历史 / Narration 一行 | RouteDev controller 行为未规范化 | 写入 RouteDev controller prompt 模板：禁 "Should I continue?"；禁 "do not flag"/"at most Minor"；一次 fix subagent 处理所有 findings；禁粘贴前序 task summary；tool call 间最多一行旁白 |
| 75-B8 | **配置 schema 单一真相源** | tau `tcc-gen` 一份 DSL 生成 Go + TS + wasm 三端访问器 | 配置项分散（SettingsPage 5465 行 + 各模块 config.ts） | 新增 `tools/config-gen.ts`：从 `config-schema.yaml` 生成 TS 类型 + 默认值 + 设置 UI 字段描述 + 校验函数；先试点 model 配置模块 |

### 第三波：高难度、战略投资（需要架构调整，Phase 76+）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-C1 | **Turn count beats token price 模型路由** | Superpowers：便宜模型多步任务多花 2-3× 轮反更贵；reviewer 与 prose-implementer 用 mid-tier 地板；plan 含完整代码时用 cheapest | Router 分类器只按任务类型路由，不考虑轮次成本 | Router 加 "task complexity signal"：1-2 文件 + 完整 spec → cheap；多文件 + 集成 → standard；设计/广理解 → most capable；reviewer mid-tier 地板；最终 whole-branch review 必须 most capable |
| 75-C2 | **Skill 沙箱脚本扩展** | tau `poe` 引擎加载 Starlark 脚本；Superpowers 用 bash 脚本做确定性工作 | Skill 系统以纯 prompt 为主，缺可执行逻辑层 | Electron 主进程用 `isolated-vm` 跑 JS 子集；Skill 既含 prompt 又含可执行逻辑（如自动生成 review package、解析 tool result） |
| 75-C3 | **一键本地测试环境（routedev dream）** | tau `dream` 命令在进程内拉起全部服务 + fixtures；`go test -p 1` 串行 | 缺统一 e2e 环境，每次测试手动准备 mock | 新增 `npm run dream`：起 mock LLM + 临时工作区 + headless Playwright；e2e 测试串行跑（借鉴 `go test -p 1`） |
| 75-C4 | **CLAUDE.md 式贡献者规范 + skill 修改门槛** | Superpowers CLAUDE.md："94% PR rejection rate" / "skills are code" / PR 必须披露 model/harness / skill 修改需 eval 证据 | RouteDev 无 AI 贡献者规范，skill 修改无门槛 | 新增 `AGENTS.md`：规定 AI 贡献者必须披露 model/harness；Skill 修改必须附 eval 证据；"skill 是塑造 agent 行为的代码，不是散文" |
| 75-C5 | **双传输服务框架** | tau 每个服务同时暴露 P2P stream + HTTP 路由 | Electron 主/渲染进程通信耦合在 ipcMain | 抽象 `Service` 接口，既能 in-process 调用又能跨进程 IPC |

---

## 三、落地路线图

### 第一波（75-A，6 项，低难度）

**目标**：快速吸收 Superpowers "脚本算确定性" + tau 工程规范。

- **75-A1 Review Package 脚本**：`scripts/review-package.mjs`，输出 commit list + stat + `git diff -U10`，按 `<base7>..<head7>.diff` 命名（re-review 不覆盖）；BASE 禁止 `HEAD~1`
- **75-A2 task-brief 脚本**：`scripts/task-brief.mjs`，从 plan 提取 task N 全文到 `.routedev/sdd/task-N-brief.md`，跳过 fence 内伪 heading
- **75-A3 强制 dispatch model**：SubAgent 调度 API 加 `model` 必填校验；省略则 throw；`model: 'inherit'` 显式过渡
- **75-A4 Pre-flight plan review**：新增 `review-plan` subagent；执行 Task 1 前扫 plan 冲突 + No Placeholders 检查；批量上报
- **75-A5 CONTRIBUTING.md + scope commit**：issue-driven workflow + `[scope]` commit（scope: `router/agent/skill/ui/setting/cli/infra/docs`）；e2e 串行
- **75-A6 Pre-commit hook**：`.husky/pre-commit` + `lint-staged` + `commitlint.config.js`

### 第二波（75-B，8 项，中难度）

**目标**：深化上下文流动优化，plan 结构全盘借鉴，controller 行为规范化。

- **75-B1 File Handoff**：subagent 间传递数据落文件；brief→report 命名约定；parent 只收 <15 行 summary
- **75-B2 Durable Progress Ledger**：`.routedev/progress.jsonl` append-only；**trust ledger over recollection**；compaction 后从 ledger + git log 恢复
- **75-B3 三态 review**：reviewer 输出 ✅/❌/⚠️；⚠️ 上移 controller 校验
- **75-B4 per-task Interfaces block**：plan 模板加 `Consumes/Produces` 精确签名
- **75-B5 Global Constraints 机械传播**：plan 顶部加章节；task-brief 脚本自动 prepend；reviewer prompt 包含一份
- **75-B6 writing-plans plan 结构全盘借鉴**：重写 plan 生成 Skill——Plan Header + Task Right-Sizing（fold setup into deliverable，禁独立 setup task）+ Bite-Sized 5 步 TDD + No Placeholders（禁 TBD/add error handling/similar to Task N）+ Self-Review（spec coverage/placeholder scan/type consistency）+ Execution Handoff（subagent-driven vs inline 二选一）
- **75-B7 controller 硬规则**：写入 controller prompt 模板——Continuous execution（禁 "Should I continue?"）+ 禁语（"do not flag"/"at most Minor"/"the plan chose"）+ 一次 fix subagent 处理所有 findings + 禁粘前序 task summary（42k chars 教训）+ Narration 一行
- **75-B8 配置 schema 单一真相源**：`tools/config-gen.ts` + `config-schema.yaml`；先试点 model 配置

### 第三波（75-C，5 项，高难度，Phase 76+）

**目标**：战略投资，为长期演化打基础。

- 75-C1 Turn count beats token price 模型路由（加 complexity signal + reviewer mid-tier 地板）
- 75-C2 Skill 沙箱脚本扩展（isolated-vm）
- 75-C3 一键本地测试环境（`npm run dream` + 串行 e2e）
- 75-C4 CLAUDE.md 式贡献者规范 + skill 修改门槛（"skills are code"）
- 75-C5 双传输服务框架（Service 接口抽象）

---

## 四、与现有 Phase 的关系

| Phase | 关系 |
|-------|------|
| **Phase 70（上下文压缩）** | 75-B1 File Handoff 是压缩的延伸——从"压缩内联"升级到"内容外置到文件" |
| **Phase 71（上下文工程增强）** | 75-B2 Durable Progress Ledger 与 71 状态外部化方向一致；**"re-dispatched entire completed task sequences" 是 71 要防的失败** |
| **Phase 73（Pi 借鉴：消息抽象层）** | 75-B3 三态 review 复用 73 AgentMessage 抽象（自定义消息类型承载 ⚠️） |
| **Phase 74（前端交互优化）** | 75-A1 Review Package 文件可在 74-F1 ArtifactPanel "产物" tab 展示 |
| **Phase 61（ACRouter 闭环模型路由）** | 75-A3 强制 model 是 61 的硬化；75-C1 complexity signal 是 61 的深化 |
| **Phase 51（外部开源借鉴落地）** | 75 是 51 的延续，聚焦"工程实践"与"上下文流动" |
| **Phase 16（Prompt 模板系统）** | 75-B7 controller 硬规则落地到 prompt 模板系统 |

---

## 五、范围外（记录备忘）

| 项目 | 说明 | 计划处理 |
|------|------|----------|
| tau 的 libp2p / IPFS / wazero / Raft | Electron 场景用不上 | 不借鉴，仅借鉴工程哲学 |
| Superpowers 多 harness 适配层 | RouteDev 是独立产品 | 不借鉴 |
| Superpowers TDD 强制流程 | RouteDev 已有工具调用流程 | 作为 plan 模板可选项，不强制 |
| Superpowers "your human partner" 用词 | 那是 superpowers 项目 voice | 不照搬，但借鉴"刻意用词不随意替换"原则 |
| 75-C 波全部 5 项 | 需架构调整 | Phase 76+ 按需启动 |

---

## 六、风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 75-A1 `.routedev/review/` 被 gitignore | `.routedev/` 加入 .gitignore 但保留 `.routedev/.gitkeep`；settings 加"是否提交 review 文件"开关 |
| 75-A3 强制 model 破坏现有 subagent 调用 | 先加 console.warn 跑一周，再改 throw；`model: 'inherit'` 显式过渡 |
| 75-B1 File Handoff 改变通信契约 | 新增 handoff mode 配置，默认 `inline`（兼容），可切 `file`；逐步迁移 |
| 75-B6 plan 结构重构破坏现有 plan | 新旧 plan 格式并存；旧格式加 deprecation warning；新 plan 生成器默认用新格式 |
| 75-B7 controller 硬规则过于严格 | 规则写入 prompt 但提供 override 机制（`--relaxed` 模式）；先在非关键路径试跑 |
| 75-B8 配置 schema 生成器迁移风险 | 先试点单一模块（model 配置），生成器输出与手写 diff 零差异后再推广 |

---

## 七、成功度量表

| 指标 | 现状 | Phase 75 目标 |
|------|------|---------------|
| subagent 间 handoff 平均 token 数 | 未测量（全内联） | 第一波后降低 ≥40% |
| reviewer subagent 重复跑 git 命令次数 | 每次 review 都跑 | 第一波后降为 0 |
| dispatch 时省略 model 的比例 | 未测量 | 第一波后降为 0 |
| dispatch prompt 平均 chars | 未测量（可能含大量粘贴历史） | 第二波后 ≤2k chars（禁粘前序 summary） |
| 长任务 compaction 后重跑已完成 task 的比例 | 未测量 | 第二波后降为 0（Durable Ledger） |
| plan 含占位符的比例 | 未测量 | 第二波后降为 0（No Placeholders 校验） |
| 配置项类型/默认值重复维护点数 | 未测量 | 第二波后试点模块降为 0 |
| commit message 不符合规范的 PR 比例 | 未测量 | 第一波后降为 0 |
| 一行命令拉起完整测试环境 | 否 | 第三波后是（`npm run dream`） |

---

## 八、执行优先级与依赖关系

```
第一波（75-A，6 项，低难度）
├── 75-A1 Review Package 脚本 ──┐
├── 75-A2 task-brief 脚本 ──────┤ 三项可并行（脚本工具链）
├── 75-A3 强制 dispatch model ──┘
├── 75-A4 Pre-flight plan review（依赖 75-A2 task-brief）
├── 75-A5 CONTRIBUTING + scope commit ── 独立
└── 75-A6 Pre-commit hook ───────────── 独立
        ↓
第二波（75-B，8 项，中难度）
├── 75-B1 File Handoff（依赖 75-A1/A2 文件路径约定）
├── 75-B2 Durable Progress Ledger（独立）
├── 75-B3 三态 review（依赖 75-A1 reviewer prompt 改造）
├── 75-B4 per-task Interfaces（依赖 plan 模板改造）
├── 75-B5 Global Constraints（依赖 75-B4）
├── 75-B6 writing-plans plan 结构全盘借鉴（独立，但影响 75-B4/B5）
├── 75-B7 controller 硬规则（独立，写入 prompt 模板）
└── 75-B8 配置 schema 生成器（独立）
        ↓
第三波（75-C，5 项，高难度，Phase 76+）
```

**推荐执行顺序**：
1. **75-A1 + 75-A2 + 75-A3**（三并行：review-package + task-brief + 强制 model）— Superpowers v6 脚本化核心
2. **75-A4 + 75-A5 + 75-A6**（三并行：pre-flight review + CONTRIBUTING + pre-commit）— tau 工程规范 + plan 校验
3. **75-B6 + 75-B7**（并行：plan 结构重构 + controller 硬规则）— 这是本次调研最大发现，plan 与 controller 行为规范化
4. **75-B1 + 75-B2 + 75-B3**（并行：File Handoff + Ledger + 三态 review）— 与上下文压缩协同
5. **75-B4 + 75-B5**（串行：Interfaces + Constraints）— 依赖 75-B6 plan 模板
6. **75-B8**（独立：配置 schema 生成器）— 试点后推广
7. **75-C 全波**（Phase 76+）— 战略投资

**每步前置条件检查**：

| 步骤 | 前置条件 | 验证方式 |
|------|----------|----------|
| 75-A1 | simple-git 已集成 | `node scripts/review-package.mjs HEAD~1 HEAD` 输出 diff 文件 |
| 75-A2 | plan 文件格式已定义 | `node scripts/task-brief.mjs plan.md 1` 输出 brief 文件 |
| 75-A3 | SubAgent 调度 API 已存在 | 单测验证省略 model 时抛错 |
| 75-A4 | 75-A2 已落地 | review-plan subagent 可读 brief 文件 |
| 75-B1 | 75-A1/A2 文件路径约定已落地 | subagent 间 handoff 文件可读写 |
| 75-B6 | 现有 plan 生成 Skill 已梳理 | 新 plan 模板覆盖所有现有字段 |

---

## 九、核心一句话

**Phase 75 的使命是把"上下文流动"作为一等公民对待**——脚本算确定性、文件替代粘贴、模型按形态分层、plan 结构规范化、controller 行为约束化、技术债诚实标注。tau 给 RouteDev 的是基础工程范式（issue-driven + scope commit + 串行测试 + 测试床），Superpowers v6 给 RouteDev 的是 Agent 协作方法论（review package 预生成 + file handoff + durable ledger + controller 硬规则 + writing-plans 结构）。两者结合让 RouteDev 从"能用的 AI 编程助手"升级为"上下文高效的 AI 编程助手"——**核心不是换更便宜的模型，而是让 Agent 少看废话、把昂贵的上下文预算留给真正需要判断的地方**。
