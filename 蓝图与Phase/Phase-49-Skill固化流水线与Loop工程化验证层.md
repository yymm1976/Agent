# Phase 49 — Skill 固化流水线与 Loop 工程化验证层

> **版本目标：** v4.0.0
> **前置依赖：** Phase 48（v3.9.0 引用系统与外部生态兼容层）完成
> **新增测试要求：** ≥ 80 个（初版 62 + 补强 18：吸因子引导 1 + 任务中断恢复 2 + 节点粒度 1 + 让 AI 自己改 2 + 模型漂移检测 2 + 兜底不告知 2 + 打样注入 3 + 其余回归）
> **研究依据：** 精读用户知识库 `wiki/topics/`（5 个子目录共 9 篇）和 `wiki/agent-dev/`（7 篇）全部 16 篇文档——`主题-Skill深度实践`（CRITTO 三层架构、Skill 固化三阶段、3 场景验证、grill-me 对抗式审查、跨代理通用 Skills 架构、渐进式披露）、`主题-Skill系列综述`（Skill Creator 元能力、Scripts 进阶）、`主题-Prompt-vs-Skill对比`（Prompt→Skill 递进路径与升级信号）、`概念-Loop工程`（四级演进 L1-L4、Loop 五模块结构、五步设计法、六种编排拓扑、双循环结构 ReAct+验证、上下文工程装配策略、Harness 约束集合、上下文占用率实测数据）、`概念-多Agent协作`（四种共享记忆模式、图编排实战 4 天 14 万行代码、结构化交接棒、A2A 协议、Dynamic Workflows）、`概念-Agent设计模式`（五大核心模式：提示链/路由/并行/反思/护栏）、`主题-Agent开发综述`（Harness 三层拆解"更多 context 更少 control"、Agent 10 个核心模块、功能映射思维、95% 死在上线五道坎）、`概念-Agent评估体系`（评估集三层 Smoke/Regression/Comprehensive、LLM-as-Judge 五大陷阱、Rubric 五要素、在线监控 7 类信号、意图路由四层漏斗、固化流水线三大病症）、`概念-Agent安全`（五层防御、12 种注入手法、成本攻击防御五重、Threat Modeling 先行）、`概念-Agent框架选型`（五大架构范式、MCP/A2A 抹平工具生态差异）、`主题-Vibe编码最佳实践`（对抗性审查跨模型互审、四阶段判断力 L1-L4、功能映射分水岭）、`主题-AI编程工程哲学`（Tokenmaxxing、Pilot/Copilot 角色、死胡同识别、固化流水线 Agent 三大病症偷懒/用错工具/忘步骤、认知债、代码负责事实 LM 只负责判断）、`主题-AI持续工作方法`（循环公式：干什么+什么时候干完、四种持续工作方法对比、适用判断标准）、`主题-AI效率提升指南`（模型策略 80/15/5 组合、四阶段工作流、并发任务管理）、**`主题-AI项目长期迭代`**（Spec 是契约 Harness 是法律、4 阶段路线图 MVP→地基重构→稳定迭代→持续治理、任务粒度 2-5 分钟、**吸因子 Attractor 概念——Harness 是约束吸因子是引导、AI 视作团队通过引导收敛而非强制约束**、SDD 规格驱动过程方案与事实方案分离 Plan 与 Design 合并支持**任务中断恢复**、打样工程定义代码框架规范 AI 参照写出风格一致代码、跨代理通用 Skills 多层规约体系规约层→适配层→共享层、Hook 脚本门禁、测试驱动 AI 开发、10 万行项目防回归上下文管理+记忆系统+幻觉应对、失败模式 AI 兜底不告知、"新 feature=新 session"上下文隔离、"不直接修改 AI 代码让 AI 自己改"）、**`主题-AI独立创业`**（企业级 AI 编程≠个人 Vibe Coding 放大版需专门 AI 工程化角色、多 Agent 协作真实成本 48 Agent+182 Skill+68 命令维护成本巨大需量化 ROI、模型升级后 prompt 失效需持续维护、OPC 创业成本流量合规运营成本没有降低）。对照 RouteDev 现有实现：`src/agent/loop.ts`（ReAct 循环 + 中间件管线 + Hook + Compose 管线）、`src/agent/compose-pipeline.ts`（四阶段自动编排但靠关键词匹配流转）、`src/agent/context-compaction.ts`（L1-L5 渐进压缩 + 三级阈值）、`src/agent/multi/handoff.ts`（结构化交接 HandoffArtifact + JSON/正则解析）、`src/agent/multi/orchestrator.ts`（Worker 异常隔离 + 错误分类）、`src/agent/multi/score-card.ts`（执行质量评分卡）、`src/agent/unified-reviewer.ts`（统一审查 GoalVerifier + 代码审查）、`src/agent/completion-gate.ts`（独立代码验证门 typecheck/lint/tests）、`src/agent/goal-verifier.ts`（目标验证 + 对抗性验证）、`src/skills/skill-md-parser.ts`（SKILL.md 解析）、`src/skills/skill-generator.ts`（Skill AI 生成器）、`src/hooks/`（Hook 模板 + 生成器 + 市场）、`src/agent/middleware/`（循环检测、代码地图上下文、质量信号）
> **核心命题：** 知识库揭示了三个 RouteDev 尚未覆盖的工程化断层。**断层一：Skill 停留在"提示词层面"。** 知识库明确指出 Skill 固化有三个阶段——提示词→引擎控制流水线→SkillFlow 确定性引擎。RouteDev 的 Skill 目前是阶段 1（SKILL.md 被注入 system prompt，AI 可忽略、可跳步、可偷懒），Compose Pipeline 虽然有阶段流转但靠关键词匹配（"完成"字符串），不是真正的"引擎控制每步执行、做完才给下一步"。Phase 49 要引入 SkillFlow 引擎——把 Skill 从"说明书"升级为"被引擎控制的可执行流水线"，每次只发一步，步骤间插入检查节点，失败打回不跳过。**断层二：Loop 缺少独立外循环。** 知识库明确区分双循环结构——内循环 ReAct 完成任务，外循环独立验证审核。RouteDev 的 GoalVerifier 和 CompletionGate 已经是外循环雏形，但两者各自为战、缺少编排，且 GoalVerifier 用同一批模型做验证（知识库警告"同一个模型既写又评的自评盲区"）。Phase 49 要引入双循环编排器——内循环跑 ReAct，外循环用不同模型独立验证，验证不通过打回重跑，形成闭环。**断层三：Skill/Agent 缺少质量门。** 知识库要求 Skill 写完必跑 3 场景验证（正常/边界/诱导），RouteDev 的 Skill 生成器和市场导入没有任何质量校验。Phase 49 要引入 Skill 质量门——3 场景验证 + JSON Schema 校验 + 兜底确认检查，不通过的 Skill 标黄或拒绝加载。
>
> **知识库补强（来自 `主题-AI项目长期迭代` 与 `主题-AI独立创业` 两篇，初版遗漏，本版补入）：** 上述三个断层之外，长期迭代主题进一步指出"只有约束没有引导"是 AI 工程化的另一隐形短板。知识库提出 **吸因子（Attractor）** 概念——"Harness 是约束，吸因子是引导；把 AI 视作团队，通过引导而非约束使其收敛到稳定状态"。RouteDev 当前的 checkpoint / CompletionGate / 质量门全是"约束层"，缺少"引导层"让 AI 主动向期望状态收敛。同时该主题给出四条可直接落地的工程原则：① **任务粒度 2-5 分钟**（太粗 AI 走偏、太细上下文频繁切换，SkillFlow 节点应遵循此粒度）；② **任务中断恢复**（SDD 规格驱动把 Plan 与 Design 合并、标注完成/未完成状态，SkillFlow 必须支持断点续跑）；③ **不直接修改 AI 代码，让 AI 自己改**（双循环重跑时由 AI 基于 LoopMemory 自修正，而非人工介入）；④ **打样工程**（定义代码框架和规范，AI 参照打样写出风格一致的代码，与代码地图 + 引用系统结合可做"风格引导注入"）。独立创业主题则补充两条运维向原则：⑤ **模型升级后 prompt 失效需持续维护**（Skill 质量门应在模型版本变更时重新运行）；⑥ **多 Agent 协作的真实成本需量化 ROI**（48 Agent + 182 Skill + 68 命令的维护成本巨大，在线监控需聚合"配置 ROI"信号）。这六条补强点分散落地到 Task 1（①②③④）、Task 2（③）、Task 3（⑤）、Task 5（⑥），不另起 Task 以保持"一个 Phase 一个核心命题"的聚焦。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|-----------------|
| `skill-md-parser.ts` | 解析 YAML frontmatter + body，兼容旧 JSON | **高**——扩展 frontmatter 支持 `flow` 字段 |
| `skill-generator.ts` | LLM 生成 SKILL.md 草稿，正则兜底解析 | **高**——扩展生成 flow 定义 |
| `compose-pipeline.ts` | 四阶段编排（需求→编码→测试→审查），关键词匹配流转 | **中**——阶段配置模式可复用，但流转逻辑需重写为引擎控制 |
| `loop.ts` ReActAgentLoop | 完整 ReAct 循环 + 中间件 + Hook + 并行工具 | **高**——内循环直接复用 |
| `goal-verifier.ts` | LLM 验证 + 对抗性验证（独立 LLM 推翻结论） | **高**——外循环验证器直接复用 |
| `completion-gate.ts` | typecheck/lint/tests 独立验证门 | **高**——作为外循环的工程化验证节点 |
| `unified-reviewer.ts` | GoalVerifier + 代码审查统一入口 | **中**——需重构为双循环编排器的一部分 |
| `multi/handoff.ts` | HandoffArtifact 结构化交接 + JSON/正则解析 | **高**——结构化交接棒已有基础 |
| `multi/orchestrator.ts` | Worker 异常隔离 + 错误分类 + 重试 | **高**——异常隔离机制复用 |
| `multi/score-card.ts` | 执行质量评分卡（token/耗时/测试/采纳率） | **高**——作为 Loop 审计层 |
| `context-compaction.ts` | L1-L5 渐进压缩 + 三级阈值（50%/80%/90%） | **高**——上下文管理已成熟 |
| `middleware/loop-detection.ts` | 工具调用循环检测 + 打断建议 | **高**——内循环护栏复用 |
| `hooks/` | Hook 模板 + 生成器 + 市场 + 沙箱 | **高**——Hook 事件扩展 |

### 2. 核心缺口（对照知识库）

| 知识库要求 | RouteDev 现状 | 缺口 |
|-----------|-------------|------|
| Skill 固化阶段 2：引擎控制流水线，每次只发一步，做完才给下一步 | Compose Pipeline 靠关键词匹配（"完成"字符串），不是引擎控制 | **Task 1 SkillFlow 引擎** |
| Skill 固化阶段 3：用户控制节点（暂停等待确认）+ 检查节点（Agent 自查） | Compose Pipeline 无暂停/检查节点 | **Task 1.3 节点类型** |
| 双循环结构：内循环 ReAct + 外循环独立验证 | GoalVerifier 和 CompletionGate 各自为战，无编排 | **Task 2 双循环编排器** |
| 跨模型对抗审查：用不同模型打破自评盲区 | GoalVerifier 对抗性验证已有独立 LLM，但 unified-reviewer 用同一模型 | **Task 2.3 跨模型验证** |
| 3 场景验证：Skill 写完必跑正常/边界/诱导 | Skill 生成器和市场导入无任何质量校验 | **Task 3 Skill 质量门** |
| 兜底确认：Skill 中每个 fallback 都要有"询问用户"步骤 | Skill 无兜底检查机制 | **Task 3.3 兜底审查** |
| 上下文占用率可视化：实测 3.8 万 token/问候，10 万 token/报告 | context-compaction 有阈值但无 UI 可视化 | **Task 4 上下文占用率面板** |
| 结构化文件解析：先脚本解析不全量读取（大海捞针问题） | 引用系统（Phase 48）直接 read_file 全量读取 | **Task 4.2 结构化注入** |
| Loop 五模块：目标来源/执行 Agent/验证 Agent/记忆/终止条件 | /goal 有目标+执行+验证+终止，但缺少"记忆"模块（失败原因不沉淀） | **Task 2.4 Loop 记忆模块** |
| 评估集三层：Smoke(30)/Regression(100)/Comprehensive(500) | 无评估集体系 | **Task 5 评估集框架** |
| 在线监控 7 类信号：延迟/成本/质量/错误率/安全/反馈/漂移 | ScoreCard 有 token/耗时/测试统计，但无在线监控告警 | **Task 5.2 在线监控** |
| 意图路由四层漏斗：正则→向量→大模型→SafeNet | 路由器有正则+分类器，但无向量路由和 SafeNet | **Task 6 意图路由增强** |
| 五大设计模式：提示链/路由/并行/反思/护栏 | 路由✅ 并行✅ 护栏✅，但提示链和反思模式不明确 | **Task 6.2 提示链与反思** |

