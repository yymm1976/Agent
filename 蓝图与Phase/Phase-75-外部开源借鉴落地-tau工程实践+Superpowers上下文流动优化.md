# Phase 75：外部开源借鉴落地——tau 工程实践 + Superpowers v6 上下文流动优化

> **输入**：tau (taubyte/tau) 源码调研 × Superpowers v6 (obra/superpowers) 源码调研 + 用户提供的 v6 核心分析
>
> **日期**：2026-07-07
>
> **目标**：将两个开源项目的工程智慧落地为 RouteDev 的实际能力增强——tau 提供工程组织与配置管理范式，Superpowers v6 提供 Agent 上下文流动与模型分层方法论
>
> **核心命题**：AI 编程贵不全是模型贵，更多是 Agent 反复读同一批上下文、重复跑确定性命令造成的浪费。Phase 75 把"确定性工作交给脚本、把昂贵上下文留给判断"作为指导思想，落到 RouteDev 的多 Agent 协作、配置系统、Skill 框架与可观测性上。

---

## 一、调研发现（精简版）

### 1.1 tau（Taubyte）核心启发

tau 是一个分布式 PaaS / Serverless 云平台（Go 91%），核心承诺 "Prompt → Local → Prod"。技术栈含 libp2p / IPFS-lite / wazero（纯 Go wasm runtime）/ Raft + CRDT 混合一致性。

**三个工程哲学值得 RouteDev 借鉴**：

1. **"单 DSL 多产物"思想**——配置 schema 只写一次，编译器同时生成 Go 服务端访问器、TypeScript 客户端类型、wasm 模块。`tcc-gen` 走一遍 DSL walk 同时产出三端代码，消除"配置散落多处维护"。
2. **"诚实标注技术债"文化**——commit message 把 known race、迁移代码、移除日期全部写清楚。已知 race 显式文档化并标注 "deferred to raft phase"；EXDEV fallback 代码标注 "flagged for removal in early 2027"。
3. **"local-first 测试床"投入**——`dream` 命令一行拉起整个本地云（含全部服务），既做演示也做 e2e 测试床。所有贡献者一行命令复现完整环境。

### 1.2 Superpowers v6 核心启发

v6 通过三项改造在作者 eval 里实现约 50% 速度提升、约 60% token 下降（官方口径更收敛）。**核心不是换更便宜的模型，而是优化上下文流动，让 Agent 少看废话**。

**三刀核心改造**：

| 改造 | 旧做法 | v6 新做法 | 单项收益 |
|------|--------|----------|----------|
| Reviewer handoff | reviewer 自己跑 git | 脚本预生成 review package（commit list + stat + diff -U10），reviewer 一次 Read | ~10% |
| Reviewer 合并 | spec compliance + code quality 两个 reviewer | 合并为一个，同轮给两个 verdict；新增 "Cannot verify from diff" 状态 | 减少一轮往返 |
| 模型分层 | 默认继承 session 最贵模型 | dispatch 时强制写明 `model: [REQUIRED]`；机械执行用便宜模型，判断用强模型 | 避免静默回退 |

**失败的反向实验（很有参考价值）**：
- 限制 controller 思考预算：turn 数从 92 涨到 138，省的思考 token 被修复轮次吃回
- 压缩 plan 词数：测试信号掉 62%，被砍的正是测试、接口、任务结构
- 用 Sonnet 写 plan：任务数从 5.8 坍缩到 3.6，review 颗粒度没了

**带走的三条**：
1. 脚本能算的（commit、diff、task brief）就别让 LLM 临场探索
2. plan 不能只追短，测试、接口、任务边界、全局约束不能砍
3. 模型路由看任务形态，便宜模型多绕几轮可能更贵（"Turn count beats token price"）

---

## 二、综合借鉴点清单（按落地优先级排序）

