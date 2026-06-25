# Phase 44 — 消息节点化与分支化对话增强

> **版本目标：** v3.5.0
> **前置依赖：** Phase 43（v3.4.0 子 Agent 上下文控制、/goal 生命周期进化、Hook 增强）完成
> **新增测试要求：** ≥ 40 个
> **研究依据：** RouteDev 当前分支对话实现（`src/agent/branch.ts`、`src/cli/components/BranchSwitcher.tsx`、`src/cli/commands/branch.ts`）；APIX 消息节点化管理设计；用户关于消息分支与 /goal / 代码分支联动的讨论
> **核心命题：** RouteDev 已经具备消息节点树和对话分支的基础能力（Phase 25），但当前只实现了"能分叉、能切换"，缺少节点级持久化、需求变更可追溯、消息分支与代码分支联动、多分支并行实验等关键能力。本 Phase 把消息节点从"对话历史管理器"升级为"需求 → 计划 → 执行 → 审计"的完整链路载体：用户修改任意消息都能自动生成新分支并展示需求变更 diff；消息分支可以直接触发 /goal 或 /experiment 的代码分支；多个消息分支可以并行探索不同实现方向；所有节点操作持久化到磁盘，重启后可恢复。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `src/agent/branch.ts` | `BranchManager`：消息节点树、fork/append/edit/switch、节点上限淘汰 | 高（核心数据结构复用） |
| `src/cli/components/BranchSwitcher.tsx` | 分支树可视化（文本 + Ink 组件）、分页 | 高（扩展为时间线/节点图视图） |
| `src/cli/commands/branch.ts` | `/branch list / switch / edit` 命令 | 高（新增 delete / insert / merge / run） |
| `src/harness/experiment-manager.ts` | Git Worktree 代码分支管理 | 高（与消息分支联动） |
| `src/agent/multi/branch-orchestrator.ts` | /goal → 分支任务 → 拓扑执行 | 高（消息分支触发代码分支） |
| `src/agent/goal-parser.ts` + `goal-prompt-builder.ts`（Phase 43） | 五段式规范生成 | 高（需求变更后重新生成规范） |
| `src/cli/components/DiffView.tsx` | Diff 渲染组件 | 高（复用做需求变更 diff） |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| 分支数据仅内存存储 | 重启后分支结构丢失 | Task 1 节点级持久化与恢复 |
| 只能编辑消息，不能删除/插入 | 用户修正需求的自由度不足 | Task 2 节点级操作补全 |
| 修改需求后看不到变更影响 | 无法判断是否需要重新执行 /goal | Task 3 需求变更 diff 与影响分析 |
| 消息分支与代码分支两套系统 | 对话分支改需求，代码实验分支不感知 | Task 4 消息分支与 /goal / experiment 联动 |
| 只能单分支切换，不能并行探索 | 无法对比不同需求的实现效果 | Task 5 多分支并行实验 |
| BranchSwitcher 只显示分支树，不显示节点时间线 | 用户难以理解分支内消息演进 | Task 6 UI 增强：时间线、节点图、需求 diff |

### 3. 可行性总评

- **节点持久化：** 高度可行。`BranchNode` / `BranchInfo` 结构已经稳定，只需增加序列化/反序列化和文件存储。
- **节点级操作补全：** 高度可行。`editByHistoryIndex` 已有实现模式，delete / insert / undo / redo 可复用同一套节点树操作。
- **需求变更影响分析：** 可行。复用 Phase 42 的 `CodeMapEngine` 和 Phase 43 的 `ContextPacker`，判断需求变更是否影响已生成的 GoalPlan。
- **消息分支与代码分支联动：** 可行。消息分支的 `branchId` 可以作为 `ExperimentManager` 和 `BranchOrchestrator` 的输入参数，建立映射表。
- **多分支并行实验：** 可行。复用 Phase 43 的委托门控和并发控制，但需要解决文件访问冲突（借鉴 APIX 的文件冲突检测）。
- **UI 增强：** 高度可行。`BranchSwitcher` 已封装文本和 Ink 组件，扩展成本低。

