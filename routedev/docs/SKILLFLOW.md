# SkillFlow 引擎

> Phase 49 Task 1 — Skill 固化阶段 2

## 概述

SkillFlow 把 Skill 从"说明书"升级为"被引擎控制的可执行流水线"。每次只发一步，AI 看不到后续步骤（防跳步）；步骤间插入 checkpoint 检查；失败按 onFailure 处理（retry / abort / goto）。

知识库原文："固化——把一个 AI 的 skill 变成被引擎控制、可复现、管得住权限的流水线。每次只喂一步，做完才给下一步，永远不漏。"

## 核心概念

### 三阶段固化路径

| 阶段 | 形态 | RouteDev 现状 |
|------|------|---------------|
| 1 提示词 | SKILL.md 注入 system prompt，AI 自由执行 | Phase 48 已有 |
| 2 引擎控制 | SkillFlow 逐步发步 + checkpoint + user-gate | **Phase 49 Task 1** |
| 3 确定性引擎 | 节点产出可校验、可断点续跑 | Task 1.8 + Task 1.9 |

### 节点类型（`FlowNodeType`）

| 类型 | 职责 | 关键字段 |
|------|------|----------|
| `step` | AI 做事（一次 ReAct 循环） | `prompt` / `allowedTools` / `attractor` |
| `checkpoint` | 验证上一步输出 | `checkCondition`（llm-judge / regex-match / tool-output-contains） |
| `user-gate` | 暂停等待用户确认 | `gateMessage` |
| `loop` | 重复执行直到条件满足 | `loopCondition.{while, maxIterations}` |
| `branch` | 根据条件走不同路径 | `branches[]` |

### 失败处理（`onFailure`）

- `retry`：重置节点状态，主循环再次进入；受 `maxRetries` 上限
- `abort`：立即终止整个 flow，yield `flow-aborted`
- `goto`：跳转到 `onFailureGoto` 指定的节点

### 吸因子引导层（Attractor）

约束（checkpoint）告诉 AI"不能做什么"，吸因子告诉 AI"做对了长什么样"。

每个 step 节点可选声明 `attractor`：
- `desiredOutput`：期望产出画像
- `styleSample`：打样文件路径
- `doneCriteria`：完成判定标准

`AttractorInjector.inject()` 在 prompt 末尾追加引导文本。约束+引导协同：吸因子降低走偏概率，checkpoint 兜底防止吸因子失效。

## 使用方式

### flow.yaml 示例

```yaml
nodes:
  - id: build
    type: step
    title: "构建项目"
    prompt: "运行构建命令，确保构建成功"
    allowedTools: ["shell_exec"]
    onFailure: retry
    maxRetries: 2
  - id: build-check
    type: checkpoint
    title: "验证构建产物"
    checkCondition:
      kind: regex-match
      pattern: "Build successful|构建成功"
    onFailure: goto
    onFailureGoto: build
  - id: confirm-deploy
    type: user-gate
    title: "确认部署"
    gateMessage: "构建已完成，确认部署到生产环境？"
    onFailure: abort
  - id: deploy
    type: step
    title: "执行部署"
    prompt: "执行部署脚本"
    allowedTools: ["shell_exec"]
    onFailure: abort
  - id: verify
    type: checkpoint
    title: "验证部署成功"
    checkCondition:
      kind: llm-judge
      judgePrompt: "检查部署日志中是否有错误，服务是否正常启动"
    onFailure: retry
    maxRetries: 3
entryNodeId: build
exitNodeId: verify
maxTotalIterations: 20
```

### 引擎调用

```typescript
import { SkillFlowEngine } from './src/skills/skill-flow-engine.js';

const engine = new SkillFlowEngine();
for await (const event of engine.run(flow, params)) {
  // 处理 FlowEvent：node-start / node-complete / checkpoint-passed / ...
}
```

`SkillFlowRunParams` 通过依赖注入接收 5 个回调（`runReact` / `llmJudge` / `evaluateLoopCondition` / `waitForUserConfirmation` / `evaluateBranch`），让引擎与外部 LLM/UI 完全解耦，便于测试 mock。

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxTotalIterations` | 必填 | 全局迭代上限，达到即 abort |
| `maxRetries`（节点级） | 0 | `onFailure=retry` 时的最大重试次数 |
| `maxIterations`（loop 节点） | 必填 | 循环节点的硬上限 |
| `globalAllowedTools` | 可选 | 所有节点继承的工具白名单 |

## 陷阱

- **#139 嵌套 generator 死锁**：user-gate 等待用户确认时若 ReAct 阻塞会卡住整个管线，必须用 AbortSignal + 超时（5 分钟）
- **#140 LLM judge 误判**：judge prompt 必须含明确通过/不通过标准，失败时给 AI 看 reasoning
- **#148 loop 节点无限循环**：LLM 可能永远返回 false，maxIterations 是硬上限，且 onFailure 应设 abort 而非 goto
- **#151 吸因子过度引导**：attractor 字段全部可选，不配置时 SkillFlow 仍能靠 checkpoint 运行
- **#152 任务中断恢复状态不一致**：恢复时必须用 `validateCheckpoint` 校验输出哈希，不一致则重跑该节点及下游
- 节点粒度应控制在 2-5 分钟工作量（`NodeGranularityChecker` 给警告但不阻断）

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| `compose-pipeline.ts` | 会话级编排（需求→编码→测试→审查），SkillFlow 是 Skill 级编排，不替代关系 |
| `loop.ts` ReActAgentLoop | SkillFlow 不替代 ReAct 循环，而是包裹它；每个 step 节点 = 一次 ReAct 循环 |
| `dual-loop-orchestrator.ts` | 双循环的外循环可触发 SkillFlow 执行带 flow 的 Skill |
| `quality-gate.ts` | 质量门可校验 SkillFlow 节点粒度（`NodeGranularityChecker`） |
| `cite/structured-injector.ts` | step 节点可声明 `attractor.styleSample`，由 StyleSampleInjector 注入打样 |
| `skill-flow-checkpoint-store.ts` | 任务中断恢复——持久化 `FlowExecutionContext` 到 `.routedev/skill-flow/<flow-id>.json` |