### 第一波：低成本、立竿见影（低难度）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-A1 | **Review Package 预生成** | Superpowers `review-package BASE HEAD` 脚本 | 多 Agent 在 prompt 里粘贴 diff，占用主上下文，reviewer 重复读 | 新增 `scripts/review-package.mjs`，把 commit list + stat + diff(-U10) 写入 `.routedev/review/<base>..<head>.diff`；reviewer subagent 一次 Read 该文件，禁止重跑 git |
| 75-A2 | **强制 dispatch model 字段** | Superpowers dispatch 模板 `model: [REQUIRED]` | Router 层有分类器路由，但 dispatch 时未必强制写明，存在静默回退默认（最贵）模型风险 | 在 SubAgent 调度 API 加 `model` 必填校验；prompt 模板里加 `[MODEL — REQUIRED]` 占位符；省略则报错而非继承 |
| 75-A3 | **Pre-flight plan review** | Superpowers `subagent-driven-development` 在 dispatch Task 1 前扫一次 plan 内部冲突 | plan 生成后直接执行，缺 pre-flight 校验环节 | 新增 `review-plan` subagent 类型，在执行第一个 task 前对 plan 做内部一致性扫描（任务依赖闭环、接口签名匹配、测试覆盖声明），冲突 batched 上报用户 |
| 75-A4 | **诚实技术债标注规范** | tau commit message 显式写 "deferred to raft phase" / "removal in early 2027" | 技术债以 TODO 散落，无统一追踪 | 在 `CONTRIBUTING.md`（新增）规定：技术债 commit 必须含 `[TECH-DEBT]` tag + 移除/修复条件 + 关联 issue 号；CI 校验 commit message 格式 |
| 75-A5 | **Pre-commit hook + commit 规范** | tau `.pre-commit-config.yaml`（fmt/imports/yaml/大文件检查）+ `[scope] message` 格式 | 仅有 ESLint/Prettier，缺 commit 规范与 pre-commit 自动化 | 新增 `.husky/pre-commit` 跑 lint-staged（eslint --fix + prettier --write）；新增 `commitlint.config.js` 强制 Conventional Commits；commit message 校验 `[scope]` 可选前缀 |

### 第二波：中难度、长期价值（与上下文压缩方向一致）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-B1 | **File Handoff 替代 paste** | Superpowers task-brief / report / review-package 三类 artifact 全落文件 | Phase-70/71/74 刚做完上下文压缩，但 subagent 间 handoff 仍以 prompt 内联为主 | subagent 间传递的数据（plan 片段、tool result 摘要、review report）落 `.routedev/sdd/<task-id>/` 文件，subagent 只回 <15 行 summary 给 parent |
| 75-B2 | **Durable Progress Ledger** | Superpowers `.superpowers/sdd/progress.md` 记录已完成 task | Electron 进程内状态易丢失，长任务压缩后定位困难 | 新增 `.routedev/progress.jsonl`（append-only），每个 task 完成时追加 `{taskId, status, commitSha, timestamp}`；compaction 后从 ledger + git log 恢复进度，避免重跑已完成 task |
| 75-B3 | **"Cannot verify from diff" 三态 review** | Superpowers reviewer 输出 ✅/❌/⚠️，⚠️ 上移给 controller 跨 task 校验 | review 多为二态通过/失败，跨任务一致性缺专门通道 | reviewer subagent 输出格式加 `⚠️ Cannot verify: [items]`；parent agent 收到后必须自行校验 ⚠️ 项（因 parent 持有跨 task 上下文），不能放行 |
| 75-B4 | **per-task Interfaces block** | Superpowers plan 每个 task 显式 Consumes/Produces 精确签名 | 任务边界若仅靠 Router 分类，缺乏"接口契约"层 | plan 模板新增 `**Interfaces:** Consumes: [签名] / Produces: [签名]` 字段；reviewer 校验 Produces 是否被后续 task 消费 |
| 75-B5 | **Global Constraints block 机械传播** | Superpowers plan 顶部逐条 verbatim 硬约束，复制到每个 brief 和 reviewer | plan 若有全局约束可能散落各处，未做机械复制 | plan 模板新增 `## Global Constraints` 章节；task-brief 脚本自动把该章节内容 prepend 到每个 task brief；reviewer prompt 也包含一份 |
| 75-B6 | **配置 schema 单一真相源** | tau `tcc-gen` 一份 DSL 生成 Go + TS + wasm 三端访问器 | 配置项分散在多处（SettingsPage 5465 行 + 各模块 config.ts），类型与默认值重复维护 | 新增 `tools/config-gen.ts`，从一份 `config-schema.yaml` 生成：①TS 类型定义 ②默认值常量 ③设置 UI 字段描述 ④校验函数。一份 schema 四端产物，消除"配置散落" |

