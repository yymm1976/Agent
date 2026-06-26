// src/skills/skill-flow-engine.ts
// SkillFlow 引擎（Phase 49 Task 1.3 — Skill 固化阶段 2）
//
// 核心机制：
//   1. 每次只把当前节点的 prompt 注入 system prompt，不让 AI 看到后续步骤（防跳步）
//   2. AI 执行完当前节点后，引擎调用 checkpoint 检查
//   3. checkpoint 通过 → 推进到下一节点；不通过 → 按 onFailure 处理
//   4. user-gate 节点暂停整个循环，等待用户确认
//   5. loop 节点重复执行直到条件满足或达到 maxIterations
//
// 与 ReActAgentLoop 的关系：
//   - SkillFlow 不替代 ReAct 循环，而是包裹它
//   - 每个节点的执行 = 一次 ReAct 循环（可能多轮工具调用）
//   - SkillFlow 控制节点间的流转，ReAct 控制节点内的工具调用
//
// 关键设计（蓝图 1.3 节）：
//   不直接依赖 ReActAgentLoop，通过 SkillFlowRunParams 注入回调：
//   - runReact：执行 ReAct 循环
//   - llmJudge：checkpoint 的 llm-judge 检查
//   - evaluateLoopCondition：loop 节点的条件评估
//   - waitForUserConfirmation：user-gate 节点的用户确认
//   - evaluateBranch：branch 节点的分支选择

import { logger } from '../utils/logger.js';
import { AttractorInjector } from './attractor.js';
import type {
  FlowEvent,
  FlowExecutionContext,
  FlowNode,
  SkillFlow,
  SkillFlowRunParams,
} from './skill-flow-types.js';

/**
 * SkillFlow 引擎——把 Skill 从"说明书"升级为"被引擎控制的可执行流水线"
 */
export class SkillFlowEngine {
  /** 吸因子注入器实例 */
  private readonly attractorInjector: AttractorInjector;
  /** 重试计数器（runtime 状态，按节点 ID 记录当前已重试次数） */
  private readonly retryCounters: Map<string, number> = new Map();

  constructor() {
    this.attractorInjector = new AttractorInjector();
  }