---

## 核心设计原则

### 原则 1：消息节点是"需求快照"，不是聊天记录

每个消息节点都代表一个特定时刻的需求状态。修改消息 = 创建新的需求快照 = 可能产生新的执行分支。

### 原则 2：对话分支与代码分支必须可互相追踪

用户不应该在对话里改需求后，再手动去代码分支里找对应关系。系统应自动维护：

```
message branch A ──→ /goal plan A ──→ experiment worktree A
message branch B ──→ /goal plan B ──→ experiment worktree B
```

### 原则 3：变更必须可见

任何消息修改、删除、插入都必须向用户展示：
- 变更了什么（diff）
- 影响了哪些下游节点/分支
- 哪些分支需要重新执行

### 原则 4：并行探索必须可控

多分支并行实验时，必须：
- 声明每个分支的预期读写文件集合
- 检测文件访问冲突
- 提供清晰的对比视图帮助用户选择最佳分支

---

## Task 1：消息节点持久化与恢复（≥ 6 测试）

### 1.1 持久化格式

把 `BranchManager` 的节点树和分支元数据持久化到 `.routedev/conversation/tree.jsonl` 或 SQLite：

```typescript
interface PersistedConversationTree {
  version: 1;
  activeBranchId: string | null;
  nodes: BranchNode[];
  branches: BranchInfo[];
  historyNodeIds: string[];
  lastModifiedAt: number;
}
```

**选择 JSONL：** 消息节点追加频繁，JSONL 追加写入成本低，且便于审计。

### 1.2 保存时机

- 每次 `append` / `fork` / `edit` / `delete` / `insert` 后异步保存
- 应用正常退出前强制保存
- 崩溃恢复：启动时读取 `.routedev/conversation/tree.jsonl`，损坏时回退到 `.routedev/conversation/tree.jsonl.bak`

### 1.3 与 `/compact` 的关系

- `/compact` 压缩对话上下文时，**不删除分支结构**，只压缩节点内的 `message.content`
- 压缩前保存完整树快照到 `.routedev/conversation/snapshots/<timestamp>.jsonl`

### 1.4 测试要求

- 创建分支后重启应用，分支结构正确恢复。
- 编辑消息后持久化，重启后显示新分支。
- `/compact` 后分支结构不丢失。
- 持久化文件损坏时能从备份恢复。
- 多工作区各自独立持久化（与 Phase 43 worktree 隔离一致）。
- 大节点树（>5000 节点）保存/加载性能可接受。

---

## Task 2：节点级操作补全（≥ 8 测试）

### 2.1 删除消息节点

```typescript
branchManager.deleteByHistoryIndex(historyIndex: number): string | null
```

- 从节点树中移除目标节点
- 目标节点的子节点挂到父节点下（保持树连通）
- 以父节点为分叉点创建新分支，标记为"删除后"
- 如果删除的是分支 tip，该分支 tip 回退到父节点

### 2.2 在任意位置插入消息

```typescript
branchManager.insertByHistoryIndex(historyIndex: number, message: LLMMessage): string
```

- 在指定节点之后插入新消息
- 原后续消息作为新节点的子节点
- 创建新分支保存插入后的对话路径

### 2.3 撤销 / 重做

```typescript
branchManager.undo(): LLMMessage[] | null
branchManager.redo(): LLMMessage[] | null
```

- 维护操作栈（action stack）
- 支持 undo：append / fork / edit / delete / insert
- redo 只恢复最近一次 undo
- UI 中显示 `Ctrl+Z` / `Ctrl+Y` 快捷键提示

### 2.4 批量编辑

支持用户选择一段连续消息（如索引 3-5）进行批量替换：

```typescript
branchManager.editRange(startIndex: number, endIndex: number, newMessages: LLMMessage[]): string
```

### 2.5 测试要求