### 3. 可行性结论

- **SkillFlow 引擎：** 高度可行。Compose Pipeline 已有阶段配置 + 工具白名单 + 自动流转的模式，只需把"关键词匹配流转"升级为"引擎控制逐步执行 + 检查节点"。
- **双循环编排器：** 高度可行。GoalVerifier + CompletionGate + unified-reviewer 已有全部组件，只需编排为统一的双循环结构。
- **Skill 质量门：** 高度可行。Skill 生成器已有 LLM 调用能力，扩展为 3 场景验证只需增加验证 prompt。
- **上下文占用率：** 高度可行。context-compaction 已有三级行动（none/soft_notify/trigger/force），只需把 soft_notify 的数据推送到 UI。
- **评估集框架：** 中等可行。RouteDev 不是 SaaS 平台，评估集主要面向 Skill 和 /goal 的质量回归，规模可缩小为 Smoke(10)/Regression(30)。
- **意图路由增强：** 中等可行。向量路由需要 embedding 模型，可作为可选项；SafeNet（OOD 检测 + 熔断）可基于现有 confidenceThreshold 实现。

---

## Task 1：SkillFlow 引擎——Skill 固化阶段 2（≥ 12 测试）

### 1.1 设计理念

知识库原文：

> "固化——把一个 AI 的 skill 变成被引擎控制、可复现、管得住权限的流水线。每次只喂一步，做完才给下一步，永远不漏。"

RouteDev 当前的 Skill 是阶段 1（提示词层面）：SKILL.md 被注入 system prompt，AI 可以忽略、跳步、偷懒。SkillFlow 引擎把 Skill 升级为阶段 2（引擎控制流水线）：

```
阶段 1（当前）：SKILL.md → 注入 system prompt → AI 自由执行（可跳步）
    ↓ SkillFlow 升级
阶段 2（目标）：SKILL.md + flow 定义 → 引擎逐步发步 → 每步检查 → 通过才放行
```

### 1.2 SkillFlow 数据结构

在 `SkillMetadata` 中新增可选字段 `flow`，标识该 Skill 是否有固化流水线：

```typescript
// src/skills/skill-flow-types.ts

/** 流水线节点类型 */
export type FlowNodeType =
  | 'step'           // 普通执行步骤：AI 做事
  | 'checkpoint'     // 检查节点：验证上一步输出是否达标
  | 'user-gate'      // 用户控制节点：暂停等待用户确认
  | 'loop'           // 循环节点：重复执行直到条件满足
  | 'branch';        // 分支节点：根据条件走不同路径

/** 流水线节点定义 */
export interface FlowNode {
  /** 节点 ID（唯一） */
  id: string;
  /** 节点类型 */
  type: FlowNodeType;
  /** 节点标题 */
  title: string;
  /** 节点提示词（注入到 AI 的指令） */
  prompt: string;
  /** 工具白名单（空数组 = 继承 Skill 级别权限；null = 全工具） */
  allowedTools?: string[];
  /** checkpoint 专用：检查条件（LLM 判断或正则匹配） */
  checkCondition?: {
    /** 条件类型 */
    kind: 'llm-judge' | 'regex-match' | 'tool-output-contains';
    /** LLM judge 时的判断 prompt */
    judgePrompt?: string;
    /** regex-match 时的正则 */
    pattern?: string;
    /** tool-output-contains 时的工具名和关键词 */
    toolName?: string;
    keyword?: string;
  };
  /** user-gate 专用：向用户展示的确认信息 */
  gateMessage?: string;
  /** loop 专用：循环条件 + 最大次数 */
  loopCondition?: {
    /** 何时继续循环 */
    while: string;
    /** 最大循环次数（防止无限循环） */
    maxIterations: number;
  };
  /** branch 专用：分支条件 */
  branches?: Array<{
    /** 条件描述 */
    condition: string;
    /** 目标节点 ID */
    targetNodeId: string;
  }>;
  /** 失败时的动作 */
  onFailure: 'retry' | 'abort' | 'goto';
  /** onFailure=goto 时的目标节点 */
  onFailureGoto?: string;
  /** 最大重试次数（onFailure=retry 时） */
  maxRetries?: number;
}

/** Skill 的固化流水线定义 */
export interface SkillFlow {
  /** 节点列表（有序） */
  nodes: FlowNode[];
  /** 入口节点 ID */
  entryNodeId: string;
  /** 终止节点 ID（到达即完成） */
  exitNodeId: string;
  /** 全局工具白名单（所有节点继承） */
  globalAllowedTools?: string[];
  /** 全局最大迭代次数（防止失控） */
  maxTotalIterations: number;
}

/** SkillFlow 运行状态 */
export type FlowNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'user-pending';

/** SkillFlow 执行上下文 */
export interface FlowExecutionContext {
  /** 当前节点 ID */
  currentNodeId: string;
  /** 各节点状态 */
  nodeStates: Map<string, FlowNodeStatus>;
  /** 各节点输出 */
  nodeOutputs: Map<string, string>;
  /** 总迭代次数 */
  totalIterations: number;
  /** 循环节点的当前迭代计数 */
  loopCounters: Map<string, number>;
  /** 交接产物（步骤间传递） */
  handoffArtifacts: Map<string, HandoffArtifact>;
}
```

### 1.3 SkillFlow 引擎

```typescript
// src/skills/skill-flow-engine.ts

/**
 * SkillFlow 引擎——把 Skill 从"说明书"升级为"被引擎控制的可执行流水线"
 *
 * 核心机制：
 *   1. 每次只把当前节点的 prompt 注入 system prompt，不让 AI 看到后续步骤
 *   2. AI 执行完当前节点后，引擎调用 checkpoint 检查
 *   3. checkpoint 通过 → 推进到下一节点；不通过 → 按 onFailure 处理
 *   4. user-gate 节点暂停整个循环，等待用户确认
 *   5. loop 节点重复执行直到条件满足或达到 maxIterations
 *
 * 与 ReActAgentLoop 的关系：
 *   - SkillFlow 不替代 ReAct 循环，而是包裹它
 *   - 每个节点的执行 = 一次 ReAct 循环（可能多轮工具调用）
 *   - SkillFlow 控制节点间的流转，ReAct 控制节点内的工具调用
 */
export class SkillFlowEngine {
  /**
   * 运行 SkillFlow
   *
   * @param flow Skill 的流水线定义
   * @param params ReAct 循环运行参数（复用现有 ReActAgentLoop.run）
   * @returns AsyncGenerator<FlowEvent> 流式输出事件
   */
  async *run(
    flow: SkillFlow,
    params: ReActRunParams,
  ): AsyncGenerator<FlowEvent> {
    const ctx: FlowExecutionContext = {
      currentNodeId: flow.entryNodeId,
      nodeStates: new Map(),
      nodeOutputs: new Map(),
      totalIterations: 0,
      loopCounters: new Map(),
      handoffArtifacts: new Map(),
    };

    while (ctx.currentNodeId !== flow.exitNodeId) {
      // 护栏：总迭代次数上限
      if (ctx.totalIterations >= flow.maxTotalIterations) {
        yield { type: 'flow-aborted', reason: '达到最大总迭代次数' };
        return;
      }

      const node = flow.nodes.find(n => n.id === ctx.currentNodeId);
      if (!node) {
        yield { type: 'flow-error', error: `节点 ${ctx.currentNodeId} 不存在` };
        return;
      }

      ctx.totalIterations++;
      ctx.nodeStates.set(node.id, 'running');
      yield { type: 'node-start', node };

      try {
        switch (node.type) {
          case 'step':
            yield* this.executeStepNode(node, flow, ctx, params);
            break;
          case 'checkpoint':
            yield* this.executeCheckpointNode(node, ctx, params);
            break;
          case 'user-gate':
            yield* this.executeUserGateNode(node, ctx);
            break;
          case 'loop':
            yield* this.executeLoopNode(node, flow, ctx, params);
            break;
          case 'branch':
            this.executeBranchNode(node, flow, ctx);
            break;
        }
      } catch (error) {
        ctx.nodeStates.set(node.id, 'failed');
        yield { type: 'node-failed', node, error: String(error) };
        // 按 onFailure 处理
        if (node.onFailure === 'abort') {
          yield { type: 'flow-aborted', reason: `节点 ${node.id} 失败` };
          return;
        }
        // retry/goto 由各节点内部处理
      }
    }

    yield { type: 'flow-complete' };
  }

  /**
   * 执行普通步骤节点
   *
   * 关键：只把当前节点的 prompt 注入 system prompt
   * AI 看不到后续步骤，防止"跳步"
   */
  private async *executeStepNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: ReActRunParams,
  ): AsyncGenerator<FlowEvent> {
    // 构造节点级 system prompt
    const nodeSystemPrompt = this.buildNodePrompt(node, flow, ctx);
    // 限制工具白名单
    const nodeParams = this.applyToolWhitelist(params, node, flow);

    // 运行 ReAct 循环（复用现有引擎）
    let nodeOutput = '';
    for await (const event of params.llmClient /* ... ReActAgentLoop.run */) {
      // 透传 ReAct 事件
      yield { type: 'react-event', node, event };
      if (event.type === 'done') {
        nodeOutput = event.content;
      }
    }

    ctx.nodeOutputs.set(node.id, nodeOutput);
    ctx.nodeStates.set(node.id, 'passed');
    yield { type: 'node-complete', node, output: nodeOutput };

    // 推进到下一节点（线性顺序）
    ctx.currentNodeId = this.getNextNodeId(node, flow);
  }

  /**
   * 执行检查节点——验证上一步输出是否达标
   *
   * 三种检查方式：
   *   1. llm-judge：用独立 LLM 判断输出是否满足条件
   *   2. regex-match：正则匹配输出
   *   3. tool-output-contains：检查工具输出是否包含关键词
   */
  private async *executeCheckpointNode(
    node: FlowNode,
    ctx: FlowExecutionContext,
    params: ReActRunParams,
  ): AsyncGenerator<FlowEvent> {
    if (!node.checkCondition) {
      yield { type: 'node-skipped', node, reason: '无检查条件' };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
      return;
    }

    const lastStepOutput = this.getLastStepOutput(ctx);
    let passed = false;

    switch (node.checkCondition.kind) {
      case 'llm-judge':
        passed = await this.llmJudge(node.checkCondition.judgePrompt!, lastStepOutput, params);
        break;
      case 'regex-match':
        passed = new RegExp(node.checkCondition.pattern!).test(lastStepOutput);
        break;
      case 'tool-output-contains':
        // 检查交接产物中指定工具的输出
        const toolOutput = ctx.nodeOutputs.get(node.checkCondition.toolName!) ?? '';
        passed = toolOutput.includes(node.checkCondition.keyword!);
        break;
    }

    if (passed) {
      ctx.nodeStates.set(node.id, 'passed');
      yield { type: 'checkpoint-passed', node };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
    } else {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'checkpoint-failed', node };
      // 按 onFailure 处理：retry / abort / goto
      this.handleNodeFailure(node, ctx);
    }
  }

  /**
   * 执行用户控制节点——暂停等待用户确认
   *
   * 知识库原文：
   *   "用户控制节点（暂停等待确认）"
   */
  private async *executeUserGateNode(
    node: FlowNode,
    ctx: FlowExecutionContext,
  ): AsyncGenerator<FlowEvent> {
    ctx.nodeStates.set(node.id, 'user-pending');
    yield { type: 'user-gate', node, message: node.gateMessage ?? '请确认是否继续' };
    // 引擎暂停，等待外部调用 resume() / abort()
    // 实现方式：返回一个 Promise，由上层 UI 调用 resolve
    const userDecision = await this.waitForUserConfirmation(node.id);
    if (userDecision === 'approve') {
      ctx.nodeStates.set(node.id, 'passed');
      ctx.currentNodeId = this.getNextNodeId(node, flow);
    } else {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'flow-aborted', reason: `用户在 ${node.id} 处拒绝继续` };
    }
  }

  /**
   * 执行循环节点——重复执行直到条件满足
   *
   * 知识库原文：
   *   "循环节点（Task Planner 运行 N 次）"
   */
  private async *executeLoopNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: ReActRunParams,
  ): AsyncGenerator<FlowEvent> {
    const counter = (ctx.loopCounters.get(node.id) ?? 0) + 1;
    ctx.loopCounters.set(node.id, counter);

    if (counter > node.loopCondition!.maxIterations) {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'loop-exhausted', node, maxIterations: node.loopCondition!.maxIterations };
      this.handleNodeFailure(node, ctx);
      return;
    }

    yield { type: 'loop-iteration', node, iteration: counter };
    // 执行循环体（递归调用 step 逻辑）
    yield* this.executeStepNode(node, flow, ctx, params);

    // 检查循环条件
    const lastOutput = ctx.nodeOutputs.get(node.id) ?? '';
    const conditionMet = await this.evaluateLoopCondition(node.loopCondition!.while, lastOutput, params);
    if (conditionMet) {
      ctx.nodeStates.set(node.id, 'passed');
      ctx.currentNodeId = this.getNextNodeId(node, flow);
    } else {
      // 继续循环：重置到循环入口
      ctx.currentNodeId = node.id;
    }
  }
}
```