### 第三波：高难度、战略投资（需要架构调整）

| # | 借鉴点 | 来源 | RouteDev 现状 | 落地动作 |
|---|--------|------|---------------|----------|
| 75-C1 | **Turn count beats token price 模型路由** | Superpowers 反直觉发现：便宜模型多步任务多花 2-3× 轮反更贵 | Router 分类器若只按"任务类型"路由不考虑"轮次成本"，可能踩同样坑 | Router 加 "task complexity signal" 维度：1-2 文件 + 完整 spec → cheap；多文件 + 集成 → standard；设计/广 codebase 理解 → most capable；reviewer 与 prose-implementer 用 mid-tier 作地板 |
| 75-C2 | **Skill 沙箱脚本扩展** | tau `poe` 引擎加载 Starlark 脚本作为 DNS 插件 | Skill 系统以纯 prompt 为主，缺少可执行逻辑层 | 在 Electron 主进程用 `isolated-vm` 或 `quickjs-emscripten` 跑 JS 子集，让 Skill 既含 prompt 又含可执行逻辑（如自动生成 review package、解析 tool result） |
| 75-C3 | **一键本地测试环境（routedev dream）** | tau `dream` 命令在进程内拉起全部服务 + fixtures | 缺少统一 e2e 环境，每次测试需手动准备 mock LLM/项目 | 新增 `npm run dream` 子命令：起 mock LLM（固定响应）+ 临时工作区 + headless Playwright 验证；所有 e2e 测试基于 dream 环境 |
| 75-C4 | **双传输服务框架** | tau 每个服务同时暴露 P2P stream + HTTP 路由，客户端透明选择 | Electron 主/渲染进程通信耦合在 ipcMain 上 | 抽象 `Service` 接口，让模块既能 in-process 调用又能跨进程 IPC；为未来拆 worker 进程 / 多窗口留余地 |

---

## 三、落地路线图

### 第一波（75-A，5 项，低难度）

**目标**：快速吸收 Superpowers 的"脚本算确定性"与 tau 的"工程规范"。

- **75-A1 Review Package 预生成**：新增 `scripts/review-package.mjs`（Node ESM 脚本，调用 simple-git），输出到 `.routedev/review/<base7>..<head7>.diff`；修改 reviewer subagent prompt 模板，加 `[DIFF_FILE]` 占位符并禁止重跑 git
- **75-A2 强制 dispatch model 字段**：在 `src/agent/sub-agent-dispatcher.ts`（或等价文件）加 `model` 必填校验；prompt 模板占位符从可选改必填；CI 加单测验证省略 model 时抛错
- **75-A3 Pre-flight plan review**：新增 `review-plan` subagent 类型；在 controller 执行第一个 task 前插入一次 plan review 调用；冲突 batched 上报用户而非逐条阻塞
- **75-A4 诚实技术债标注规范**：新增 `CONTRIBUTING.md`；规定 commit message 格式 `[scope] description` + `[TECH-DEBT]` tag；CI 用 commitlint 校验
- **75-A5 Pre-commit hook + commit 规范**：`.husky/pre-commit` + `commitlint.config.js` + `lint-staged` 配置

### 第二波（75-B，6 项，中难度）

**目标**：深化上下文流动优化，与 Phase-70/71/74 的压缩方向协同。