- 删除消息后子节点正确挂到父节点。
- 插入消息后原后续消息成为新节点子节点。
- undo 能恢复到操作前状态。
- redo 能恢复被 undo 的操作。
- 操作栈在持久化后保留。
- 批量编辑后生成正确的新分支。
- 删除/插入后活跃分支切换正确。
- `/branch list` 正确显示删除/插入产生的分支。

---

## Task 3：需求变更 diff 与影响分析（≥ 6 测试）

### 3.1 需求变更检测

当用户编辑/插入/删除用户消息（`role === 'user'`）时，系统应识别为需求变更：

```typescript
interface RequirementChange {
  type: 'edit' | 'insert' | 'delete';
  targetNodeId: string;
  before: string;
  after: string;
  impactedBranches: string[];
}
```

### 3.2 需求 diff 视图

复用 `DiffView.tsx` 渲染需求变更：

```tsx
<RequirementDiffView
  before="实现登录功能"
  after="实现登录功能，支持微信扫码登录"
  impactedGoalIds={['goal-abc']}
/>
```

### 3.3 影响分析

判断需求变更是否需要重新执行 `/goal`：

```typescript
function analyzeChangeImpact(
  change: RequirementChange,
  currentGoalPlan?: GoalPlan,
): {
  needsReplan: boolean;
  reason: string;
  affectedSteps: string[];
};
```

判断规则：
- 如果变更只涉及措辞、示例，不影响 `Goal/Scope/Done when` → 不需要重新执行
- 如果变更改变了目标、范围、约束、完成标准 → 必须重新生成 GoalPlan
- 如果已有代码分支，提示用户是否废弃旧分支或保留对比

### 3.4 测试要求

- 编辑用户消息后被识别为需求变更。
- 编辑助手消息不触发需求变更分析。
- 需求 diff 正确显示前后差异。
- 影响分析正确判断是否需要重新生成 GoalPlan。
- 影响分析能定位到受影响的步骤。
- 需求变更触发 Hook 事件 `on-requirement-change`。

---

## Task 4：消息分支与 /goal / experiment 联动（≥ 8 测试）

### 4.1 建立映射表

维护消息分支到代码分支的映射：

```typescript
interface BranchLinkage {
  messageBranchId: string;
  goalId?: string;
  experimentId?: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'abandoned';
}
```

存储在 `.routedev/conversation/branch-linkage.json`。

### 4.2 从消息分支触发 /goal

当用户在某个消息分支上输入 `/goal ...` 时：

1. 以当前消息分支的完整上下文作为 `/goal` 输入
2. 生成的 `GoalPlan` 绑定到当前消息分支
3. 如果 `/goal` 进入分支执行模式，自动创建对应的 experiment worktree
4. 在 `BranchPanel` 中同时显示消息分支和代码分支状态

### 4.3 需求变更后的联动更新

当用户修改了已经绑定 `/goal` 的消息分支时：

1. `analyzeChangeImpact` 判断是否需要重新规划
2. 如果需要，弹出确认框："需求已变更，是否重新执行 /goal？"
3. 用户确认后：
   - 旧 goal 标记为 `abandoned`
   - 生成新 goal
   - 新 experiment worktree 从当前代码状态创建（不是从旧 worktree）

### 4.4 代码分支回写消息分支

experiment 完成后，结果摘要自动写入对应消息分支的 Blackboard：

```typescript
blackboard.addCompletedStep({
  stepId: experiment.id,
  result: experiment.summary,
  modifiedFiles: experiment.modifiedFiles,
});
```

### 4.5 测试要求

- `/goal` 正确绑定到当前消息分支。
- `BranchPanel` 显示消息分支和代码分支的联动状态。
- 需求变更后正确提示重新执行 `/goal`。
- 重新执行 `/goal` 后旧 experiment 标记为 abandoned。
- experiment 结果摘要回写到消息分支。
- 切换消息分支时，关联的代码分支状态同步更新。
- 一个消息分支可以绑定多个 experiment（探索不同实现）。
- 删除消息分支时提示是否同步删除关联 experiment。