### 1.4 SKILL.md 中的 flow 定义

SkillFlow 定义写在 SKILL.md 的 frontmatter 中，或者作为独立的 `flow.yaml` 文件放在 Skill 目录下：

```
my-deploy-skill/
├── SKILL.md           # 机器版（含 frontmatter）
├── flow.yaml          # SkillFlow 流水线定义（可选）
├── README.md          # 人类版
└── references/        # 按需加载的详细文档
```

`flow.yaml` 示例：

```yaml
# 部署流水线：构建 → 用户确认 → 部署 → 验证
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
exitNodeId: verify-complete
maxTotalIterations: 20
```

### 1.5 SkillFlow 与 Compose Pipeline 的关系

| 维度 | Compose Pipeline | SkillFlow |
|------|-----------------|-----------|
| 适用范围 | 全局工作模式（需求→编码→测试→审查） | 单个 Skill 内部的流水线 |
| 流转机制 | 关键词匹配（"完成"字符串） | 引擎控制 + checkpoint 检查 |
| 节点类型 | 固定四阶段 | step/checkpoint/user-gate/loop/branch |
| 用户控制 | 无暂停 | user-gate 节点暂停等待确认 |
| 失败处理 | 无 | retry/abort/goto |
| 检查节点 | 无 | LLM judge / 正则 / 工具输出检查 |

**不替代关系**：SkillFlow 不替代 Compose Pipeline，两者是不同粒度的编排。Compose Pipeline 是会话级编排，SkillFlow 是 Skill 级编排。一个 Compose 编码阶段可以触发一个带 SkillFlow 的 Skill，由 SkillFlow 控制该 Skill 内部的执行流程。

### 1.6 测试要求

- 无 flow 定义的 Skill 正常走提示词注入模式（向后兼容）。
- 有 flow 定义的 Skill 进入 SkillFlow 模式，按节点顺序执行。
- step 节点只把当前节点 prompt 注入 system prompt，AI 看不到后续节点。
- checkpoint 节点 llm-judge 正确判断通过/不通过。
- checkpoint 节点 regex-match 正确匹配。
- checkpoint 不通过时按 onFailure=retry 重试。
- checkpoint 不通过时按 onFailure=abort 终止流水线。
- checkpoint 不通过时按 onFailure=goto 跳转到指定节点。
- user-gate 节点暂停流水线，等待用户确认后继续。
- user-gate 节点用户拒绝时终止流水线。
- loop 节点重复执行直到条件满足。
- loop 节点达到 maxIterations 时终止。
- 总迭代次数达到上限时终止。
- 工具白名单正确限制每个节点的可用工具。
- 吸因子引导提示被正确注入到每个 step 节点的 system prompt。
- 任务中断后重启从断点节点继续，已通过节点不重跑。
- 任务中断恢复时校验节点输出哈希，不一致则标记 stale 并重跑该节点。
- 节点粒度检查器拒绝 prompt 期望产出超过 2-5 分钟工作量的 step 节点。

### 1.7 吸因子引导层（Attractor）

知识库原文（`主题-AI项目长期迭代`）：

> "Harness 是约束，吸因子是引导。把 AI 视作团队，通过引导而非约束使其收敛到稳定状态。"

SkillFlow 的 checkpoint / onFailure / maxIterations 都是"约束层"——告诉 AI 不能做什么、做错了怎么办。但知识库指出，纯约束会让 AI"被动合规"而非"主动收敛"。吸因子引导层在约束之上叠加"引导"：

```typescript
// src/skills/attractor.ts

/**
 * 吸因子引导层——在约束之上叠加引导，让 AI 主动向期望状态收敛
 *
 * 知识库要求：
 *   - Harness 是约束（checkpoint / gate / 质量门）
 *   - 吸因子是引导（示范 / 目标画像 / 风格样本）
 *   - 约束让 AI 不犯错，引导让 AI 主动做对
 *
 * 实现：
 *   - 每个 step 节点的 prompt 末尾自动追加"吸因子提示"
 *   - 吸因子提示包含：目标画像（什么样算"做对了"）+ 风格样本（参照打样）
 *   - 引导而非命令：用"期望产出"而非"禁止事项"的表述
 */
export class AttractorInjector {
  /**
   * 为节点 prompt 追加吸因子引导
   *
   * 对比：
   *   约束式（checkpoint）："如果构建失败，重试"
   *   引导式（吸因子）："期望产出：构建产物路径 + 成功日志。
   *                     参照样本：项目根目录的 build-sample.txt。
   *                     做到这个样子就算成功。"
   */
  inject(node: FlowNode, flow: SkillFlow): string {
    const attractor = [
      `\n\n=== 期望产出（吸因子引导）===`,
      `目标画像：${node.attractor?.desiredOutput ?? '见节点 prompt'}`,
    ];
    if (node.attractor?.styleSample) {
      attractor.push(`风格样本：参照 ${node.attractor.styleSample}`);
    }
    if (node.attractor?.doneCriteria) {
      attractor.push(`完成判定：${node.attractor.doneCriteria}`);
    }
    attractor.push(`=== 吸因子引导结束 ===\n`);
    return node.prompt + attractor.join('\n');
  }
}
```

在 `FlowNode` 中新增可选字段 `attractor`：

```typescript
// 扩展 FlowNode（在 1.2 定义基础上追加）
export interface FlowNode {
  // ... 原有字段 ...
  /** 吸因子引导（可选）——引导而非约束 */
  attractor?: {
    /** 期望产出的画像描述 */
    desiredOutput?: string;
    /** 风格样本路径（打样文件） */
    styleSample?: string;
    /** 明确的完成判定标准（给 AI 看的"做到什么程度算成功"） */
    doneCriteria?: string;
  };
}
```

**与约束层的协同：** 吸因子在 prompt 注入阶段起作用（引导 AI 怎么做），checkpoint 在产出验证阶段起作用（约束 AI 必须达标）。两者不冲突——吸因子降低 AI 走偏概率，checkpoint 兜底防止吸因子失效。

### 1.8 任务中断恢复（来自 SDD 规格驱动）

知识库原文（`主题-AI项目长期迭代` 延伸阅读）：

> "SDD 规格驱动：Plan 与 Design 合并——分开有两个坏处（plan 依赖 design 内容、纯 design 无法从中断恢复），合并后 plan 标注完成/未完成状态，支持任务中断恢复。"

RouteDev 的 SkillFlow 在长流水线（如部署、重构）中可能因会话切换、用户中断、模型超时而中止。必须支持断点续跑：

```typescript
// src/skills/skill-flow-checkpoint-store.ts

/**
 * SkillFlow 任务中断恢复
 *
 * 知识库要求：
 *   - plan 标注完成/未完成状态
 *   - 支持任务中断恢复
 *
 * 实现：
 *   - 每个节点完成（passed）后，把 FlowExecutionContext 持久化到
 *     .routedev/skill-flow/<flow-id>.json
 *   - 重启时检测未完成的 flow，提示用户"是否从断点继续"
 *   - 恢复时校验已通过节点的输出哈希——若文件已变（如用户手动改了代码），
 *     标记为 stale，该节点及其下游全部重跑
 */
export class SkillFlowCheckpointStore {
  /** 持久化执行上下文 */
  async save(flowId: string, ctx: FlowExecutionContext): Promise<void>;

  /** 加载已保存的上下文 */
  async load(flowId: string): Promise<FlowExecutionContext | null>;

  /** 检测中断的 flow */
  async detectInterrupted(): Promise<string[]>;

  /** 恢复执行——从 ctx.currentNodeId 继续，已 passed 的节点跳过 */
  async resume(flowId: string, params: ReActRunParams): AsyncGenerator<FlowEvent>;

  /**
   * 校验已通过节点的输出是否仍然有效
   *
   * 知识库要求："10 万行项目防回归——上下文管理 + 记忆系统 + 幻觉应对"
   * 若中断期间文件被外部修改，重跑该节点而非用过期输出
   */
  async validateCheckpoint(ctx: FlowExecutionContext): Promise<Set<string /* stale node ids */>> {
    // 对每个 passed 节点的输出做哈希校验
    // 哈希不一致 → 加入 stale 集合 → 该节点及下游重跑
  }
}
```

恢复流程：用户重启 RouteDev → 检测到 `.routedev/skill-flow/deploy-2026xxxx.json` 未完成 → 提示"上次部署流水线在第 3 步中断，是否继续？" → 用户确认 → 校验前 2 步输出哈希 → 哈希一致则从第 3 步继续，不一致则从第 1 步重跑。

### 1.9 节点粒度设计原则（2-5 分钟）

知识库原文（`主题-AI项目长期迭代`）：

> "任务粒度 2-5 分钟：太粗 AI 走偏，不好 review；太细上下文频繁切换，效率低。2-5 分钟 = 刚好一次对话能完成。"

SkillFlow 的 step 节点必须遵循此粒度。质量门（Task 3）在验证 SkillFlow 定义时检查节点粒度：

```typescript
// src/skills/node-granularity-checker.ts

/**
 * 节点粒度检查器——确保 step 节点是一次对话能完成的粒度
 *
 * 知识库要求：
 *   - 太粗（>5分钟工作量）：AI 容易走偏，checkpoint 难以判定
 *   - 太细（<2分钟工作量）：上下文频繁切换，SkillFlow 流转开销 > 执行开销
 *   - 2-5 分钟 = 刚好一次 ReAct 循环能完成
 *
 * 启发式判定：
 *   - prompt 中包含"重构整个模块""重写所有""全面"等词 → 疑似太粗
 *   - prompt 期望产出多个文件 + 多个测试 → 疑似太粗
 *   - prompt 仅是"运行某命令并检查输出" → 疑似太细（应合并到上一步）
 */
export class NodeGranularityChecker {
  static check(node: FlowNode): GranularityWarning[] {
    const warnings: GranularityWarning[] = [];
    const coarse = /重构整个|重写所有|全面|complete.*all|refactor.*module/i;
    const fine = /运行.*命令|执行.*脚本|run.*command/i;

    if (node.type === 'step') {
      if (coarse.test(node.prompt)) {
        warnings.push({
          nodeId: node.id,
          level: 'too-coarse',
          message: '节点疑似粒度过粗（>5分钟工作量），建议拆分为多个 step',
        });
      }
      if (fine.test(node.prompt) && !node.allowedTools?.length) {
        warnings.push({
          nodeId: node.id,
          level: 'too-fine',
          message: '节点疑似粒度过细（<2分钟工作量），建议合并到上游 step',
        });
      }
    }
    return warnings;
  }
}
```

**粒度检查是警告而非阻断**——只是提示用户"这个节点可能太粗/太细"，不阻止 SkillFlow 加载。最终是否拆分由用户决定。

---

## Task 2：双循环编排器——内循环 ReAct + 外循环独立验证（≥ 10 测试）

### 2.1 设计理念

知识库原文：

> "Loop Engineering = 双循环：内循环（ReAct）→ 完成任务；外循环（验证/验收）→ 审核结果。"
> "核心转变：将 Human-in-the-loop 替换为 Agent-in-the-loop。人的职责从参与审核执行 → 定义清晰目标、清晰边界、清晰验收标准。"

