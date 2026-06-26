# 双循环编排器

> Phase 49 Task 2 — 内循环 ReAct + 外循环独立验证

## 概述

双循环编排器把 ReAct 内循环和独立验证外循环统一编排。内循环用工作模型完成任务，外循环用不同模型独立验证（打破自评盲区）。验证不通过 → 把失败原因注入 LoopMemory → 打回内循环重跑，形成闭环。

知识库原文："Loop Engineering = 双循环：内循环（ReAct）→ 完成任务；外循环（验证/验收）→ 审核结果。核心转变：将 Human-in-the-loop 替换为 Agent-in-the-loop。"

## 核心概念

### Loop 五模块对应

| 模块 | 实现 |
|------|------|
| 目标来源 | `goal.plan` + `goal.gates` |
| 执行 Agent | 内循环 `ReActAgentLoop` |
| 验证 Agent | 外循环 `GoalVerifier` + `CompletionGate` + `CrossModelReviewer` |
| 记忆 | `LoopMemory`（失败原因沉淀） |
| 终止条件 | 外循环通过 OR 达到 `maxReruns` |

### 仲裁规则（`evaluateOuterLoop`）

判定顺序——前一个失败立即返回不通过：

1. **CompletionGate 失败** → 不通过（`工程验证未通过：xxx`）
2. **GoalVerifier 失败** → 不通过（`目标未完成：xxx`）
3. **CrossModelReviewer 发现 critical** → 推翻 pass，不通过（`跨模型审查发现 N 个 critical 问题`）
4. 否则通过

知识库原文："默认以 CompletionGate 为准；高严重度 reviewer 质疑可推翻 CompletionGate 的 pass。"

### 跨模型对抗审查（`CrossModelReviewer`）

- 接收内循环 modelId，自动从 `availableModels` 中选不同模型
- 多候选时用启发式挑最强的
- 只有一个模型可用时回退到同模型，但 `summary` 标注"未跨模型"（陷阱 #142）
- LLM 调用失败时回退为"未审查"结果，不抛错

### LoopMemory（循环记忆）

- 失败原因沉淀到 `.routedev/loop-memory/<goal-id>.md`
- 重跑时 `buildPrompt()` 注入 system prompt，让 AI 看到历史失败
- `buildResuggestion()` 给用户提示当前重跑的关注点
- 陷阱 #147：只保留最近 5 次失败，更早的归档到 `archived/`

### "让 AI 自己改"约束（2.5 节）

外循环不通过时**禁止人工 patch/hotfix**——必须把失败原因注入 LoopMemory，让 AI 基于反馈自修正。

例外：连续 `maxReruns` 次同一原因失败 → 触发 `pilot-mode-triggered` 事件，允许用户接管。

## 使用方式

```typescript
import { DualLoopOrchestrator } from './src/agent/dual-loop-orchestrator.js';

const orchestrator = new DualLoopOrchestrator();
for await (const event of orchestrator.run({
  goal: { description, plan, projectPath },
  reactParams,           // ReActRunParams（含 llmClient/userMessage 等）
  reactLoop,             // ReActAgentLoop 实例
  goalVerifier,          // GoalVerifier 实例
  verifierOptions,       // GoalVerifierOptions
  completionGate,        // CompletionGate 实例
  crossModelReviewer,    // 可选；不传则跳过跨模型审查
  maxReruns: 2,          // 陷阱 #141：默认 2 而非 3
  humanInterventionDetector, // 可选；检测到人工修改则停止自动重跑
})) {
  // 处理 DualLoopEvent
}
```

### 事件类型

| 事件 | 含义 |
|------|------|
| `inner-loop-start` / `inner-loop-complete` | 内循环每轮起止 |
| `inner-loop-event` | 透传 ReAct 事件 |
| `outer-loop-start` | 外循环验证开始 |
| `outer-loop-failed` | 外循环不通过，准备打回重跑（携带 reason / suggestion） |
| `dual-loop-complete` | 外循环通过，双循环正常完成 |
| `dual-loop-exhausted` | 达到 maxReruns 仍失败，终止并报告 |
| `human-intervention-detected` | 检测到人工介入，停止自动重跑 |
| `pilot-mode-triggered` | 同一原因重复失败，提示用户接管 |

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxReruns` | `DEFAULT_MAX_RERUNS = 2` | 陷阱 #141：默认 2 而非 3，避免 Token 爆炸 |
| `crossModelReviewer` | undefined | 不传则跳过跨模型审查（仲裁规则第 3 步不触发） |
| `humanInterventionDetector` | undefined | 可选；返回 true 则停止自动重跑 |

## 陷阱

- **#141 maxReruns 导致 Token 爆炸**：每次重跑都是完整 ReAct 循环，3 次 = 3 倍 Token。默认 2 而非 3，且 LoopMemory 注入失败原因以减少重跑次数
- **#142 跨模型审查模型不可用**：审查模型失效时回退到同模型审查但标注"未跨模型"，不直接失败
- **#147 LoopMemory 文件无限增长**：长 /goal 任务（如 50 步）失败记录可能很大，只保留最近 5 次，更早的归档
- "让 AI 自己改"约束：人工介入会破坏 LoopMemory 反馈闭环，AI 自己改才能沉淀"为什么这样改"到记忆
- 仲裁顺序：CompletionGate > GoalVerifier > CrossModelReviewer——前者失败即返回，不继续判定

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| `loop.ts` ReActAgentLoop | 内循环直接复用，通过 `reactLoop.run()` 调用 |
| `goal-verifier.ts` | 外循环 LLM 验证目标完成度 |
| `completion-gate.ts` | 外循环工程化验证（typecheck/lint/tests） |
| `unified-reviewer.ts` | 共享 `CodeReviewResult` / `CodeReviewIssue` 类型 |
| `cross-model-reviewer.ts` | 跨模型审查器，实现 `CrossModelReviewerLike` 接口 |
| `loop-memory.ts` | 失败原因持久化 + system prompt 注入 |
| `patterns/reflection.ts` | ReflectionPattern 是双循环的轻量版（无 LoopMemory/CompletionGate），适合单步快速自检 |
| `skills/skill-flow-engine.ts` | SkillFlow 控制单个 Skill 内部流转，双循环控制 /goal 整体执行+验证 |