---

## Task 5：多分支并行实验（≥ 6 测试）

### 5.1 问题定义

用户可能想同时探索多个需求变体（如"用 JWT" vs "用 Session"）。当前只能切换分支串行执行，效率低。

### 5.2 并行实验模式

新增 `/branch experiment` 命令：

```
/branch experiment <branchId1> <branchId2> ...
```

为每个消息分支创建独立的 experiment worktree，并行执行对应的 `/goal`。

### 5.3 文件访问冲突检测（借鉴 APIX）

在并行实验前，每个分支必须声明预期修改的文件集合：

```typescript
interface ExperimentIntent {
  branchId: string;
  estimatedWriteFiles: string[];
  estimatedReadFiles: string[];
}
```

冲突检测：
- 两个分支都要写同一文件 → 禁止并行，提示用户选择串行或调整范围
- 读-写冲突 → 允许，但提示可能的数据竞争
- 无冲突 → 允许并行

### 5.4 结果对比视图

实验完成后，提供对比视图：

```
分支 A: JWT 方案
  修改文件: auth.ts, jwt.ts
  测试通过: 12/12
  Token 消耗: 8.5K

分支 B: Session 方案
  修改文件: auth.ts, session.ts
  测试通过: 11/12
  Token 消耗: 7.2K
```

用户可以选择采纳一个分支，或合并多个分支的修改。

### 5.5 测试要求

- 无冲突的两个分支可以并行执行 experiment。
- 写-写冲突被检测并阻止并行。
- 并行实验结果正确汇总到对比视图。
- 用户可以采纳一个分支的代码。
- 用户可以 cherry-pick 多个分支的部分文件。
- 并行实验的 token 消耗独立统计。

---

## Task 6：UI 增强 — 时间线、节点图、需求 diff（≥ 6 测试）

### 6.1 消息时间线视图

在 `BranchSwitcher` 基础上新增 `MessageTimeline` 组件：

```
┌─ 消息时间线 ─────────────────────────┐
[系统] 2026-06-24 10:00  项目初始化
[用户] 10:01  实现登录功能
[助手] 10:02  我需要一些细节...
[用户] 10:05  用 JWT，有效期 24 小时
  └─ 🌿 分支 "用 Session" (2 条消息)
[助手] 10:06  好的，开始实现...
```

### 6.2 节点图视图（可选增强）

用 ASCII 或轻量 SVG 展示完整节点树：

```
根
├─ 实现登录功能
│   ├─ 用 JWT ──→ [experiment: jwt-auth]
│   └─ 用 Session ──→ [experiment: session-auth]
└─ 帮我修 bug
```

### 6.3 需求变更弹窗

用户编辑用户消息后，弹出 `RequirementChangeModal`：

```
┌─ 需求变更 ───────────────────────────┐
│ 原: 实现登录功能                       │
│ 新: 实现登录功能，支持微信扫码登录      │
│                                       │
│ 影响:                                 │
│ ⚠️ 当前 /goal 需要重新规划              │
│ ⚠️ 已有 experiment 将标记为 abandoned  │
│                                       │
│ [重新规划] [仅保存到分支] [取消]        │
└───────────────────────────────────────┘
```

### 6.4 测试要求

- 时间线正确显示消息顺序和分支关系。
- 节点图能渲染 3 层以内的树结构。
- 需求变更弹窗在编辑用户消息后触发。
- 弹窗提供"仅保存到分支"选项（不触发 /goal）。
- 时间线支持点击节点切换到该节点所在分支。
- 节点图支持展开/折叠子分支。

---

## Task 7：集成测试与文档同步（≥ 4 测试）

### 7.1 端到端测试