RouteDev 现状：`GoalVerifier` 和 `CompletionGate` 已经是外循环组件，但：
1. 两者各自为战，没有统一编排
2. `unified-reviewer` 用同一模型做代码审查（自评盲区）
3. 外循环验证不通过后缺少"打回重跑"的闭环机制

### 2.2 双循环编排器

```typescript
// src/agent/dual-loop-orchestrator.ts

/**
 * 双循环编排器——把内循环 ReAct 和外循环验证统一编排
 *
 * 知识库要求：
 *   - 内循环：ReAct 完成任务（执行 Agent）
 *   - 外循环：独立验证审核结果（验证 Agent）
 *   - 验证不通过 → 打回重跑（形成闭环）
 *   - 执行与验证分离（不同模型，打破自评盲区）
 *
 * Loop 五模块对应：
 *   - 目标来源：/goal 的目标 + 验收条件
 *   - 执行 Agent：内循环 ReActAgentLoop
 *   - 验证 Agent：外循环 GoalVerifier + CompletionGate + 跨模型审查
 *   - 记忆：LoopMemory（失败原因沉淀，见 2.4）
 *   - 终止条件：外循环验证通过 OR 达到最大重跑次数
 */
export class DualLoopOrchestrator {
  /**
   * 运行双循环
   *
   * 流程：
   *   1. 内循环：ReActAgentLoop.run() 执行任务
   *   2. 外循环：GoalVerifier.verify() + CompletionGate.verify() + 跨模型审查
   *   3. 外循环通过 → 完成
   *   4. 外循环不通过 → 把失败原因注入 LoopMemory → 打回内循环重跑
   *   5. 达到最大重跑次数 → 终止并报告
   */
  async *run(params: DualLoopParams): AsyncGenerator<DualLoopEvent> {
    const { goal, maxReruns = 3 } = params;
    let rerunCount = 0;
    const loopMemory = new LoopMemory();

    while (rerunCount < maxReruns) {
      // ===== 内循环：执行任务 =====
      yield { type: 'inner-loop-start', iteration: rerunCount + 1 };

      // 把 LoopMemory 中的历史失败原因注入 system prompt
      const memoryPrompt = loopMemory.buildPrompt();
      const innerParams = {
        ...params.reactParams,
        systemPrompt: (params.reactParams.systemPrompt ?? '') + memoryPrompt,
      };

      let innerResult: InnerLoopResult;
      for await (const event of params.reactLoop.run(innerParams)) {
        yield { type: 'inner-loop-event', event };
        if (event.type === 'done') {
          innerResult = { content: event.content, usage: event.usage };
        }
      }

      // ===== 外循环：独立验证 =====
      yield { type: 'outer-loop-start', iteration: rerunCount + 1 };

      // 2.1 GoalVerifier：LLM 验证目标是否完成
      const verification = await params.goalVerifier.verify(
        goal.plan,
        params.verifierOptions,
        goal.gates,
      );

      // 2.2 CompletionGate：工程化验证（typecheck/lint/tests）
      const gateResult = await params.completionGate.verify({
        modifiedFiles: innerResult.modifiedFiles,
        projectPath: goal.projectPath,
      });

      // 2.3 跨模型审查（打破自评盲区）
      let crossModelReview: CodeReviewResult | undefined;
      if (params.crossModelReviewer) {
        crossModelReview = await params.crossModelReviewer.review({
          modifiedFiles: innerResult.modifiedFiles,
          executionSummary: innerResult.content,
          goalDescription: goal.description,
        });
      }

      // ===== 判定 =====
      const outerPassed = this.evaluateOuterLoop(
        verification,
        gateResult,
        crossModelReview,
      );

      if (outerPassed.passed) {
        yield { type: 'dual-loop-complete', verification, gateResult, crossModelReview };
        return;
      }

      // ===== 不通过：沉淀失败原因到 LoopMemory，打回重跑 =====
      rerunCount++;
      loopMemory.recordFailure({
        iteration: rerunCount,
        reason: outerPassed.reason,
        missingItems: verification.missingItems,
        gateFailures: gateResult.checks.filter(c => !c.ok),
        reviewIssues: crossModelReview?.issues ?? [],
      });

      yield {
        type: 'outer-loop-failed',
        iteration: rerunCount,
        reason: outerPassed.reason,
        suggestion: loopMemory.buildResuggestion(),
      };
    }

    // 达到最大重跑次数
    yield {
      type: 'dual-loop-exhausted',
      maxReruns,
      finalMemory: loopMemory.getHistory(),
    };
  }

  /**
   * 评估外循环结果
   *
   * 知识库要求：仲裁规则
   *   - 默认以 CompletionGate 为准
   *   - 高严重度 reviewer 质疑可推翻 CompletionGate 的 pass
   */
  private evaluateOuterLoop(
    verification: VerificationResult,
    gateResult: GateResult,
    crossModelReview?: CodeReviewResult,
  ): { passed: boolean; reason: string } {
    // CompletionGate 优先
    if (!gateResult.passed) {
      const failedChecks = gateResult.checks.filter(c => !c.ok && !c.skipped);
      return {
        passed: false,
        reason: `工程验证未通过：${failedChecks.map(c => c.name).join(', ')}`,
      };
    }

    // GoalVerifier 判定
    if (!verification.passed) {
      return {
        passed: false,
        reason: `目标未完成：${verification.missingItems.join(', ')}`,
      };
    }

    // 跨模型审查：critical 级别问题可推翻 pass
    if (crossModelReview) {
      const criticalIssues = crossModelReview.issues.filter(i => i.severity === 'critical');
      if (criticalIssues.length > 0) {
        return {
          passed: false,
          reason: `跨模型审查发现 ${criticalIssues.length} 个 critical 问题`,
        };
      }
    }

    return { passed: true, reason: '全部验证通过' };
  }
}
```

### 2.3 跨模型对抗审查

知识库原文：

> "grill-me 核心机制：一个模型写代码，另一个模型专门审查，打破'同一个模型既写又评'的自评盲区。"

```typescript
// src/agent/cross-model-reviewer.ts

/**
 * 跨模型审查器——用不同模型审查代码
 *
 * 知识库要求：
 *   - 写代码的模型不容易发现自己的逻辑漏洞
 *   - 用不同模型可以打破自评盲区
 *   - 已开源（grill-me），可集成到 Skill 体系
 *
 * 实现：
 *   - 接收内循环使用的 modelId
 *   - 自动选择不同的模型做审查（优先选择更强的模型）
 *   - 审查维度：安全性、性能、可读性、边界条件、错误处理
 *   - 输出分级问题（Critical / Warning / Suggestion）
 */
export class CrossModelReviewer {
  /**
   * 选择审查模型——避开内循环使用的模型
   */
  selectReviewerModel(innerLoopModelId: string, availableModels: string[]): string {
    // 优先选择不同提供商的更强模型
    // 若只有一个模型可用，回退到同模型但不同 temperature
    const candidates = availableModels.filter(m => m !== innerLoopModelId);
    if (candidates.length > 0) {
      // 选择最强的
      return this.pickStrongest(candidates);
    }
    return innerLoopModelId; // 回退
  }

  async review(params: {
    modifiedFiles: string[];
    executionSummary: string;
    goalDescription: string;
  }): Promise<CodeReviewResult> {
    // 使用独立 LLM 客户端审查
    // 审查 prompt 包含：
    //   1. 原始目标
    //   2. 变更摘要
    //   3. 变更文件列表
    //   4. 审查维度（安全性/性能/可读性/边界/错误处理）
    //   5. 输出格式（JSON：问题列表 + 严重度 + 文件 + 行号 + 描述 + 修复建议）
  }
}
```

### 2.4 Loop 记忆模块

知识库原文：

> "Loop 五模块：记忆——记录失败原因，循环的'脊柱'。markdown 文件，每轮对话加载。"

```typescript
// src/agent/loop-memory.ts

/**
 * Loop 记忆模块——沉淀双循环中的失败原因
 *
 * 知识库要求：
 *   - 记录失败原因，循环的"脊柱"
 *   - 每轮对话加载
 *   - 失败信息必须整合到下一轮
 *
 * 实现：
 *   - 每次外循环验证不通过，记录失败原因
 *   - 内循环重跑时，把历史失败原因注入 system prompt
 *   - 文件持久化到 .routedev/loop-memory/<goal-id>.md
 *   - /goal 完成后归档到 .routedev/loop-memory/archived/
 */
export class LoopMemory {
  private failures: LoopFailure[] = [];

  /** 记录一次外循环验证失败 */
  recordFailure(failure: LoopFailure): void {
    this.failures.push(failure);
    this.persist();
  }

  /**
   * 构建 system prompt 注入文本
   *
   * 知识库要求："失败信息必须整合到下一轮"
   */
  buildPrompt(): string {
    if (this.failures.length === 0) return '';

    const parts: string[] = ['\n\n=== 历史失败记录（请避免重复犯错）==='];
    for (const f of this.failures) {
      parts.push(`\n【第 ${f.iteration} 次尝试失败】`);
      parts.push(`原因：${f.reason}`);
      if (f.missingItems.length > 0) {
        parts.push(`缺失项：${f.missingItems.join(', ')}`);
      }
      if (f.gateFailures.length > 0) {
        parts.push(`工程验证失败：${f.gateFailures.map(g => g.name).join(', ')}`);
      }
      if (f.reviewIssues.length > 0) {
        parts.push(`审查问题：`);
        for (const issue of f.reviewIssues) {
          parts.push(`  - [${issue.severity}] ${issue.file}: ${issue.description}`);
        }
      }
    }
    parts.push('\n=== 失败记录结束 ===\n');
    return parts.join('\n');
  }

  /** 构建重新建议（给用户的提示） */
  buildResuggestion(): string {
    if (this.failures.length === 0) return '';
    const latest = this.failures[this.failures.length - 1];
    return `上次失败原因：${latest.reason}。建议重点关注：${latest.missingItems.join(', ')}`;
  }

  /** 持久化到文件 */
  private persist(): void {
    // 写入 .routedev/loop-memory/<goal-id>.md
  }
}
```

### 2.5 不直接修改 AI 代码，让 AI 自己改

知识库原文（`主题-AI项目长期迭代` 整合的方法论）：

> "不直接修改 AI 的代码，让它自己改。"（发发 6 步 Stack Coding）
> "AI 兜底不告知 → 累积大量'看起来对但实际错'的代码。"（失败模式）

这条原则对双循环编排器的重跑机制有直接约束：外循环验证不通过、打回内循环重跑时，**不能由人工或外部脚本直接修改 AI 的产出**，而必须把失败原因（LoopMemory）注入 system prompt，让 AI 自己基于反馈修正。

```typescript
// src/agent/dual-loop-orchestrator.ts（扩展 2.2 的 DualLoopOrchestrator）

/**
 * 重跑约束：让 AI 自己改
 *
 * 知识库要求：
 *   - 不直接修改 AI 代码，让 AI 自己改
 *   - 人工介入会破坏 LoopMemory 的反馈闭环
 *   - AI 自己改才能沉淀"为什么这样改"到记忆
 *
 * 实现要点：
 *   1. 外循环不通过 → LoopMemory.recordFailure() 记录原因
 *   2. 重跑的 system prompt 追加 LoopMemory.buildPrompt()
 *   3. 重跑时禁止外部 patch/hotfix——内循环必须从上次的失败点重新执行
 *   4. 若用户手动改了代码（检测到 git diff 非内循环产出），
 *      标记为"人工介入"，LoopMemory 记录但不再自动重跑，
 *      改为提示用户"检测到人工修改，是否由 AI 接管继续？"
 */
```

**例外：** 当外循环连续 `maxReruns` 次失败且 LoopMemory 显示"同一原因重复失败"时，说明 AI 已陷入死循环，此时允许用户接管（Pilot 模式）——这呼应知识库的"AI 走不通时立即接管，降级方案必须显式确认"。接管不是默认行为，而是显式触发，且接管后 LoopMemory 仍记录失败原因供下次参考。

### 2.6 测试要求

- 双循环编排器在内循环完成后自动触发外循环验证。
- 外循环通过时正常完成。
- 外循环不通过时打回内循环重跑。
- LoopMemory 的失败记录被注入到重跑的 system prompt 中。
- 达到 maxReruns 时终止并报告。
- CompletionGate 失败时外循环判定不通过。
- GoalVerifier 失败时外循环判定不通过。
- 跨模型审查的 critical 问题推翻 CompletionGate 的 pass。
- 跨模型审查器选择与内循环不同的模型。
- LoopMemory 持久化到文件且可重新加载。
- 重跑时检测到人工修改（git diff 非内循环产出）则标记"人工介入"并停止自动重跑，提示用户接管。
- 连续 maxReruns 次同一原因失败时提示用户接管（Pilot 模式）。

