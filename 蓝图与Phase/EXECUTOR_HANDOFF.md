# RouteDev — 执行人交接文档

> **最后更新：** 2026-06-17
> **适用对象：** 新执行人（Trae Work + GLM 5.2）
> **前任执行人：** Opencode Go + PilotDeck（已停止使用）
> **仓库地址：** https://github.com/yymm1976/Agent （main 分支，最新 commit: bc2f0ee）

---

## 一、角色分工

| 角色 | 谁 | 职责 |
|------|-----|------|
| **架构师** | 用户（通过 QoderWork） | 写蓝图（BLUEPRINT.md）和 Phase prompt 文件，裁决 CONCERN，不写代码 |
| **执行人** | 你（AI 编码助手） | 读 Phase 文件 → 编码实现 → 跑测试 → 提交 → 写完成报告 |

**核心原则：** 架构师的 Phase 文件是"施工图纸"，你是"施工队"。图纸可能有错，发现后报告 CONCERN，不要自己改图纸。

---

## 二、项目简介

RouteDev 是一个 **TypeScript / Node.js CLI 开发助手**，核心功能是"按任务复杂度自动路由 AI 模型"。技术栈：

- **语言：** TypeScript 6.x，Node.js 20+
- **CLI 框架：** Ink 7.0.6（React 19.2.7 渲染 CLI 界面）
- **测试：** Vitest
- **包管理：** pnpm
- **构建：** tsup

**代码仓库结构：**
```
routedev/
├── src/
│   ├── index.tsx          ← CLI 入口（注意：不是 bin/ 目录）
│   ├── cli/
│   │   ├── App.tsx        ← 主界面组件（当前 1548 行，Phase 17b 目标 ≤ 400 行）
│   │   ├── command-registry.ts  ← 命令注册表
│   │   ├── service-context.ts   ← 服务上下文（22 字段接口）
│   │   ├── components/    ← Ink 组件（StatusBar, InputBox, ChatView）
│   │   └── commands/      ← 独立命令文件（Phase 17b 创建）
│   ├── agent/             ← Agent Loop、分支对话、记忆、视觉
│   ├── router/            ← 分类器、路由器、Token 追踪
│   ├── tools/             ← 工具注册、执行、安全、MCP
│   ├── channels/          ← IM 通道（企业微信、Telegram）
│   ├── harness/           ← 检查点、Trace、审计
│   ├── config/            ← 配置加载
│   └── utils/             ← 日志、路径、重试
├── tests/                 ← 测试文件
├── package.json           ← 版本 0.4.0（代码中打印 0.14.0，Phase 23 修复）
└── vitest.config.ts
```

---

## 三、Phase 执行协议

### 3.1 执行流程

```
读 Phase 文件 → 逐 Task 实现 → 每 Task 提交一次 → 跑全量测试 → 写完成报告 → 报告 CONCERN（如果有）
```

### 3.2 Phase 文件位置

所有 Phase 文件在：`蓝图与Phase/` 目录下，命名规则 `Phase-XX-主题.md`

### 3.3 执行顺序（当前待执行）

| 顺序 | Phase | 状态 | 说明 |
|------|-------|------|------|
| **1** | Phase 17b — 返工修复 | **未开始** | 收束 Phase 17/18/19 遗留债务，11 个 Task |
| **2** | Phase 20 — 工作模式与步骤编辑器 | **未开始** | 5 个 Task |
| **3** | Phase 21 — Agent Guardrails 增强 | **未开始** | 5 个 Task |
| **4** | Phase 22 — Plugin 系统 | **未开始** | 5 个 Task |
| **5** | Phase 23 — 高级 UX 与收尾打磨 | **未开始** | 6 个 Task，最后一步打 v1.0 tag |

**重要：Phase 17b 必须先执行。** 它是后续所有 Phase 的基础——清理了 App.tsx 债务、建立了 CommandBridge、修复了安全漏洞。跳过 17b 直接做后面的 Phase 会导致接口冲突。

### 3.4 每个 Task 的完成标准

1. 代码写完
2. 对应测试通过
3. `pnpm vitest run` 全量测试不回归
4. `git commit` 提交（commit message 格式：`feat(scope): 简短描述`）

### 3.5 完成报告格式

**每个 Phase 完成后，必须在项目根目录创建/更新 `EXECUTION_REPORTS.md` 文件**，追加该 Phase 的报告：

```markdown
## Phase XX — [Phase 名称] 执行报告

**执行人：** [AI 模型名称]
**完成时间：** [日期]
**Commit：** [commit hash]

### 交付清单

| Task | 描述 | 新增/修改文件 | 测试 | 状态 |
|------|------|--------------|------|------|
| Task 1 | ... | ... | ... | PASS/FAIL |

### CONCERN（如有）

- **CONCERN-XX-01：** [描述问题、影响范围、建议方案]

### 已知遗留

- [如果有未完成项，列出原因]
```

### 3.6 CONCERN 上报规则

遇到以下情况必须上报 CONCERN（写入完成报告）：

- Phase 文件中引用的接口签名与实际代码不符
- Phase 文件要求的功能与 BLUEPRINT.md 矛盾
- 发现需要修改 Phase 文件才能继续
- 不确定的架构决策