- **75-B1 File Handoff**：subagent 间传递数据落 `.routedev/sdd/<task-id>/` 文件；parent agent 只收 summary
- **75-B2 Durable Progress Ledger**：`.routedev/progress.jsonl` append-only；compaction 后从 ledger 恢复
- **75-B3 三态 review**：reviewer 输出格式扩展；parent agent 处理 ⚠️ 项
- **75-B4 per-task Interfaces block**：`writing-plans` Skill 模板新增字段；reviewer 校验接口契约
- **75-B5 Global Constraints 机械传播**：plan 模板新增章节；task-brief 脚本自动 prepend
- **75-B6 配置 schema 单一真相源**：`tools/config-gen.ts` + `config-schema.yaml`；先试点一个模块（如 model 配置），验证后再推广

### 第三波（75-C，4 项，高难度）

**目标**：战略投资，为 RouteDev 长期演化打基础。本波可在 Phase 76+ 启动，Phase 75 仅记录决策。

- 75-C1 模型路由复杂度信号
- 75-C2 Skill 沙箱脚本扩展
- 75-C3 一键本地测试环境（routedev dream）
- 75-C4 双传输服务框架

---

## 四、与现有 Phase 的关系

| Phase | 关系 |
|-------|------|
| **Phase 70（上下文压缩）** | 75-B1 File Handoff 是压缩的延伸——从"压缩内联内容"升级到"内容外置到文件" |
| **Phase 71（上下文工程增强）** | 75-B2 Durable Progress Ledger 与 71 的状态外部化方向一致 |
| **Phase 73（Pi 借鉴：消息抽象层）** | 75-B3 三态 review 复用 73 的 AgentMessage 抽象（自定义消息类型承载 ⚠️ 状态） |
| **Phase 74（前端交互优化）** | 75-A1 Review Package 文件路径可在 74-F1 ArtifactPanel 的"产物"tab 展示，让用户看到 review 文件 |
| **Phase 61（ACRouter 闭环模型路由）** | 75-A2 强制 model 字段是 61 的硬化——从"路由器选模型"升级到"dispatch 时强制写明且禁止继承" |
| **Phase 51（外部开源借鉴落地）** | 75 是 51 的延续，但聚焦"工程实践"与"上下文流动"而非具体功能 |

---

## 五、范围外（记录备忘）

| 项目 | 说明 | 计划处理 |
|------|------|----------|
| tau 的 libp2p / IPFS / wazero 技术栈 | Electron 场景用不上，纯 Go 实现 | 不借鉴，仅借鉴工程哲学 |
| tau 的 Raft 共识 | RouteDev 单机应用无需分布式共识 | 不借鉴 |
| Superpowers 的多 harness 适配层 | RouteDev 是独立产品，不嵌入其他 harness | 不借鉴 |
| Superpowers 的 TDD 强制流程 | RouteDev 已有自己的工具调用与执行流程 | 不强制，仅作为 Skill 模板的可选项 |
| 75-C 波全部 4 项 | 需要架构调整，Phase 75 范围外 | Phase 76+ 按需启动 |

---

## 六、风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 75-A1 Review Package 文件路径 `.routedev/review/` 被忽略 | 在 `.gitignore` 加 `.routedev/` 但保留 `.routedev/.gitkeep`；或在 settings 里加"是否提交 review 文件"开关 |
| 75-A2 强制 model 字段破坏现有 subagent 调用 | 先加 warning（console.warn）跑一周观察，再改为 throw；保留 `model: 'inherit'` 显式值作为过渡 |
| 75-B1 File Handoff 改变 subagent 通信契约 | 新增 handoff mode 配置项，默认 `inline`（兼容），可切 `file`（新行为）；逐步迁移 |
| 75-B6 配置 schema 生成器迁移风险 | 先试点单一模块（model 配置），生成器输出与手写代码 diff 对比零差异后再推广；保留手写代码作 fallback 一周 |
| 75-C2 Skill 沙箱脚本性能 | isolated-vm 启动有开销，仅对"需要可执行逻辑"的 Skill 启用；纯 prompt Skill 保持现状 |