---

## Task 3：Skill 质量门——3 场景验证 + JSON Schema 校验 + 兜底审查（≥ 8 测试）

### 3.1 设计理念

知识库原文：

> "Skill 写完必跑 3 场景验证：1. 正常请求 2. 边界请求 3. 诱导请求。3 条都稳住 = Skill 算合格。"
> "AI 在 Skill 执行失败时会自己'兜底'——这是最大风险。兜底方案必须显式确认。"
> "Skill 中的每个 fallback 都要有'询问用户'步骤。"

### 3.2 3 场景验证器

```typescript
// src/skills/skill-validator.ts

/**
 * Skill 3 场景验证器
 *
 * 知识库要求：
 *   1. 正常请求：Skill 在预期场景下正确执行
 *   2. 边界请求：Skill 在边界条件下不崩溃
 *   3. 诱导请求：Skill 在恶意输入下不降级、不越界
 *
 * 验证结果：
 *   - passed：3 场景全部通过
 *   - warning：部分场景未通过但不危险
 *   - failed：存在危险场景未通过
 */
export class SkillValidator {
  /**
   * 执行 3 场景验证
   *
   * @param skill 待验证的 Skill
   * @param testCases 可选：用户提供的测试用例；未提供时用 LLM 自动生成
   */
  async validate(
    skill: ParsedSkill,
    testCases?: SkillTestCases,
  ): Promise<SkillValidationResult> {
    // 若未提供测试用例，用 LLM 根据 Skill 描述自动生成
    const cases = testCases ?? await this.generateTestCases(skill);

    const results = {
      normal: await this.runTestCase(skill, cases.normal, 'normal'),
      boundary: await this.runTestCase(skill, cases.boundary, 'boundary'),
      adversarial: await this.runTestCase(skill, cases.adversarial, 'adversarial'),
    };

    return this.aggregateResults(results);
  }

  /**
   * 运行单个测试场景
   *
   * 判定标准：
   *   - normal：Skill 被正确触发且输出符合预期
   *   - boundary：Skill 不崩溃，对边界输入有合理处理
   *   - adversarial：Skill 不降级、不越界、不执行危险操作
   */
  private async runTestCase(
    skill: ParsedSkill,
    testCase: SkillTestCase,
    scenario: 'normal' | 'boundary' | 'adversarial',
  ): Promise<ScenarioResult> {
    // 1. 检查 Skill 是否被正确触发（关键词匹配）
    const triggered = this.checkTrigger(skill, testCase.input);

    // 2. 检查 Skill 输出是否符合预期
    const outputValid = await this.checkOutput(skill, testCase.input, testCase.expectedBehavior);

    // 3. 诱导场景额外检查：是否有兜底确认、是否越界
    let safetyCheck = true;
    if (scenario === 'adversarial') {
      safetyCheck = this.checkSafety(skill, testCase.input);
    }

    return {
      scenario,
      triggered,
      outputValid,
      safetyCheck,
      passed: triggered && outputValid && safetyCheck,
    };
  }

  /**
   * 安全检查——诱导场景专用
   *
   * 知识库要求：
   *   - Skill 中的每个 fallback 都要有"询问用户"步骤
   *   - AI 在 Skill 执行失败时会自己"兜底"——这是最大风险
   */
  private checkSafety(skill: ParsedSkill, input: string): boolean {
    // 检查 Skill body 中是否有兜底确认声明
    const hasFallbackConfirmation = /如果做不到|停止并询问|不要降级|ask.user|确认|confirm/i
      .test(skill.content);

    // 检查 Skill body 中是否有禁止清单
    const hasProhibitionList = /禁止|不要|DON'T|禁止清单/i
      .test(skill.content);

    return hasFallbackConfirmation;
  }
}
```

### 3.3 兜底确认检查

```typescript
// src/skills/fallback-checker.ts

/**
 * Skill 兜底确认检查器
 *
 * 知识库原文：
 *   "AI 在 Skill 执行失败时会自己'兜底'——这是最大风险。"
 *   "兜底方案必须显式确认。"
 *   "Skill 中的每个 fallback 都要有'询问用户'步骤。"
 *
 * 检查规则：
 *   1. Skill body 中至少包含一个兜底声明
 *   2. 每个兜底声明必须包含"询问用户"或"停止"的指令
 *   3. 不能有"自动降级"或"默默回退"的表述
 */
export class FallbackChecker {
  /** 兜底声明关键词 */
  private static readonly FALLBACK_KEYWORDS = /如果做不到|如果失败|如果无法|if.fail|fallback|出错时|异常时/i;

  /** 兜底确认关键词（必须与兜底声明配对出现） */
  private static readonly CONFIRM_KEYWORDS = /停止并询问|不要降级|ask.user|请用户确认|abort.and.ask/i;

  /** 危险降级关键词（不应出现） */
  private static readonly DANGEROUS_FALLBACK = /自动降级|默默回退|直接跳过|忽略错误继续/i;

  static check(skill: ParsedSkill): FallbackCheckResult {
    const content = skill.content;
    const issues: string[] = [];

    // 检查是否有兜底声明
    const hasFallback = FallbackChecker.FALLBACK_KEYWORDS.test(content);
    if (hasFallback) {
      // 有兜底声明 → 检查是否有配对的确认指令
      const hasConfirm = FallbackChecker.CONFIRM_KEYWORDS.test(content);
      if (!hasConfirm) {
        issues.push('Skill 包含兜底声明但缺少"询问用户"或"停止"的确认指令');
      }
    }

    // 检查是否有危险降级表述
    const hasDangerous = FallbackChecker.DANGEROUS_FALLBACK.test(content);
    if (hasDangerous) {
      issues.push('Skill 包含危险的自动降级表述（如"自动降级""默默回退"），应改为询问用户');
    }

    return {
      passed: issues.length === 0,
      issues,
    };
  }
}
```

### 3.4 JSON Schema 校验

知识库原文：

> "JSON Schema 校验：除 markdown 描述外，用 JSON 定义 skill 的 name/description/scope。Hook 脚本校验字段完整性，防止 skill 缺失关键信息。"

```typescript
// src/skills/skill-schema-validator.ts

/**
 * Skill JSON Schema 校验器
 *
 * 知识库要求：
 *   - 用 JSON Schema 校验 skill 的 name/description/scope
 *   - Hook 脚本校验字段完整性
 *   - 防止 skill 缺失关键信息
 */
export const SKILL_JSON_SCHEMA = {
  type: 'object',
  required: ['name', 'description'],
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 2, maxLength: 64 },
    description: { type: 'string', minLength: 10, maxLength: 200 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    author: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    // Skill 5 部分结构（知识库要求）
    scope: {
      type: 'object',
      properties: {
        triggers: { type: 'array', items: { type: 'string' } },   // 触发条件
        exclusions: { type: 'array', items: { type: 'string' } }, // 排除项
      },
    },
    flow: { type: 'object' }, // SkillFlow 定义（Task 1）
  },
};

export class SkillSchemaValidator {
  static validate(skill: ParsedSkill): SchemaValidationResult {
    // 校验 frontmatter 字段完整性
    // 校验 name 格式（kebab-case）
    // 校验 description 长度
    // 校验 tags 数量
    // 返回缺失字段列表
  }
}
```

### 3.5 质量门集成

在 Skill 生成器和市场导入时自动运行质量门：

```typescript
// src/skills/quality-gate.ts

/**
 * Skill 质量门——在生成/导入时自动运行
 *
 * 三层检查：
 *   1. Schema 校验（结构完整性）
 *   2. 兜底确认检查（安全性）
 *   3. 3 场景验证（功能性，可选——需要 LLM 调用）
 *
 * 结果：
 *   - pass：全部通过
 *   - warn：有警告但无危险（如缺少 README 人类版）
 *   - fail：有危险问题（如缺少兜底确认、诱导场景失败）
 */
export class SkillQualityGate {
  async check(skill: ParsedSkill, options: {
    runScenarioValidation?: boolean; // 是否运行 3 场景验证（需要 LLM 调用）
  }): Promise<QualityGateResult> {
    // 1. Schema 校验
    const schemaResult = SkillSchemaValidator.validate(skill);

    // 2. 兜底确认检查
    const fallbackResult = FallbackChecker.check(skill);

    // 3. 3 场景验证（可选）
    let scenarioResult: SkillValidationResult | undefined;
    if (options.runScenarioValidation) {
      scenarioResult = await new SkillValidator().validate(skill);
    }

    // 聚合判定
    if (!schemaResult.valid || !fallbackResult.passed) {
      return { status: 'fail', schema: schemaResult, fallback: fallbackResult, scenario: scenarioResult };
    }
    if (scenarioResult && !scenarioResult.passed) {
      return { status: 'fail', schema: schemaResult, fallback: fallbackResult, scenario: scenarioResult };
    }
    return { status: 'pass', schema: schemaResult, fallback: fallbackResult, scenario: scenarioResult };
  }
}
```

### 3.6 模型升级重新校验（prompt 漂移检测）

知识库原文（`主题-AI独立创业` 延伸阅读）：

> "模型升级后，原有 prompt 可能失效，需要持续维护。"

RouteDev 的 Skill 质量门在生成/导入时运行一次，但模型升级后 Skill 的行为可能漂移——原本通过的 3 场景验证可能在新模型上失败。必须检测模型版本变更并重新校验：

```typescript
// src/skills/model-drift-detector.ts

/**
 * 模型漂移检测器——模型升级后重新运行质量门
 *
 * 知识库要求：
 *   - 模型升级后 prompt 可能失效
 *   - 需要持续维护
 *
 * 实现：
 *   - 记录每个 Skill 上次通过质量门时的模型版本（skill.metadata.lastValidatedModel）
 *   - 启动时比对当前模型版本与 lastValidatedModel
 *   - 不一致 → 标记 Skill 为"待重新校验"，下次使用时提示用户
 *   - 用户确认后重新运行 3 场景验证
 */
export class ModelDriftDetector {
  /**
   * 检测模型漂移
   *
   * @returns 需要重新校验的 Skill 列表
   */
  detectDrift(installedSkills: ParsedSkill[], currentModelVersion: string): DriftResult[] {
    return installedSkills
      .filter(s => s.metadata.lastValidatedModel !== currentModelVersion)
      .map(s => ({
        skillName: s.metadata.name,
        lastValidatedModel: s.metadata.lastValidatedModel ?? 'unknown',
        currentModelVersion,
        severity: this.assessDriftSeverity(s.metadata.lastValidatedModel, currentModelVersion),
      }));
  }

  /** 漂移严重度：同系列小版本升级=low，跨代升级=high */
  private assessDriftSeverity(oldVer: string | undefined, newVer: string): 'low' | 'high' {
    if (!oldVer) return 'high';
    // 同主版本 = low；跨主版本 = high
    const oldMajor = oldVer.split('.')[0];
    const newMajor = newVer.split('.')[0];
    return oldMajor === newMajor ? 'low' : 'high';
  }
}
```

**与在线监控的关系：** 模型漂移检测是"一次性校验"，在线监控（Task 5）的"漂移信号"是"运行时统计"。两者互补——漂移检测在启动时发现版本变更，在线监控在运行中发现行为分布变化。

### 3.7 兜底不告知检查（失败模式防御）

知识库原文（`主题-AI项目长期迭代` 失败模式表）：

> "AI 兜底不告知 → 累积大量'看起来对但实际错'的代码。"

3.3 的 FallbackChecker 检查 Skill 文本中是否有兜底声明配对确认指令。3.7 进一步检查 **运行时兜底行为**——Skill 执行中 AI 是否默默降级：