**不要自己修改 Phase 文件。** 上报 CONCERN 后等架构师裁决。

---

## 四、关键接口约定（高频踩坑点）

这些是前任执行人犯过的错误，新执行人必须注意：

### 4.1 接口签名（已验证，不要猜）

| 接口 | 正确签名 | 常见错误 |
|------|---------|---------|
| `ModelRouter.route()` | 接受 `ClassificationResult` | ~~接受 `ScenarioTier`~~ |
| `LLMClientManager.listAll()` | 返回 `Map<string, ILLMClient>` | ~~返回数组~~ |
| `TokenTracker.getStats()` | 返回 `TokenStats { total, byModel, byAgent, byStep }` | ~~`getTodayUsage()`~~ |
| `loadConfig()` | 参数 `{ projectPath?, globalConfigPath? }` | ~~接受单个 `configPath` 字符串~~ |
| `CheckpointManager.create()` | 参数 `{ description?, stepId?, goalId?, isAutoCreated? }` | ~~参数有 `tag` 字段~~ |
| `Checkpoint` 类型 | 字段 `description` + `timestamp` | ~~`tag` + `createdAt`~~ |
| `CheckpointManager.list()` | 返回 `Checkpoint[]` | ~~有 `findById()` 方法~~ |
| `DreamConsolidator.consolidate()` | 需要传 `CheckpointData` 参数 | ~~无参数调用~~ |
| `BranchManager.switchBranch()` | 方法名 `switchBranch` | ~~`switchToBranch`~~ |
| `ContextManager.getCheckpoint()` | 返回 `CheckpointData \| null` | — |
| `StatusBar` props | 6 个字段 | — |

### 4.2 架构原则

1. **CLI 入口是 `src/index.tsx`**，不是 `bin/routedev.ts`
2. **Loop 不做路由**：路由在 CLI 层预计算，Loop 只接收结果
3. **Loop 不依赖工具实现**：通过 `ToolExecutorAdapter` 接口解耦
4. **命令文件不直接操作 React state**：通过 `ServiceContext.commandBridge` 桥接
5. **App.tsx 瘦身目标 ≤ 400 行**：逻辑全部搬到独立命令文件

### 4.3 项目约定

- 测试框架：Vitest（`pnpm vitest run`）
- 构建工具：tsup
- 包管理：pnpm（不用 npm/yarn）
- commit 格式：`feat(scope): ...` / `fix(scope): ...` / `test(scope): ...`
- 版本号：package.json 当前 0.4.0（Phase 23 修复对齐）

---

## 五、已知代码债务（Phase 17b 修复）

以下是前任执行人留下的已知问题，全部在 Phase 17b 中修复。**如果你在 17b 之前遇到这些，不要自己修，按顺序执行 17b：**

1. **App.tsx 1548 行**：switch 块 580 行未删除，与 CommandRegistry 新旧并存
2. **WebhookServer 无安全**：无 rate limit、无 Bearer auth、无 body size 限制
3. **企业微信适配器安全漏洞**：timing-unsafe `===` 比较、credential-in-URL
4. **vision.ts 路径遍历**：`loadImage()` 无路径边界检查
5. **branch.ts 状态不一致**：`append()` 每次删除重建 BranchInfo
6. **/cost 命令不存在**：TokenTracker 有数据但无展示命令
7. **/history 命令不存在**：对话历史无查看功能
8. **中文 token 估算不准**：`Math.ceil(text.length / 4)` 对中文严重低估
9. **console.log 残留**：App.tsx 第 1246 行有调试日志
10. **Phase 18 部分交付**：retry.ts、watcher.ts、args.ts、completion.ts 存在但未集成

---

## 六、可借鉴的外部模式

Phase 17b 和 Phase 21 引入了两个外部项目的架构模式，执行时需要理解其设计意图：

### 来自 AgentScope 2.0 的模式

- **五阶段中间件管线**（Phase 17b Task 8）：preprocess → plan → execute → observe → postprocess
- **结构化 ToolResponse**（Phase 17b Task 9）：工具永远不崩溃，返回标准 `{ success, data, error }` 格式
- **三层权限引擎**（Phase 21 Task 1）：全局白名单 → 项目规则 → 运行时确认

### 来自 architect-loop 的模式

- **卡死检测**（Phase 17b Task 10）：通过日志活跃度判断子进程是否还在工作
- **交接文件**（Phase 17b Task 11）：结构化的跨会话记忆（HANDOFF.md）
- **对抗性验证**（Phase 21 Task 4）：用一个 Agent 专门挑另一个 Agent 的错

---

## 七、与架构师的沟通协议

1. **Phase 分发**：架构师写 Phase .md 文件 → 你读文件 → 执行
2. **批量分发**：架构师可能一次给多个 Phase，你按顺序逐个执行
3. **CONCERN 裁决**：你上报 CONCERN → 架构师回复 → 你按裁决继续
4. **报告存档**：所有完成报告必须写入 `EXECUTION_REPORTS.md` 文件，不能只口头报告

---

## 八、环境要求

- Node.js 20+
- pnpm
- Git（需要能 push 到 github.com/yymm1976/Agent）
- TypeScript 6.x（项目 tsconfig 已配置）

首次启动：
```bash
cd routedev
pnpm install
pnpm vitest run   # 确认测试通过
```