---

## 七、成功度量表

| 指标 | 现状 | Phase 75 目标 |
|------|------|---------------|
| subagent 间 handoff 平均 token 数 | 未测量（全内联） | 第一波后降低 ≥40%（File Handoff 落地后） |
| reviewer subagent 重复跑 git 命令次数 | 每次 review 都跑 | 第一波后降为 0（脚本预生成） |
| dispatch 时省略 model 的比例 | 未测量 | 第一波后降为 0（强制必填） |
| 长任务 compaction 后重跑已完成 task 的比例 | 未测量 | 第二波后降为 0（Durable Ledger） |
| 配置项类型/默认值重复维护点数 | 未测量 | 第二波后试点模块降为 0（config-gen） |
| commit message 不符合规范的 PR 比例 | 未测量 | 第一波后降为 0（commitlint + husky） |
| 一行命令拉起完整测试环境 | 否（需手动准备 mock） | 第三波后是（`npm run dream`） |

---

## 八、执行优先级与依赖关系

```
第一波（75-A，5 项，低难度，可并行）
├── 75-A1 Review Package 预生成 ─┐
├── 75-A2 强制 dispatch model    │ 三项可并行
├── 75-A3 Pre-flight plan review ┘
├── 75-A4 诚实技术债标注规范 ─── 独立
└── 75-A5 Pre-commit hook ────── 独立
        ↓
第二波（75-B，6 项，中难度）
├── 75-B1 File Handoff（依赖 75-A1 文件路径约定）
├── 75-B2 Durable Progress Ledger（独立）
├── 75-B3 三态 review（依赖 75-A1 reviewer prompt 改造）
├── 75-B4 per-task Interfaces（依赖 writing-plans Skill 改造）
├── 75-B5 Global Constraints（依赖 75-B4）
└── 75-B6 配置 schema 生成器（独立）
        ↓
第三波（75-C，4 项，高难度，Phase 76+ 按需启动）
```

**推荐执行顺序**：
1. **75-A1 + 75-A2 + 75-A3**（三并行：reviewer handoff + 模型强制 + plan pre-flight）— 最高 ROI，直接吸收 Superpowers v6 三刀核心
2. **75-A4 + 75-A5**（并行：技术债规范 + pre-commit）— tau 工程规范落地
3. **75-B1 + 75-B2 + 75-B3**（并行：File Handoff + Ledger + 三态 review）— 与上下文压缩方向协同
4. **75-B4 + 75-B5**（串行：Interfaces + Constraints）— plan 结构改造
5. **75-B6**（独立：配置 schema 生成器）— 试点后推广
6. **75-C 全波**（Phase 76+）— 战略投资

**每步前置条件检查**：

| 步骤 | 前置条件 | 验证方式 |
|------|----------|----------|
| 75-A1 | simple-git 已集成（Phase 51 引入） | `node scripts/review-package.mjs HEAD~1 HEAD` 输出 diff 文件 |
| 75-A2 | SubAgent 调度 API 已存在 | 单测验证省略 model 时抛错 |
| 75-A3 | plan 生成 Skill 已存在 | review-plan subagent 可被调度 |
| 75-B1 | 75-A1 文件路径约定已落地 | subagent 间 handoff 文件可读写 |
| 75-B6 | 配置项清单已梳理 | config-schema.yaml 覆盖所有配置项 |

---

## 九、核心一句话

**Phase 75 的使命是把"上下文流动"作为一等公民对待**——脚本算确定性、文件替代粘贴、模型按形态分层、技术债诚实标注。这不是换更便宜的模型，而是让 Agent 少看废话、把昂贵的上下文预算留给真正需要判断的地方。tau 给 RouteDev 的是工程组织范式，Superpowers v6 给 RouteDev 的是 Agent 协作方法论，两者结合让 RouteDev 从"能用的 AI 编程助手"升级为"上下文高效的 AI 编程助手"。