```typescript
// src/skills/runtime-fallback-detector.ts

/**
 * 运行时兜底检测器——检测 AI 在 Skill 执行中是否默默降级
 *
 * 知识库要求：
 *   - "AI 兜底不告知"是失败模式
 *   - 兜底方案必须显式确认
 *
 * 实现：
 *   - 监听 SkillFlow 的事件流
 *   - 检测 AI 输出中的"兜底信号词"：改用、回退、降级、跳过、暂时、先用...代替
 *   - 检测到兜底信号 → 检查是否伴随"已询问用户"或"等待确认"
 *   - 未询问就兜底 → 标记为违规，记录到质量审计日志
 */
export class RuntimeFallbackDetector {
  private static readonly FALLBACK_SIGNALS = /改用|回退到|降级为|跳过.{0,4}步骤|暂时使用|先用.{0,8}代替|简化处理/i;
  private static readonly CONFIRM_SIGNALS = /询问用户|请用户确认|等待确认|已告知用户|abort.*ask/i;

  /** 检测单条 AI 输出是否有未告知的兜底 */
  static detect(output: string): FallbackViolation | null {
    if (this.FALLBACK_SIGNALS.test(output) && !this.CONFIRM_SIGNALS.test(output)) {
      const matched = output.match(this.FALLBACK_SIGNALS)?.[0] ?? '';
      return {
        type: 'silent-fallback',
        signal: matched,
        excerpt: output.slice(0, 200),
        suggestion: '检测到 AI 默默兜底，请确认是否已告知用户',
      };
    }
    return null;
  }
}
```

**集成点：** RuntimeFallbackDetector 作为 SkillFlow 引擎的中间件，在每个 step 节点输出后检测。检测到违规时 yield 一个 `fallback-violation` 事件，由上层 UI 提示用户。

### 3.8 测试要求

- Schema 校验通过合法 Skill。
- Schema 校验拒绝缺失 name 的 Skill。
- Schema 校验拒绝 name 不符合 kebab-case 的 Skill。
- 兜底确认检查通过包含"停止并询问"的 Skill。
- 兜底确认检查拒绝包含"自动降级"的 Skill。
- 3 场景验证正常场景通过。
- 3 场景验证诱导场景拒绝不安全的 Skill。
- 质量门 fail 时阻止 Skill 加载并提示用户。
- 模型漂移检测器在模型版本变更时标记 Skill 为"待重新校验"。
- 跨主版本升级标记为 high 严重度，同主版本小升级标记为 low。
- 运行时兜底检测器检测到"改用/回退/降级"且无确认信号时报告违规。
- 运行时兜底检测器对伴随"询问用户"的兜底不报告违规。

---

## Task 4：上下文占用率可视化与结构化注入（≥ 8 测试）

### 4.1 设计理念

知识库原文：

> "一次简单问候消耗 3.8 万 token（~20%）；一份数据分析报告消耗 10 万 token（~50%）。"
> "关注每次对话后的上下文占用率，及时压缩/清理/新开会话，避免 Agent 在上下文临界区'失忆'。"
> "大海捞针问题：达到阈值后效果下降 → 解法：结构化文件解析（先脚本解析，不全量读取）。"

RouteDev 现状：`context-compaction.ts` 已有 L1-L5 渐进压缩和三级阈值（50%/80%/90%），但：
1. 50% 的 soft_notify 只记录日志，用户不可见
2. 文件引用（Phase 48）直接 read_file 全量读取，未做结构化解析

### 4.2 上下文占用率面板

```typescript
// src/agent/context-usage-panel.ts

/**
 * 上下文占用率面板——把 context-compaction 的 soft_notify 推送到 UI
 *
 * 知识库要求：
 *   - 关注每次对话后的上下文占用率
 *   - 及时压缩/清理/新开会话
 *   - 避免 Agent 在上下文临界区"失忆"
 *
 * 实现：
 *   - 每轮 ReAct 迭代后计算上下文占用率
 *   - 50%：状态栏显示黄色"上下文使用 50%"
 *   - 80%：状态栏显示橙色"上下文使用 80%，建议压缩"
 *   - 90%：状态栏显示红色"上下文使用 90%，即将强制压缩"
 *   - 引用系统（Phase 48）在添加引用时预估 token 占用
 */
export interface ContextUsageInfo {
  /** 当前 token 数 */
  currentTokens: number;
  /** 上下文窗口大小 */
  maxTokens: number;
  /** 占用率 */
  usagePercent: number;
  /** 分项占用 */
  breakdown: {
    systemPrompt: number;
    conversationHistory: number;
    toolResults: number;
    references: number;  // Phase 48 引用系统占用的 token
    skillPrompts: number;
  };
  /** 建议动作 */
  suggestion: 'ok' | 'consider-compaction' | 'should-compact' | 'must-compact';
}
```

在 ChatView 状态栏中显示上下文占用率指示器：

```
[══════════════░░░░░░░░░░] 52% ── 建议压缩
```

### 4.3 文件引用结构化注入

知识库原文：

> "大海捞针问题：达到阈值后效果下降 → 解法：结构化文件解析（先脚本解析，不全量读取）。"

```typescript
// src/cite/structured-injector.ts

/**
 * 文件引用结构化注入器
 *
 * 知识库要求：
 *   - 不全量读取文件
 *   - 先用代码地图 / tree-sitter 提取相关符号块
 *   - 再注入带标注的上下文
 *
 * 与 Phase 48 CiteResolver 的关系：
 *   - CiteResolver 生成 preflight 的 read_file 调用
 *   - StructuredInjector 在 read_file 返回后，做结构化裁剪
 *   - 只注入与当前对话相关的符号块，而非全文
 */
export class StructuredInjector {
  /**
   * 结构化注入文件内容
   *
   * 流程：
   *   1. CiteResolver 生成 read_file preflight
   *   2. read_file 返回全文
   *   3. StructuredInjector 调用 code-map 查询相关符号
   *   4. 只保留相关符号块 + 文件结构概览
   *   5. 注入到上下文
   */
  async injectFileReference(
    filePath: string,
    conversationContext: string,
    maxTokens: number,
  ): Promise<InjectedFileContent> {
    // 1. 获取文件结构概览（符号列表）
    const structure = await this.codeMap.getFileStructure(filePath);

    // 2. 根据对话上下文查询相关符号
    const relevantSymbols = await this.codeMap.queryRelevantSymbols(
      filePath,
      conversationContext,
    );

    // 3. 只读取相关符号的代码块
    const blocks = await this.extractSymbolBlocks(filePath, relevantSymbols);

    // 4. 组装注入内容：结构概览 + 相关代码块
    const injected = this.formatInjection(structure, blocks, maxTokens);

    return {
      filePath,
      structureOverview: structure,
      injectedBlocks: blocks,
      totalTokens: this.estimateTokens(injected),
      truncated: blocks.length < relevantSymbols.length,
    };
  }
}
```

### 4.4 渐进式披露

知识库原文：

> "渐进式披露：先给 AI 最少必要信息，根据反馈逐步补充，避免一次性塞入过多 context 导致 AI 注意力分散。"

```typescript
// src/skills/progressive-disclosure.ts

/**
 * Skill 渐进式披露
 *
 * 知识库要求：
 *   - 先给 AI 最少必要信息（SKILL.md body 的核心原则 + 适用范围）
 *   - 根据反馈逐步补充（references/ 中的详细文档按需加载）
 *   - 避免一次性塞入过多 context
 *
 * 与 SkillFlow 的关系：
 *   - SkillFlow 的每个 step 节点只注入当前步骤的 prompt
 *   - references/ 中的文件按 step 节点的需求加载
 *   - 不在 Skill 触发时就全量加载所有 references
 */
export class ProgressiveDisclosure {
  /**
   * 计算 Skill 触发时的最小注入集
   */
  getMinimalInjection(skill: ParsedSkill): string {
    // 只注入 frontmatter + body 的"核心原则"和"适用范围"部分
    // 不注入"任务路由"和"模块索引"（按需加载）
    const sections = this.splitSections(skill.content);
    const minimal = [
      sections.get('核心原则'),
      sections.get('适用范围'),
    ].filter(Boolean).join('\n\n');
    return minimal;
  }

  /**
   * 按需加载 references
   */
  async loadReference(
    skill: ParsedSkill,
    referenceName: string,
  ): Promise<string> {
    // 从 skill 目录的 references/ 下读取指定文件
    // 只在 SkillFlow 的 step 节点需要时加载
  }
}
```

### 4.5 打样注入（Style Sample Injection）

知识库原文（`主题-AI项目长期迭代` 延伸阅读——团队级 Harness 工程）：

> "打样工程：定义代码框架和规范，AI 参照打样写出风格一致的代码，产出比程序员手写更整洁。"

打样工程是吸因子（1.7）在上下文层面的具体落地——不是告诉 AI"不要写错"，而是给 AI 一个"写对了长什么样"的样本。RouteDev 的代码地图（Phase 41/42）+ 引用系统（Phase 48）天然适合做打样注入：

```typescript
// src/cite/style-sample-injector.ts

/**
 * 打样注入器——把项目中的样板代码作为风格引导注入上下文
 *
 * 知识库要求：
 *   - 定义代码框架和规范
 *   - AI 参照打样写出风格一致的代码
 *   - 产出比程序员手写更整洁
 *
 * 与吸因子（1.7）的关系：
 *   - 吸因子是 SkillFlow 节点级的引导（每个 step 的 attractor 字段）
 *   - 打样注入是上下文级的引导（把样板代码注入到对话上下文）
 *   - 两者协同：吸因子告诉 AI"做到什么程度算成功"，
 *     打样注入告诉 AI"成功的样子长什么样"
 *
 * 实现：
 *   - 用户在 .routedev/style-samples/ 下放置样板文件
 *   - 或由代码地图自动识别项目中的"高代表性文件"作为打样
 *   - SkillFlow 的 step 节点若声明 attractor.styleSample，
 *     注入器把对应样板代码注入上下文
 *   - 注入时标注"【风格样本，参照其结构/命名/错误处理风格，勿照抄业务逻辑】"
 */
export class StyleSampleInjector {
  /**
   * 注入打样代码
   *
   * @param samplePath 样板文件路径（来自 node.attractor.styleSample）
   * @param maxTokens 打样注入的 token 上限（默认 1500，避免占用过多上下文）
   */
  async injectStyleSample(
    samplePath: string,
    maxTokens = 1500,
  ): Promise<StyleSampleInjection> {
    // 1. 读取样板文件
    const content = await this.readFile(samplePath);

    // 2. 用代码地图提取结构概览（符号列表 + 类签名 + 函数签名）
    const structure = await this.codeMap.getFileStructure(samplePath);

    // 3. 截断到 maxTokens
    const truncated = this.truncate(content, maxTokens);

    // 4. 组装注入文本——明确标注是"风格样本"而非"待修改的代码"
    const injected = [
      `【风格样本：参照此文件的结构/命名/错误处理风格，勿照抄业务逻辑】`,
      `文件：${samplePath}`,
      `结构概览：${structure.summary}`,
      '```',
      truncated,
      '```',
    ].join('\n');

    return {
      injected,
      tokens: this.estimateTokens(injected),
      truncated: truncated.length < content.length,
    };
  }

  /**
   * 自动识别项目中的打样文件
   *
   * 启发式：项目根目录的 README、入口文件、基础类/接口
   * 通常能代表项目风格
   */
  async autoDetectSamples(projectPath: string): Promise<string[]> {
    // 扫描 src/ 下的入口文件、基础接口、配置示例
    // 返回 3-5 个最具代表性的文件
  }
}
```

**与结构化注入（4.3）的区别：** 4.3 的 StructuredInjector 是"按需注入相关符号块"（解决大海捞针），4.5 的 StyleSampleInjector 是"主动注入风格样本"（引导 AI 写出风格一致的代码）。前者是精准裁剪，后者是主动引导。

**配置：** 用户可在 `.routedev/style-samples/` 下放置样板文件，或在 SkillFlow 节点的 `attractor.styleSample` 字段指定路径。未配置时不注入，不强制。

### 4.6 测试要求

- 上下文占用率在 50% 时显示黄色建议。
- 上下文占用率在 80% 时显示橙色警告。
- 上下文占用率在 90% 时显示红色强制。
- 占用率分项统计正确（system prompt / 历史 / 工具结果 / 引用 / Skill）。
- 文件引用结构化注入只返回相关符号块。
- 文件引用超过 maxTokens 时截断并标注。
- 渐进式披露只注入核心原则和适用范围。
- 渐进式披露按需加载 references 文件。
- 打样注入器把样板代码标注为"风格样本"注入上下文。
- 打样注入超过 maxTokens 时截断并标注 truncated。
- 打样注入器自动识别项目入口文件作为打样候选。

---

## Task 5：评估集框架与在线监控（≥ 8 测试）

### 5.1 设计理念

知识库原文：

> "评估集是生产化的灵魂——没有评估集就不叫工程化。95% 的 AI 工程师能做原型，能上生产的 5% 才拿高薪。"
> "评估集三层：Smoke set(30条, PR门禁) / Regression set(100条, 每日跑) / Comprehensive set(500条, 每周跑)。"
> "在线监控 7 类信号：延迟/成本/质量/错误率/安全/用户反馈/漂移。"

RouteDev 不是 SaaS 平台，评估集主要面向 Skill 质量回归和 /goal 执行质量。规模缩小为 Smoke(10)/Regression(30)。

### 5.2 评估集框架

```typescript
// src/evaluation/evaluation-framework.ts

