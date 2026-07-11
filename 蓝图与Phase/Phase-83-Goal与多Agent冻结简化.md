# Phase 83 — Extended Pack 收口

> **Phase 类型：** Extended Pack 整理（Medium-Low Tier Consolidation）  
> **前置依赖：** Phase-82（Pack 机制已可用）  
> **目标版本：** v4.8.0-rc  
> **核心目标：** 将 Multi-Agent、Goal 高级编排、对抗审查整理为三个独立的 Extended Pack，接口干净、按需启用、修 bug 不扩功能  
> **层级定位：中等偏下** —— 不是 Core，不是冷处理，而是"有明确场景、保留维护、默认关闭"

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | `pack.goal-advanced` 独立可用 | 启用后 `/goal` sequential 闭环通过 |
| 2 | `pack.multi-agent` 独立可用 | 启用后 spawn_agent 可达；off 后不可达 |
| 3 | `pack.adversarial-review` 独立可用 | 启用后 /review 命令可用 |
| 4 | 三个 Pack 各自默认 off | 默认启动不加载任何 Extended Pack |
| 5 | 三个 Pack 接口干净 | 类型导出不依赖 Core 内部细节 |
| 6 | GoalVerifier 留在 Core | 不随 Pack 走，Core 对话也能用 |
| 7 | 并行/冲突检测冻结 | 代码路径不可达，不删代码 |
| 8 | 新增功能禁令 | 本 Phase 不为三个 Pack 增加任何新能力 |

---

## 与之前版本的关键区别

之前把 Multi-Agent / Goal / 对抗审查归入 Experimental（冻结）。现在根据四层架构修订为 **Extended Pack**（中等偏下）：

| 方面 | 旧方案（Experimental/Freeze） | 新方案（Extended Pack） |
|------|-------------------------------|------------------------|
| 代码保留 | 保留但不维护 | 保留并修 bug |
| 接口完整性 | 不承诺 | 承诺类型契约 |
| 用户可见 | 不出现在设置页 | 设置页"高级"区 |
| 启用方式 | 无正式入口 | Pack 开关 |
| 删除门槛 | 与下一个清理窗口一起删 | 60 天零启用 |
| 新增功能 | 禁止 | 禁止（修 bug 不扩功能） |

---

## Task 1：pack.goal-advanced

**目标：** /goal 高级编排能力独立为 Extended Pack

**包含模块：**
- goal-runner 拆分后的 scheduler（顺序/条件/并行调度）
- goal-parser（目标分解）
- goal-persistence（持久化）
- goal-gates / goal-audit
- **不含** GoalVerifier（留 Core）

**处理策略：**

| 子能力 | 归属 | 理由 |
|--------|------|------|
| sequential 执行 | Extended Pack | 任务管理有社区认可但非高频 |
| 目标分解（LLM 拆步骤） | Extended Pack | /goal 核心能力 |
| 条件分支 | Extended Pack | 有价值但非必需 |
| 并行调度 | **Freeze** | 无真实使用，冻结代码路径 |
| 冲突检测 | **Freeze** | 同上 |
| GoalVerifier | **Core** | 外部验证有社区认可，对话也能用 |
| failure-report | **Core** | 错误报告是基本体验 |

- [ ] **Step 1: 确认 Pack 边界**

对照 Phase-80 清单，确认 goal-runner 拆分后各文件的归属。

- [ ] **Step 2: 实现 Pack register**

```ts
export const goalAdvancedPack: CapabilityPack = {
  id: 'pack.goal-advanced',
  layer: 'extended',
  description: '/goal 多步任务编排（顺序执行 + 目标分解）',
  costHint: '启用后 /goal 命令可用，每次调用涉及多轮 LLM',
  defaultEnabled: false,
  register(ctx) {
    // 注册 /goal 命令
    // 装配 goal-runner scheduler
  },
  unregister(ctx) {
    // 移除 /goal 命令
  },
};
```

- [ ] **Step 3: 并行/冲突检测冻结**

保留代码文件和类型导出，但：
- 从 scheduler 中移除并行/冲突检测的调用点
- 配置 `goal.parallel.enabled: false` 且标注 Freeze
- 不做物理删除

- [ ] **Step 4: GoalVerifier 确保留 Core**

确认 GoalVerifier 不依赖 Pack 机制：
- 普通对话中也能做结果验证
- 不要求 Pack 启用

- [ ] **Step 5: 测试**

- Pack off：/goal 命令返回"未启用 pack.goal-advanced"
- Pack on：sequential /goal 闭环
- GoalVerifier 在 Pack off 时仍可用

- [ ] **Step 6: 提交**

```powershell
git commit -m "refactor(phase-83): goal 高级编排整理为 Extended Pack"
```

---

## Task 2：pack.multi-agent

**目标：** Multi-Agent 协作能力独立为 Extended Pack

**包含模块：**
- `src/agent/multi/orchestrator.ts`
- `src/agent/multi/blackboard.ts`
- `src/agent/multi/worker-executor.ts`
- `src/agent/multi/conflict.ts`（仅保留接口，不接入生产）
- `src/agent/multi/state-graph.ts`
- `src/tools/builtin/spawn-agent.ts`
- `src/agents/*`（profile / delegation / lifecycle）