  /**
   * 运行 SkillFlow
   *
   * @param flow Skill 的流水线定义
   * @param params 依赖注入参数（含 ReAct 基础参数 + 各类回调）
   * @returns AsyncGenerator<FlowEvent> 流式输出事件
   */
  async *run(
    flow: SkillFlow,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    const ctx: FlowExecutionContext = {
      currentNodeId: flow.entryNodeId,
      nodeStates: new Map(),
      nodeOutputs: new Map(),
      totalIterations: 0,
      loopCounters: new Map(),
      handoffArtifacts: new Map(),
    };

    // 主循环：到达 exitNodeId 即完成
    while (ctx.currentNodeId !== flow.exitNodeId) {
      // 护栏：总迭代次数上限（蓝图 1.2 节 maxTotalIterations）
      if (ctx.totalIterations >= flow.maxTotalIterations) {
        yield { type: 'flow-aborted', reason: '达到最大总迭代次数' };
        return;
      }

      const node = flow.nodes.find((n) => n.id === ctx.currentNodeId);
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
            yield* this.executeCheckpointNode(node, flow, ctx, params);
            break;
          case 'user-gate':
            yield* this.executeUserGateNode(node, flow, ctx, params);
            break;
          case 'loop':
            yield* this.executeLoopNode(node, flow, ctx, params);
            break;
          case 'branch':
            yield* this.executeBranchNode(node, flow, ctx, params);
            break;
          default:
            yield { type: 'flow-error', error: `未知节点类型 ${(node as FlowNode).type}` };
            return;
        }
      } catch (error) {
        ctx.nodeStates.set(node.id, 'failed');
        const errMsg = error instanceof Error ? error.message : String(error);
        yield { type: 'node-failed', node, error: errMsg };

        // 按 onFailure 处理：abort 立即终止；retry/goto 由 handleNodeFailure 决定
        const action = this.handleNodeFailure(node, ctx);
        if (action === 'abort') {
          yield { type: 'flow-aborted', reason: `节点 ${node.id} 失败：${errMsg}` };
          return;
        }
        // action === 'retry' 或 'goto'：currentNodeId 已被 handleNodeFailure 设置，
        // 主循环会继续到下一个迭代
        logger.debug('SkillFlowEngine: node failed, applying onFailure', {
          nodeId: node.id,
          action,
        });
      }
    }

    // 到达 exitNodeId，流水线完成
    ctx.nodeStates.set(flow.exitNodeId, ctx.nodeStates.get(flow.exitNodeId) ?? 'passed');
    yield { type: 'flow-complete' };
  }

  /**
   * 执行普通步骤节点
   *
   * 关键（蓝图 1.6 节）：只把当前节点的 prompt 注入 system prompt
   * AI 看不到后续步骤，防止"跳步"
   */
  private async *executeStepNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    // 1. 构造节点级 system prompt（含吸因子注入 + 工具白名单提示）
    const nodeSystemPrompt = this.buildNodeSystemPrompt(node, flow);

    // 2. 应用工具白名单（节点级 > 全局）
    const allowedTools = this.resolveAllowedTools(node, flow);

    // 3. 构造节点级 ReAct 参数
    const nodeParams = {
      ...params.baseParams,
      systemPrompt: nodeSystemPrompt,
    };

    // 4. 运行 ReAct 循环（透传 ReAct 事件，收集最终输出）
    let nodeOutput = '';
    for await (const event of params.runReact(nodeParams, allowedTools)) {
      yield { type: 'react-event', node, event };
      if (event.type === 'done') {
        nodeOutput = event.content;
      }
    }

    // 5. 记录输出、标记通过、推进到下一节点
    ctx.nodeOutputs.set(node.id, nodeOutput);
    ctx.nodeStates.set(node.id, 'passed');
    yield { type: 'node-complete', node, output: nodeOutput };

    ctx.currentNodeId = this.getNextNodeId(node, flow);
  }

  /**
   * 执行检查节点——验证上一步输出是否达标
   *
   * 三种检查方式（蓝图 1.3 节）：
   *   1. llm-judge：用独立 LLM 判断输出是否满足条件
   *   2. regex-match：正则匹配输出
   *   3. tool-output-contains：检查工具输出是否包含关键词
   */
  private async *executeCheckpointNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    if (!node.checkCondition) {
      yield { type: 'node-skipped', node, reason: '无检查条件' };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
      return;
    }

    const lastStepOutput = this.getLastStepOutput(ctx, node);
    let passed = false;

    switch (node.checkCondition.kind) {
      case 'llm-judge': {
        const judgePrompt = node.checkCondition.judgePrompt ?? '';
        passed = await params.llmJudge(judgePrompt, lastStepOutput);
        break;
      }
      case 'regex-match': {
        const pattern = node.checkCondition.pattern ?? '';
        try {
          passed = new RegExp(pattern).test(lastStepOutput);
        } catch (err) {
          logger.warn('SkillFlowEngine: invalid regex pattern', {
            nodeId: node.id,
            pattern,
            error: err instanceof Error ? err.message : String(err),
          });
          passed = false;
        }
        break;
      }
      case 'tool-output-contains': {
        // 检查交接产物中指定工具的输出（蓝图原意：检查 nodeOutputs 中以 toolName 为 key 的输出）
        // 简化：检查上一步输出是否包含 keyword，或 nodeOutputs 中是否有 toolName 的输出包含 keyword
        const toolName = node.checkCondition.toolName ?? '';
        const keyword = node.checkCondition.keyword ?? '';
        const toolOutput = ctx.nodeOutputs.get(toolName) ?? lastStepOutput;
        passed = toolOutput.includes(keyword);
        break;
      }
    }

    if (passed) {
      ctx.nodeStates.set(node.id, 'passed');
      yield { type: 'checkpoint-passed', node };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
    } else {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'checkpoint-failed', node };
      // 按 onFailure 处理（retry/abort/goto）
      const action = this.handleNodeFailure(node, ctx);
      if (action === 'abort') {
        yield { type: 'flow-aborted', reason: `检查节点 ${node.id} 失败且 onFailure=abort` };
      }
    }
  }

  /**
   * 执行用户控制节点——暂停等待用户确认
   *
   * 知识库原文："用户控制节点（暂停等待确认）"
   * 通过 waitForUserConfirmation 回调等待用户决定。
   */
  private async *executeUserGateNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    ctx.nodeStates.set(node.id, 'user-pending');
    const message = node.gateMessage ?? '请确认是否继续';
    yield { type: 'user-gate', node, message };

    // 等待用户决定（approve / reject）
    const decision = await params.waitForUserConfirmation(node.id, message);

    if (decision === 'approve') {
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
   * 知识库原文："循环节点（Task Planner 运行 N 次）"
   * 每次 iteration 执行循环体（用 step 逻辑），然后评估循环条件：
   *   - 条件满足（while 返回 true）→ 退出循环，推进到下一节点
   *   - 条件不满足 → 继续循环（currentNodeId 保持为 loop 节点 id）
   *   - 达到 maxIterations → 标记失败，按 onFailure 处理
   */
  private async *executeLoopNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    if (!node.loopCondition) {
      yield { type: 'node-skipped', node, reason: '无循环条件' };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
      return;
    }

    const counter = (ctx.loopCounters.get(node.id) ?? 0) + 1;
    ctx.loopCounters.set(node.id, counter);

    // 检查是否达到 maxIterations
    if (counter > node.loopCondition.maxIterations) {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'loop-exhausted', node, maxIterations: node.loopCondition.maxIterations };
      // 按 onFailure 处理（retry/abort/goto）
      const action = this.handleNodeFailure(node, ctx);
      if (action === 'abort') {
        yield { type: 'flow-aborted', reason: `循环节点 ${node.id} 达到最大迭代次数` };
      }
      return;
    }

    yield { type: 'loop-iteration', node, iteration: counter };

    // 执行循环体（复用 step 节点逻辑：注入 prompt + 跑 ReAct）
    const nodeSystemPrompt = this.buildNodeSystemPrompt(node, flow);
    const allowedTools = this.resolveAllowedTools(node, flow);
    const nodeParams = {
      ...params.baseParams,
      systemPrompt: nodeSystemPrompt,
    };

    let loopOutput = '';
    for await (const event of params.runReact(nodeParams, allowedTools)) {
      yield { type: 'react-event', node, event };
      if (event.type === 'done') {
        loopOutput = event.content;
      }
    }
    ctx.nodeOutputs.set(node.id, loopOutput);

    // 评估循环条件
    const conditionMet = await params.evaluateLoopCondition(
      node.loopCondition.while,
      loopOutput,
    );

    if (conditionMet) {
      // 条件满足 → 退出循环，推进
      ctx.nodeStates.set(node.id, 'passed');
      yield { type: 'node-complete', node, output: loopOutput };
      // 重置 loop counter 以便下次重跑
      ctx.loopCounters.set(node.id, 0);
      ctx.currentNodeId = this.getNextNodeId(node, flow);
    } else {
      // 条件不满足 → 继续循环（currentNodeId 保持为 loop 节点 id）
      // 不推进到下一节点，主循环会再次进入 executeLoopNode
    }
  }

  /**
   * 执行分支节点——根据条件走不同路径
   *
   * 调用 evaluateBranch 回调，由调用方根据 lastOutput 选择匹配的分支。
   */
  private async *executeBranchNode(
    node: FlowNode,
    flow: SkillFlow,
    ctx: FlowExecutionContext,
    params: SkillFlowRunParams,
  ): AsyncGenerator<FlowEvent> {
    if (!node.branches || node.branches.length === 0) {
      yield { type: 'node-skipped', node, reason: '无分支规则' };
      ctx.currentNodeId = this.getNextNodeId(node, flow);
      return;
    }

    const lastOutput = this.getLastStepOutput(ctx, node);
    const targetNodeId = await params.evaluateBranch(node.branches, lastOutput);

    // 校验目标节点存在
    const targetExists = flow.nodes.some((n) => n.id === targetNodeId);
    if (!targetExists) {
      ctx.nodeStates.set(node.id, 'failed');
      yield { type: 'node-failed', node, error: `分支目标节点 ${targetNodeId} 不存在` };
      const action = this.handleNodeFailure(node, ctx);
      if (action === 'abort') {
        yield { type: 'flow-aborted', reason: `分支节点 ${node.id} 目标无效` };
      }
      return;
    }

    ctx.nodeStates.set(node.id, 'passed');
    ctx.currentNodeId = targetNodeId;
  }

  // ============================================================
  // 内部辅助方法
  // ============================================================

  /**
   * 构造节点级 system prompt
   *
   * 防跳步：只注入当前节点的 prompt，不暴露后续节点
   * 吸因子：追加 attractor 引导文本（蓝图 1.7 节）
   * 工具白名单：追加软限制提示
   */
  private buildNodeSystemPrompt(node: FlowNode, flow: SkillFlow): string {
    // 注入吸因子引导（节点级）
    const promptWithAttractor = this.attractorInjector.inject(node, flow);

    const parts: string[] = [
      `【SkillFlow 节点】${node.title}`,
      '',
      promptWithAttractor,
    ];

    // 工具白名单软限制提示
    const allowedTools = this.resolveAllowedTools(node, flow);
    if (allowedTools && allowedTools.length > 0) {
      parts.push('');
      parts.push(`【工具白名单】本步骤仅允许使用以下工具：${allowedTools.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * 解析节点级工具白名单
   *
   * 优先级：节点 allowedTools > flow.globalAllowedTools > undefined（全工具）
   */
  private resolveAllowedTools(node: FlowNode, flow: SkillFlow): string[] | undefined {
    if (node.allowedTools && node.allowedTools.length > 0) {
      return node.allowedTools;
    }
    if (node.allowedTools && node.allowedTools.length === 0) {
      // 空数组 = 继承全局
      return flow.globalAllowedTools;
    }
    // undefined = 全工具
    return undefined;
  }

  /**
   * 获取上一个 step 节点的输出（用于 checkpoint 检查或分支条件评估）
   *
   * 策略：从当前节点向前找最近的 passed 节点，返回其 output。
   * 如果没有，返回空字符串。
   */
  private getLastStepOutput(ctx: FlowExecutionContext, currentNode: FlowNode): string {
    // 优先用 currentNode 之前最近一个节点的输出
    // 简化：返回 nodeOutputs 中最近添加的非空输出
    let lastOutput = '';
    for (const [nodeId, output] of ctx.nodeOutputs) {
      if (nodeId === currentNode.id) continue;
      if (output && output.length > 0) {
        lastOutput = output;
      }
    }
    return lastOutput;
  }

  /**
   * 获取下一个节点 ID（线性顺序）
   *
   * 找当前节点在 flow.nodes 数组中的下一个。
   * 如果当前是最后一个，返回 exitNodeId。
   */
  private getNextNodeId(node: FlowNode, flow: SkillFlow): string {
    const idx = flow.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1 || idx >= flow.nodes.length - 1) {
      return flow.exitNodeId;
    }
    return flow.nodes[idx + 1].id;
  }

  /**
   * 处理节点失败——按 onFailure 决定下一步动作
   *
   * @returns 'abort' | 'retry' | 'goto'（'retry'/'goto' 时 currentNodeId 已更新）
   */
  private handleNodeFailure(
    node: FlowNode,
    ctx: FlowExecutionContext,
  ): 'abort' | 'retry' | 'goto' {
    switch (node.onFailure) {
      case 'retry': {
        const currentRetry = this.retryCounters.get(node.id) ?? 0;
        const maxRetries = node.maxRetries ?? 0;
        if (currentRetry < maxRetries) {
          this.retryCounters.set(node.id, currentRetry + 1);
          // 重置节点状态为 pending，让主循环重跑
          ctx.nodeStates.set(node.id, 'pending');
          ctx.currentNodeId = node.id;
          logger.debug('SkillFlowEngine: retrying node', {
            nodeId: node.id,
            attempt: currentRetry + 1,
            maxRetries,
          });
          return 'retry';
        }
        // 超过最大重试次数 → 终止
        logger.warn('SkillFlowEngine: node exhausted retries, aborting', {
          nodeId: node.id,
          maxRetries,
        });
        return 'abort';
      }
      case 'goto': {
        if (node.onFailureGoto) {
          ctx.nodeStates.set(node.id, 'skipped');
          ctx.currentNodeId = node.onFailureGoto;
          return 'goto';
        }
        // 未指定 goto 目标 → 终止
        logger.warn('SkillFlowEngine: onFailure=goto but no onFailureGoto, aborting', {
          nodeId: node.id,
        });
        return 'abort';
      }
      case 'abort':
      default:
        return 'abort';
    }
  }
}