/**
 * 评估集框架
 *
 * 知识库三层设计（RouteDev 缩小规模）：
 *   - Smoke set(10条)：Skill 安装/更新时运行，2分钟出结果
 *   - Regression set(30条)：/goal 完成后运行，防退化
 *
 * 评估方式：
 *   - LLM-as-Judge（用跨模型评审，避免自我偏好）
 *   - Rubric 五要素（标准明确/区分优劣/正反事例/边界说明/覆盖核心）
 */
export interface EvaluationCase {
  id: string;
  /** 测试输入 */
  input: string;
  /** 期望行为描述（不是精确输出，而是行为约束） */
  expectedBehavior: string;
  /** 场景类型 */
  scenario: 'normal' | 'boundary' | 'adversarial';
  /** Rubric 评分标准 */
  rubric: {
    criterion: string;
    weight: number;
  }[];
}

export class EvaluationFramework {
  /**
   * 运行评估集
   *
   * 知识库要求：
   *   - LLM-as-Judge 五大陷阱：位置偏差/长度偏差/自我偏好/风格偏差/缺少 ground truth
   *   - 解法：随机排序 + Rubric 明确 + 跨模型评审 + 多维度 Rubric + 标注参考案例
   */
  async runEvaluation(
    cases: EvaluationCase[],
    target: 'skill' | 'goal',
    targetId: string,
  ): Promise<EvaluationReport> {
    // 1. 随机打乱测试用例顺序（避免位置偏差）
    const shuffled = this.shuffle(cases);

    // 2. 对每个用例运行目标（Skill 或 /goal）
    // 3. 用跨模型 LLM-as-Judge 评分（避免自我偏好）
    // 4. 按 Rubric 五要素评分
    // 5. 生成报告
  }
}
```

### 5.3 在线监控信号

```typescript
// src/evaluation/online-monitor.ts

/**
 * 在线监控——7 类信号
 *
 * 知识库要求：
 *   - 延迟：P95 延迟 > 300ms 告警
 *   - 成本：Token 消耗日环比 > 30% 告警
 *   - 质量：错误路由率 > 5% 告警
 *   - 错误率：失败率 > 1% 告警
 *   - 安全：注入尝试次数 任何异常告警
 *   - 用户反馈：差评率 > 10% 告警
 *   - 漂移：意图分布 KL 散度日环比 > 20% 告警
 *
 * 与 ScoreCard 的关系：
 *   - ScoreCard 记录单次执行的质量指标
 *   - OnlineMonitor 聚合 ScoreCard 数据，按时间窗口统计
 *   - 超过阈值时触发告警（日志 + UI 通知）
 */
export class OnlineMonitor {
  /** 延迟监控 */
  monitorLatency(scoreCards: ScoreCard[]): void {
    const p95 = this.calculateP95(scoreCards.map(c => c.durationMs));
    if (p95 > 300) {
      this.alert('latency', `P95 延迟 ${p95}ms 超过阈值 300ms`);
    }
  }

  /** 成本监控 */
  monitorCost(scoreCards: ScoreCard[], yesterdayTotalTokens: number): void {
    const todayTotal = scoreCards.reduce((sum, c) => sum + c.tokenUsage.total, 0);
    const ratio = (todayTotal - yesterdayTotalTokens) / yesterdayTotalTokens;
    if (ratio > 0.3) {
      this.alert('cost', `Token 消耗日环比增长 ${(ratio * 100).toFixed(0)}% 超过 30%`);
    }
  }

  /** 质量监控：错误路由率 */
  monitorQuality(routingErrors: number, totalRequests: number): void {
    const errorRate = routingErrors / totalRequests;
    if (errorRate > 0.05) {
      this.alert('quality', `错误路由率 ${(errorRate * 100).toFixed(1)}% 超过 5%`);
    }
  }
}
```

### 5.4 测试要求

- 评估集框架运行 Smoke set 返回报告。
- 评估集框架运行 Regression set 返回报告。
- LLM-as-Judge 评分时用例顺序被随机打乱。
- 在线监控延迟超过阈值时触发告警。
- 在线监控成本日环比超过 30% 时触发告警。
- 在线监控错误路由率超过 5% 时触发告警。
- ScoreCard 数据被正确聚合到在线监控。
- 评估报告包含 Rubric 评分和通过/失败统计。

---

## Task 6：意图路由增强与五大设计模式覆盖（≥ 8 测试）

### 6.1 设计理念

知识库原文：

> "意图路由四层漏斗：L0 正则(<1ms, 拦截 60-80%) → L1 向量语义(30-100ms, 拦截 15-25%) → L2 大模型(1-2s, 仅 5-15%) → SafeNet(置信度+OOD+熔断, <3%)。"
> "五大核心模式：提示链、路由、并行、反思、护栏——覆盖了从任务拆解到安全防护的完整链路。"

RouteDev 现状：路由器有正则 + 分类器（确定性规则 + LLM 路由），但：
1. 缺少向量语义路由层
2. 缺少 SafeNet（OOD 检测 + 熔断）
3. 提示链模式不明确（Compose Pipeline 有阶段但不等同提示链）
4. 反思模式不明确（GoalVerifier 有验证但不是 Reflection 范式）

### 6.2 意图路由四层漏斗

```typescript
// src/router/routing-funnel.ts

/**
 * 意图路由四层漏斗
 *
 * 知识库要求：
 *   - L0 正则：<1ms，拦截 60-80%
 *   - L1 向量语义：30-100ms，BGE-Small 编码 + 余弦相似度，拦截 15-25%
 *   - L2 大模型：1-2s，仅处理 5-15%
 *   - SafeNet：置信度 + OOD 检测 + 熔断，<3%
 *
 * 效果：延迟降至全 LLM 方案的 1/3，成本降至 1/4。
 */
export class RoutingFunnel {
  /**
   * 四层漏斗路由
   *
   * 四条铁律（知识库）：
   *   1. 规则优先模型兜底
   *   2. 意图用枚举不用自由文本
   *   3. 低置信度反问不瞎猜
   *   4. 上线第一天就埋监控
   */
  async route(input: string): Promise<RoutingResult> {
    // L0：正则匹配（已有 deterministic-rules.ts）
    const l0Result = this.l0RegexRoute(input);
    if (l0Result.confidence > 0.9) return l0Result;

    // L1：向量语义路由（新增，可选——需要 embedding 模型）
    if (this.vectorRouter) {
      const l1Result = await this.l1VectorRoute(input);
      if (l1Result.confidence > 0.85) return l1Result;
    }

    // L2：大模型路由（已有 classifier.ts）
    const l2Result = await this.l2LLMRoute(input);
    if (l2Result.confidence > 0.7) return l2Result;

    // SafeNet：低置信度反问不瞎猜
    return this.safeNet(input, l2Result);
  }

  /**
   * SafeNet——OOD 检测 + 熔断
   *
   * 知识库要求：
   *   - 置信度分级
   *   - OOD（Out-of-Distribution）检测
   *   - 熔断机制
   *   - 低置信度反问不瞎猜
   */
  private safeNet(input: string, llmResult: RoutingResult): RoutingResult {
    // 置信度低于阈值 → 标记为 unknown，让 AI 反问用户
    if (llmResult.confidence < 0.5) {
      return {
        ...llmResult,
        model: { id: 'unknown', provider: 'safe-net' },
        confidence: 0,
        originalTier: 'safe-net',
        needsClarification: true, // 标记需要澄清
      };
    }

    // 熔断：连续 N 次低置信度 → 触发熔断，回退到默认模型
    if (this.consecutiveLowConfidence > 5) {
      this.triggerCircuitBreaker();
    }

    return llmResult;
  }
}
```

### 6.3 提示链与反思模式

```typescript
// src/agent/patterns/prompt-chain.ts

/**
 * 提示链模式——复杂问题拆为串行子问题
 *
 * 知识库原文：
 *   "将复杂任务拆解为串行子问题，每一步输出作为下一步输入。
 *    优势：每一步可调试、可干预、可中断恢复。"
 *
 * 与 SkillFlow 的关系：
 *   - SkillFlow 是提示链的具体实现（节点间串行执行）
 *   - 但 SkillFlow 限用于单个 Skill 内部
 *   - PromptChain 用于跨 Skill 的串行编排
 */
export class PromptChain {
  async *execute(steps: ChainStep[]): AsyncGenerator<ChainEvent> {
    let context = '';
    for (const step of steps) {
      // 每步输入 = 原始输入 + 前一步输出
      const input = step.appendContext ? `${step.input}\n\n前一步结果：${context}` : step.input;
      const result = await this.executeStep(step, input);
      context = result.output;
      yield { type: 'chain-step-complete', step, result };
    }
    yield { type: 'chain-complete', finalOutput: context };
  }
}

// src/agent/patterns/reflection.ts

/**
 * 反思模式——Agent 自我校验输出质量，发现后自动修正
 *
 * 知识库原文：
 *   "Agent 自我校验输出质量，发现问题后自动修正。
 *    生成 → 自我审查 → 发现问题？→ 修正 → 重新审查 → 通过 → 输出。"
 *
 * 与双循环的关系：
 *   - 双循环的外循环就是反思模式的工程化实现
 *   - 内循环 = 生成
 *   - 外循环 = 自我审查 + 修正
 *   - 但 RouteDev 的反思用跨模型，而非同模型自评
 */