1. **节点持久化端到端：** 创建分支 → 编辑消息 → 重启应用 → 分支结构恢复 → 继续对话。
2. **需求变更联动端到端：** 用户编辑已绑定 /goal 的消息 → 弹出需求变更弹窗 → 确认重新规划 → 新 experiment 创建 → 旧 experiment 标记 abandoned。
3. **多分支并行实验端到端：** 两个消息分支声明不同实现方案 → 并行执行 experiment → 文件冲突检测 → 结果对比 → 用户采纳其中一个。
4. **消息节点与代码审查端到端：** 用户基于消息分支创建 experiment → 完成后 reviewer 子 Agent 审查 → 结果回写到消息分支 → 用户在消息时间线中查看审查结论。

### 7.2 文档同步

- **BRANCH.md：** 新增消息节点架构、持久化、分支联动、并行实验说明。
- **GOAL.md：** 补充 /goal 与消息分支的绑定关系。
- **EXPERIMENT.md：** 补充 experiment 与消息分支的映射、结果回写。
- **UI.md：** 新增 `MessageTimeline`、`RequirementChangeModal`、`ExperimentComparisonView` 组件说明。
- **CHANGELOG.md：** v3.5.0 条目。
- **config schema：** 新增 `conversation.persistTree`、`conversation.maxNodes`、`conversation.maxBranches`、`experiment.parallelEnabled`。

---

## 新增陷阱警告

**111. 消息节点持久化文件可能损坏：** 必须用 JSONL + 备份机制，启动时校验 schema，损坏时回退备份而不是清空所有分支。

**112. 删除节点可能导致子分支 orphaned：** 删除消息时必须把子节点正确挂到父节点，并更新 `BranchInfo.tipNodeId`，否则分支 tip 指向不存在的节点。

**113. 需求变更弹窗不能打断简单对话：** 只有已绑定 /goal 或处于复杂模式时才弹窗；普通闲聊编辑消息不应打扰用户。

**114. 多分支并行实验的文件冲突检测不能替代委托门控：** 文件冲突检测是并行实验的前置条件，不是子 Agent 权限的替代。两者都要生效。

**115. 消息分支与代码分支的映射关系必须双向维护：** 只在一个方向维护会导致删除消息分支后代码分支孤立，或删除 experiment 后消息分支状态错误。

**116. 节点过多时 UI 渲染性能下降：** 时间线和节点图必须做虚拟滚动或懒加载，不要一次性渲染 5000+ 节点。

**117. 持久化频率过高影响性能：** 每次操作后保存是必要的，但必须异步 + 批量，避免阻塞用户输入。

---

## 思考引导总结

1. **消息节点持久化用 JSONL 还是 SQLite？** JSONL 更适合追加写入和审计；SQLite 更适合复杂查询。建议 JSONL 为主，必要时建立索引文件。

2. **需求变更影响分析用规则还是 LLM？** 先用规则判断（关键词/完成标准变化），复杂场景再调用 LLM，避免每次编辑都消耗 token。

3. **多分支并行实验是否默认开启？** 不建议默认开启。用户必须显式使用 `/branch experiment`，并确认文件冲突检测结果。

4. **消息分支与代码分支的命名规则？** 建议消息分支保持用户可读名称（前 20 字），代码分支（experiment）使用 `<message-branch-id>-<goal-id>` 格式，便于追踪。

5. **删除消息分支时是否级联删除 experiment？** 默认不级联删除，只标记 abandoned，给用户恢复机会。只有在用户显式确认"彻底删除"时才清理 worktree。

6. **与 Phase 43 的边界：** Phase 43 解决子 Agent 上下文控制、/goal 生命周期、Hook 增强；Phase 44 专门把对话层升级为可审计、可分支、可与代码执行联动的结构。不修改 Phase 43 文档，Phase 44 引用并扩展。

7. **执行顺序建议：** Task 1（持久化） → Task 2（节点操作补全） → Task 3（需求变更分析） → Task 6（UI 弹窗/时间线） → Task 4（与 /goal/experiment 联动） → Task 5（并行实验） → Task 7（集成测试）。持久化是基础，必须先做。