**处理策略：**

| 模块 | 策略 |
|------|------|
| orchestrator | 保留完整；修 bug；不加新 Agent Profile |
| blackboard | 保留；修 bug |
| worker-executor | 保留；修 bug |
| conflict detector | 保留接口；不接入生产调度 |
| spawn-agent | 仅 Pack on 时注册到 ToolRegistry |
| Agent profiles | 保留现有模板；不加新模板 |
| delegation-* | 保留；修 bug |

- [ ] **Step 1: 确认 Pack 边界**

- [ ] **Step 2: 实现 Pack register**

```ts
export const multiAgentPack: CapabilityPack = {
  id: 'pack.multi-agent',
  layer: 'extended',
  description: '多 Agent 协作（Orchestrator + Blackboard + 子 Agent 委托）',
  costHint: '启用后 spawn_agent 工具可用，多 Agent 场景 token 消耗 ×3-10',
  defaultEnabled: false,
  register(ctx) {
    // 装配 orchestrator / blackboard / worker
    // 注册 spawn_agent 到 ToolRegistry
  },
  unregister(ctx) {
    // 反注册
  },
};
```

- [ ] **Step 3: spawn_agent 与 ToolRegistry 解耦**

- 默认不注册 spawn_agent
- Pack on 时动态注册
- Pack off 时动态反注册

- [ ] **Step 4: 接口清理**

确保 multi/* 的类型导出不依赖 Core 内部细节（如 Loop 私有状态）。允许 import Core 公开类型。

- [ ] **Step 5: 测试**

- Pack off：spawn_agent 不在 ToolRegistry
- Pack on：spawn_agent 可达，子 Agent 创建成功
- 子 Agent 异常不影响主 Agent

- [ ] **Step 6: 提交**

```powershell
git commit -m "refactor(phase-83): Multi-Agent 整理为 Extended Pack"
```

---

## Task 3：pack.adversarial-review

**目标：** 对抗审查能力独立为 Extended Pack

**包含模块：**
- `src/agent/cross-model-reviewer.ts`
- 对抗审查相关逻辑（adversarial test/review）
- **不含** GoalVerifier（留 Core）
- **不含** unified-reviewer（Core 基础审查留 Core）

**处理策略：**

| 模块 | 策略 |
|------|------|
| cross-model-reviewer | 保留；修 bug；不加新审查维度 |
| adversarial 逻辑 | 保留；修 bug |
| GoalVerifier | Core（已在 Task 1 处理） |
| unified-reviewer | Core（基础代码审查） |

- [ ] **Step 1: 确认 Pack 边界**

区分：
- 对抗审查（Pack）：Agent 主动用另一模型审查自己的输出
- 基础审查（Core）：unified-reviewer 的代码质量检查
- GoalVerifier（Core）：目标完成度验证

- [ ] **Step 2: 实现 Pack register**

```ts
export const adversarialReviewPack: CapabilityPack = {
  id: 'pack.adversarial-review',
  layer: 'extended',
  description: '对抗审查（跨模型交叉验证 Agent 输出）',
  costHint: '启用后每次审查额外调用一次 LLM',
  defaultEnabled: false,
  register(ctx) {
    // 注册 /review 命令
    // 装配 cross-model-reviewer
  },
  unregister(ctx) {},
};
```

- [ ] **Step 3: 测试**

- Pack off：/review 命令返回"未启用 pack.adversarial-review"
- Pack on：/review 触发跨模型审查
- GoalVerifier 不受 Pack 影响

- [ ] **Step 4: 提交**

```powershell
git commit -m "refactor(phase-83): 对抗审查整理为 Extended Pack"
```

---

## Task 4：文档与接口审计

- [ ] **Step 1: 三个 Pack 的接口审计**

检查每个 Pack 的类型导出是否：
- 不泄露 Core 内部实现
- 有清晰的公开 API 边界
- 启用/禁用不影响 Core 类型编译

- [ ] **Step 2: 更新 CAPABILITY_LAYERS.md**

三个 Pack 的所有模块更新为 `extended-pack`。

- [ ] **Step 3: 更新设置页**

"高级" 区展示三个 Extended Pack 开关，每个附带：
- 功能描述
- 成本提示
- "修 bug 不扩功能"的维护说明

- [ ] **Step 4: 提交**

```powershell
git commit -m "docs(phase-83): Extended Pack 文档与接口审计"
```

---

## 验收

- [ ] 三个 Extended Pack 各自独立可开关
- [ ] 默认启动不加载任何 Extended Pack
- [ ] GoalVerifier 在 Pack off 时仍可用（Core）
- [ ] 并行/冲突检测冻结（代码路径不可达）
- [ ] 本 Phase 未为任何 Pack 增加新能力
- [ ] Pack 接口干净（不泄露 Core 内部）
- [ ] CAPABILITY_LAYERS.md 更新

---

## 回滚策略

- 每个 Pack 配置 `enabled: true` 可恢复功能
- 冻结的并行/冲突代码仍在，需要时可重新接线
- 本 Phase 不物理删除任何代码