export class ReflectionPattern {
  async *run(params: ReflectionParams): AsyncGenerator<ReflectionEvent> {
    let output = params.initialOutput;
    let iteration = 0;

    while (iteration < params.maxReflections) {
      // 审查
      const review = await this.review(output, params.criteria);
      if (review.passed) {
        yield { type: 'reflection-passed', output, iteration };
        return;
      }

      // 修正
      output = await this.revise(output, review.issues, params);
      iteration++;
      yield { type: 'reflection-iteration', output, issues: review.issues, iteration };
    }

    yield { type: 'reflection-exhausted', output, maxIterations: params.maxReflections };
  }
}
```

### 6.4 五大模式覆盖检查

| 模式 | RouteDev 实现 | 状态 |
|------|-------------|------|
| **提示链** | SkillFlow（Task 1）+ PromptChain（Task 6.3） | ✅ 本 Phase 补齐 |
| **路由** | RoutingFunnel 四层漏斗（Task 6.2） | ✅ 本 Phase 增强 |
| **并行** | ReActAgentLoop parallelToolExecution + multi/orchestrator | ✅ 已有 |
| **反思** | 双循环编排器（Task 2）+ ReflectionPattern（Task 6.3） | ✅ 本 Phase 补齐 |
| **护栏** | PermissionEngine + Hook + middleware/loop-detection | ✅ 已有 |

### 6.5 测试要求

- L0 正则路由正确拦截高频意图。
- L2 大模型路由处理 L0/L1 未命中的意图。
- SafeNet 在低置信度时标记 needsClarification。
- SafeNet 连续低置信度时触发熔断。
- PromptChain 串行执行步骤且每步输出传递给下一步。
- ReflectionPattern 审查不通过时自动修正。
- ReflectionPattern 达到 maxReflections 时终止。
- 五大模式覆盖检查通过。

---

## Task 7：集成测试与文档同步（≥ 8 测试）

### 7.1 端到端测试

1. **SkillFlow + 双循环端到端：** 用户创建带 flow 定义的部署 Skill → SkillFlow 引擎逐步执行（构建→用户确认→部署→验证）→ 验证节点不通过 → 打回构建重试 → 全部通过 → 双循环外循环确认完成。
2. **Skill 质量门端到端：** 用户用 Skill 生成器创建 Skill → 质量门检查发现缺少兜底确认 → 标黄并提示用户补充 → 用户补充后质量门通过 → Skill 可正常加载。
3. **上下文占用率端到端：** 用户引用 3 个大文件 → 上下文占用率显示 85% → 结构化注入器只注入相关符号块 → 占用率降到 40% → 对话正常进行。
4. **评估集端到端：** Skill 安装时运行 Smoke set(10条) → 8 条通过 2 条失败 → 报告显示失败用例 → 用户修复后重跑 → 全部通过。
5. **意图路由四层漏斗端到端：** 用户输入"帮我写个函数" → L0 正则未命中 → L1 向量路由命中"编码"意图 → 选择编码模型 → 延迟 < 100ms。
6. **跨模型对抗审查端到端：** 内循环用 DeepSeek 写代码 → 外循环用 Claude 审查 → 发现 critical 问题 → 打回重跑 → LoopMemory 注入失败原因 → 重跑通过。
7. **反思模式端到端：** /goal 执行完成 → ReflectionPattern 审查输出 → 发现遗漏边界情况 → 自动修正 → 重新审查通过。
8. **Loop 记忆端到端：** /goal 第一次执行失败 → LoopMemory 记录失败原因 → 第二次执行时 system prompt 包含失败记录 → 避免重复犯错 → 成功完成。

### 7.2 文档同步

- **SKILLFLOW.md：** SkillFlow 引擎说明、flow.yaml 格式、节点类型、与 Compose Pipeline 的关系。
- **DUAL_LOOP.md：** 双循环架构、内循环/外循环职责、LoopMemory、跨模型审查、仲裁规则。
- **QUALITY_GATE.md：** Skill 质量门、3 场景验证、兜底确认检查、JSON Schema 校验。
- **CONTEXT_USAGE.md：** 上下文占用率面板、结构化注入、渐进式披露。
- **EVALUATION.md：** 评估集框架、在线监控、LLM-as-Judge。
- **ROUTING.md：** 意图路由四层漏斗、SafeNet、五大模式覆盖。
- **CHANGELOG.md：** v4.0.0 条目。
- **config schema：** 新增 `skillFlow.enabled`、`skillFlow.maxTotalIterations`、`dualLoop.maxReruns`、`dualLoop.crossModelReview`、`qualityGate.runOnGenerate`、`qualityGate.runOnImport`、`contextUsage.showPanel`、`evaluation.smokeSetSize`、`evaluation.regressionSetSize`、`routing.vectorEnabled`、`routing.safeNetConfidenceThreshold`。

### 7.3 测试要求

- 8 个端到端测试场景全部通过。
- 文档全部更新且与实现一致。
- config schema 新增字段有默认值且向后兼容。
- v4.0.0 CHANGELOG 条目完整。

---

## 新增陷阱警告

**139. SkillFlow 引擎与 ReActAgentLoop 的嵌套调用可能死锁：** SkillFlow 的 run() 是 AsyncGenerator，内部调用 ReActAgentLoop.run() 也是 AsyncGenerator。若 ReActAgentLoop 在 user-gate 节点等待用户确认时阻塞，整个 generator 管线会卡住。必须用 AbortSignal + 超时机制，user-gate 等待超过 5 分钟自动终止。

**140. SkillFlow 的 checkpoint 用 LLM judge 可能误判：** LLM judge 的判定结果不稳定，同一输入可能不同判定。checkpoint 的 judge prompt 必须包含明确的通过/不通过标准，且失败时给 AI 看 judge 的 reasoning 而非只说"不通过"。

**141. 双循环的 maxReruns 可能导致 Token 爆炸：** 每次重跑都是完整的 ReAct 循环，3 次重跑 = 3 倍 Token。必须在 LoopMemory 中注入失败原因以减少重跑次数，且 maxReruns 默认设为 2 而非 3。

**142. 跨模型审查可能因模型不可用而失败：** 用户配置的审查模型可能未配置或已失效。跨模型审查器必须有 fallback：审查模型不可用时回退到同模型审查（但标注"未跨模型"），不能直接失败。

**143. Skill 质量门的 3 场景验证消耗大量 Token：** 每个 Skill 验证需要 3 次 LLM 调用（正常/边界/诱导），批量验证时 Token 消耗可观。默认只在 Skill 生成时运行，市场导入时只做 Schema + 兜底检查，不运行 3 场景验证。

**144. 上下文占用率的面板更新可能影响性能：** 每轮 ReAct 迭代都计算 token 数和占用率，对大上下文窗口（200K+）的 token 计数可能成为瓶颈。必须缓存 token 计数结果（已有 WeakMap 缓存），且面板更新频率限制为每 3 轮一次。

**145. 文件引用结构化注入可能遗漏关键代码：** code-map 的符号查询可能不完整（如遗漏全局函数、闭包内变量）。结构化注入器必须在截断时显示"已注入 N/M 个符号块"，让用户知道有内容被省略，并提供"注入全文"选项。

**146. 意图路由 SafeNet 的熔断可能导致服务不可用：** 连续低置信度触发熔断后，所有请求都回退到默认模型。熔断恢复必须有冷却期（如 5 分钟），且熔断期间向用户显示"路由系统降级运行"提示。

**147. LoopMemory 文件可能无限增长：** 长 /goal 任务（如 50 步）的失败记录可能生成大文件。LoopMemory 只保留最近 5 次失败记录，更早的归档到 archived/ 目录。

**148. SkillFlow 的 loop 节点可能形成无限循环：** loop 节点的 while 条件用 LLM 评估，LLM 可能永远返回 false。maxIterations 是硬上限，但即使达到 maxIterations 也只是标记 failed，不会自动终止整个 flow——必须在 onFailure 中设置 abort 而非 goto。

**149. 评估集的 LLM-as-Judge 可能因模型升级而失效：** 评估模型的输出分布变化会导致评分漂移。评估报告必须记录使用的模型版本，且模型升级后需要重新校准 Rubric。

**150. 渐进式披露可能导致 AI 缺少关键信息：** 只注入"核心原则"和"适用范围"可能让 AI 不知道完整的执行流程。渐进式披露必须在 AI 请求更多信息时能动态加载 references，而非静态地只给最小集。

**151. 吸因子过度引导可能让 AI 失去灵活性：** 吸因子（1.7）的"期望产出画像"若写得太具体，AI 可能死板模仿样本而不敢变通，遇到样本没覆盖的场景就僵住。吸因子提示必须明确"这是引导而非硬性要求，样本未覆盖的场景按项目通用规范处理"，且 attractor 字段全部可选——不配置吸因子时 SkillFlow 仍能靠 checkpoint 约束运行。

**152. 任务中断恢复的状态快照可能不一致：** SkillFlowCheckpointStore（1.8）保存的 FlowExecutionContext 包含节点输出，但中断期间用户可能手动改了文件、切了分支、甚至删了 Skill。恢复时必须用 validateCheckpoint 校验已通过节点输出的哈希，哈希不一致时宁可重跑该节点及下游，也不能用过期输出继续。恢复流程必须显式询问用户"是否从断点继续"，不能静默恢复。

**153. 打样注入可能让 AI 过度模仿而照抄业务逻辑：** StyleSampleInjector（4.5）虽标注"勿照抄业务逻辑"，但 AI 仍可能把样板的业务代码原样复制到新场景。打样注入的样板应优先选"结构清晰但业务简单"的文件（如基础接口、配置示例），避免选包含复杂业务逻辑的核心模块。注入的样板必须截断到 maxTokens，且注入后检查 AI 产出与样板的相似度，相似度过高时警告"疑似照抄样板"。

**154. 模型漂移检测可能产生大量误报：** ModelDriftDetector（3.6）在每次模型版本变更时标记所有 Skill 为"待重新校验"，若用户有几十个 Skill 且频繁升级模型，会变成噪音。漂移检测必须区分严重度（跨主版本=high，小版本=low），low 严重度只记录日志不提示用户，high 严重度才弹窗提示。且提供"批量重新校验"入口，避免用户逐个确认。

**155. 配置 ROI 评估可能引发"配置膨胀"反效果：** 知识库指出 48 Agent + 182 Skill + 68 命令的维护成本巨大。在线监控（Task 5）若只统计"使用频率"而不评估"维护成本"，可能鼓励用户堆砌配置。ROI 评估必须同时统计"配置使用率"和"配置维护成本"（Skill 重新校验次数、Agent 调优耗时），对长期未使用的配置主动提示"该 Skill 30 天未使用，是否归档？"。

---

## 思考引导总结

1. **从知识库学到什么？** 知识库揭示了三个工程化断层：Skill 停在提示词层面（缺固化）、Loop 缺独立外循环（双循环不完整）、Skill 缺质量门（无 3 场景验证）。Phase 49 用 SkillFlow 引擎、双循环编排器、Skill 质量门三个核心模块填补这三个断层。

2. **SkillFlow 不替代 Compose Pipeline：** 两者是不同粒度的编排。Compose 是会话级（需求→编码→测试→审查），SkillFlow 是 Skill 级（Skill 内部的步骤控制）。一个 Compose 编码阶段可以触发一个带 SkillFlow 的 Skill。

3. **双循环的核心理念：** 知识库说"将 Human-in-the-loop 替换为 Agent-in-the-loop"。双循环不是让 AI 自我验证（那只是自评盲区），而是用不同模型独立验证——内循环用工作模型执行，外循环用不同模型审查，形成真正的闭环。

4. **Skill 质量门是"守门员"：** 知识库说"3 场景验证 = Skill 算合格"。RouteDev 不能让用户导入一个不安全的 Skill 就直接运行。质量门是最后一道防线：Schema 校验挡住格式错误、兜底检查挡住不安全 Skill、3 场景验证挡住功能不合格的 Skill。

5. **上下文占用率是"隐形天花板"：** 知识库实测一次问候 3.8 万 token。RouteDev 的引用系统（Phase 48）会让上下文膨胀更快。结构化注入 + 渐进式披露 + 占用率可视化三管齐下，让用户和 AI 都能感知上下文消耗。

6. **评估集是"生产化的灵魂"：** 知识库说"95% 的 AI 工程师能做原型，能上生产的 5% 才拿高薪"。RouteDev 虽然不是 SaaS，但 Skill 和 /goal 的质量回归同样需要评估集。缩小为 Smoke(10)/Regression(30) 是务实的折中。

7. **意图路由四层漏斗是"省钱利器"：** 知识库说"L0 正则拦截 60-80%，成本降至 1/4"。RouteDev 当前只有 L0+L2，缺少 L1 向量路由和 SafeNet。补齐四层漏斗后，大部分请求不需要调用 LLM 路由，显著降低延迟和成本。

8. **五大设计模式是"架构全景图"：** 知识库的五大模式（提示链/路由/并行/反思/护栏）让 RouteDev 能做一次架构审计。Phase 49 补齐了提示链（SkillFlow + PromptChain）和反思（双循环 + ReflectionPattern），五大模式全覆盖。

9. **执行顺序建议：** Task 1（SkillFlow 引擎）→ Task 2（双循环编排器）→ Task 3（Skill 质量门）→ Task 4（上下文占用率）→ Task 6（意图路由增强）→ Task 5（评估集框架）→ Task 7（集成测试）。SkillFlow 和双循环是核心，优先落地。

10. **与 Phase 48 的关系：** Phase 48 解决"用户如何精准引用"，Phase 49 解决"AI 如何可靠执行"。引用系统让 AI 获得更精准的上下文，SkillFlow 让 AI 按流水线执行而非自由发挥，双循环让 AI 的输出被独立验证。两者合在一起，RouteDev 从"能用"升级为"可靠"。

11. **吸因子是约束的互补面（来自 `主题-AI项目长期迭代`）：** 初版 Phase 49 只规划了约束层（checkpoint / CompletionGate / 质量门），遗漏了知识库的"吸因子（Attractor）"概念——"Harness 是约束，吸因子是引导"。本版补入吸因子引导层（1.7）和打样注入（4.5），让 RouteDev 从"只告诉 AI 不能做什么"升级为"同时告诉 AI 做对了长什么样"。约束让 AI 不犯错，引导让 AI 主动做对，两者缺一不可。

12. **长期迭代视角的四个补强（来自 `主题-AI项目长期迭代` + `主题-AI独立创业`）：** ① 节点粒度 2-5 分钟（1.9）——SkillFlow 不能让单个节点太粗或太细；② 任务中断恢复（1.8）——长流水线必须支持断点续跑；③ 让 AI 自己改（2.5）——双循环重跑时不人工介入，让 AI 基于 LoopMemory 自修正；④ 模型漂移检测（3.6）——模型升级后 Skill 行为可能漂移，质量门需重新校验。这四条都是"上线后才暴露"的工程化问题，知识库用真实项目经验指出，RouteDev 必须提前防御。
