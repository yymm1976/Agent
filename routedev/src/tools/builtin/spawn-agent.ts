// src/tools/builtin/spawn-agent.ts
// 子 Agent 生成工具：并行处理独立子任务
// P1-6：Codex/Claude Code 都有子 Agent 能力，RouteDev 缺失
//
// 设计：
//   1. 工具本身不直接创建 AgentLoop（需要 LLM client 等运行时参数）
//   2. 通过注入的 spawnAgent 函数执行子任务
//   3. app-init.ts 负责创建 spawnAgent 函数并注入
//   4. 支持同步等待结果或返回任务 ID（未来扩展）
//
// Phase 38 Task 2：签名增强
//   - 新增 SpawnResult 类型（含 modifiedFiles）
//   - SpawnAgentFunction 改为对象参数：description/prompt/subagentType/maxIterations/isolated
//   - 向后兼容：旧 taskDescription 字符串参数自动转换为 { description, prompt }
//   - 防递归：通过 ToolRegistry.clone() + 移除 spawn_agent 实现（在 app-init.ts 中处理）
//
// Phase 92 / TD-10：拆分为 spawn-agent-types.ts（类型与常量）、spawn-agent-utils.ts（工具函数）、
// spawn-agent-delegation.ts（委托体系包装器），本文件仅保留 SpawnAgentTool 类与 re-exports

// ============================================================
// Re-exports：保持公共 API 签名不变（向后兼容）
// ============================================================

// 类型与常量（from spawn-agent-types.ts）
export type {
  SubagentType,
  DelegationContext,
  DetachedSessionOptions,
  SpawnResult,
  SpawnAgentParams,
  SpawnAgentFunction,
  DelegationIntegrationDeps,
} from './spawn-agent-types.js';
export { SUBAGENT_TOOL_WHITELIST } from './spawn-agent-types.js';

// 工具函数（from spawn-agent-utils.ts）
export {
  normalizeToolName,
  normalizeToolNames,
  resolveProfileForSubagent,
  createChildRegistry,
  createConcurrencyLimitedSpawnFn,
  createDetachedSessionContext,
  extractDetachedSessionAnswer,
  buildForkedMessages,
} from './spawn-agent-utils.js';

// 委托体系包装器（from spawn-agent-delegation.ts）
export { wrapSpawnAgentWithDelegation } from './spawn-agent-delegation.js';

// ============================================================
// SpawnAgentTool 实现
// ============================================================

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import type { SubagentType, SpawnAgentParams, SpawnAgentFunction } from './spawn-agent-types.js';
import { ALLOWED_MODEL_PATTERN, MAX_TASK_LENGTH, MAX_TOOLS, TOOL_NAME_PATTERN } from './spawn-agent-types.js';
import { buildForkedMessages } from './spawn-agent-utils.js';

export class SpawnAgentTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'spawn_agent',
    description: '当用户需要并行处理多个独立子任务、隔离上下文提高专注度时，使用此工具生成子 Agent。子 Agent 有独立的迭代空间，结果返回给主 Agent。',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '短标签（UI 显示用，< 60 字符）',
        },
        prompt: {
          type: 'string',
          description: '给子 Agent 的详细指令（清晰、独立的任务，不依赖主 Agent 当前上下文）',
        },
        subagentType: {
          type: 'string',
          enum: ['general', 'researcher', 'coder', 'reviewer', 'advisor', 'review-plan', 'planner'],
          description: '子 Agent 类型，决定可用工具集。general=全部工具（除 spawn_agent），researcher=只读检索，coder=读写执行，reviewer=只读审查+写审查报告，advisor=无工具（仅单次 LLM 调用，用于 /BTW 临时问答），review-plan=Pre-flight plan review，planner=PM/架构师（拆需求+出设计方案，可写 context/ 文件）。默认 general。',
        },
        maxIterations: {
          type: 'number',
          description: '子 Agent 最大迭代次数（可选，默认 20）',
        },
        isolated: {
          type: 'boolean',
          description: '是否使用独立上下文（默认 true）',
        },
        model: {
          type: 'string',
          description: '必填。指定 subagent 使用的模型 ID（Phase 75-A3）。传 "inherit"=继承 AgentProfile.modelId；传具体 model id（如 "gpt-4o-mini"）=使用该模型。强制必填以避免静默继承最贵模型。',
        },
      },
      required: ['description', 'prompt', 'model'],
    },
    requiresApproval: true,
    category: 'system',
  };

  private spawnFn: SpawnAgentFunction;

  constructor(spawnFn: SpawnAgentFunction) {
    this.spawnFn = spawnFn;
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    // 向后兼容：旧 taskDescription 字符串参数
    const hasLegacy = typeof args.taskDescription === 'string';
    const hasDescription = typeof args.description === 'string';
    const hasPrompt = typeof args.prompt === 'string';

    if (!hasLegacy && !hasDescription) {
      errors.push('缺少必需参数: description');
    }
    if (!hasLegacy && !hasPrompt) {
      errors.push('缺少必需参数: prompt');
    }
    if (hasDescription && (args.description as string).length < 3) {
      errors.push('description 至少需要 3 个字符');
    }
    if (hasPrompt && (args.prompt as string).length < 10) {
      errors.push('prompt 至少需要 10 个字符，确保任务描述足够清晰');
    }
    // 旧字段长度校验（向后兼容）
    if (hasLegacy && (args.taskDescription as string).length < 10) {
      errors.push('taskDescription 至少需要 10 个字符，确保任务描述足够清晰');
    }
    // 安全加固：task description / prompt / legacy taskDescription 长度上限
    if (hasDescription && (args.description as string).length > MAX_TASK_LENGTH) {
      errors.push(`description 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (hasPrompt && (args.prompt as string).length > MAX_TASK_LENGTH) {
      errors.push(`prompt 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (hasLegacy && (args.taskDescription as string).length > MAX_TASK_LENGTH) {
      errors.push(`taskDescription 过长 (上限 ${MAX_TASK_LENGTH} 字符)`);
    }
    if (args.maxIterations !== undefined) {
      if (typeof args.maxIterations !== 'number') {
        errors.push('maxIterations 必须是数字');
      } else if (!Number.isInteger(args.maxIterations) || args.maxIterations <= 0 || args.maxIterations > 100) {
        errors.push('maxIterations 必须是 1 到 100 之间的整数');
      }
    }
    if (args.subagentType !== undefined && !['general', 'researcher', 'coder', 'reviewer', 'advisor', 'review-plan', 'planner'].includes(args.subagentType as string)) {
      errors.push('subagentType 必须是 general/researcher/coder/reviewer/advisor/review-plan/planner 之一');
    }
    if (args.isolated !== undefined && typeof args.isolated !== 'boolean') {
      errors.push('isolated 必须是布尔值');
    }
    // Phase 75-A3：model 字段校验（必填，字符串）
    if (args.model === undefined) {
      errors.push('缺少必需参数: model（必须显式指定 model id 或 "inherit"）');
    } else if (typeof args.model !== 'string') {
      errors.push('model 必须是字符串（model id 或 "inherit"）');
    } else if (!ALLOWED_MODEL_PATTERN.test(args.model)) {
      // 安全加固：model 字段白名单校验，防止注入非法字符
      errors.push('model 格式非法（仅允许字母、数字、点、下划线、短横线，长度 1-64）');
    }
    // 安全加固：allowedTools 数组校验（若调用方提供，校验格式与数量）
    if (args.allowedTools !== undefined) {
      if (!Array.isArray(args.allowedTools)) {
        errors.push('allowedTools 必须是字符串数组');
      } else if (args.allowedTools.length > MAX_TOOLS) {
        errors.push(`allowedTools 数量过多 (上限 ${MAX_TOOLS} 个)`);
      } else {
        for (const tool of args.allowedTools) {
          if (typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) {
            errors.push(`allowedTools 中存在非法工具名: ${String(tool)}`);
            break;
          }
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // 向后兼容：旧 taskDescription 字符串参数 → 转换为新签名
    const legacyTaskDesc = args.taskDescription;
    const description = typeof args.description === 'string'
      ? (args.description as string)
      : (legacyTaskDesc as string);
    const prompt = typeof args.prompt === 'string'
      ? (args.prompt as string)
      : (legacyTaskDesc as string);

    const params: SpawnAgentParams = {
      description,
      prompt,
      // Phase 75-A3：model 必填，schema 已强制校验，未传会在 validateArgs 被拒绝
      model: args.model as string,
    };
    if (args.subagentType !== undefined) {
      params.subagentType = args.subagentType as SubagentType;
    }
    if (args.maxIterations !== undefined) {
      params.maxIterations = args.maxIterations as number;
    }
    if (args.isolated !== undefined) {
      params.isolated = args.isolated as boolean;
    }

    // 兼容旧 options.systemPrompt（保留透传，由 app-init.ts 处理）
    // P0-4：扩展 options 以支持 renderedSystemPrompt + forkedConversationHistory
    const options: {
      systemPrompt?: string;
      maxIterations?: number;
      renderedSystemPrompt?: string;
      forkedConversationHistory?: import('../../router/types.js').LLMMessage[];
    } = {};
    if (args.systemPrompt !== undefined) {
      options.systemPrompt = args.systemPrompt as string;
    }

    // P0-4：若调用方提供 parentAssistantContent（父 Agent 当前 assistant 消息内容），
    // 调用 buildForkedMessages 构造字节一致前缀，启用 prompt cache 共享。
    // 未提供时跳过，保持现有行为（子 Agent 独立上下文）。
    if (typeof args.parentAssistantContent === 'string' && args.parentAssistantContent.length > 0) {
      options.forkedConversationHistory = buildForkedMessages(
        args.parentAssistantContent,
        prompt,
      );
      // renderedSystemPrompt 透传：若调用方同时提供，则一并传递
      if (typeof args.renderedSystemPrompt === 'string') {
        options.renderedSystemPrompt = args.renderedSystemPrompt as string;
      }
    }

    try {
      const result = await this.spawnFn(params, options);

      if (!result.success) {
        const errText = result.error ?? '未知错误';
        // 从错误前缀提取 errorType（GATE_* / 其它）
        const codeMatch = /^(GATE_[A-Z_]+|[A-Z_]+):/.exec(errText);
        const errorType = codeMatch?.[1] ?? 'SPAWN_FAILED';
        return {
          success: false,
          output: '',
          error: errText.startsWith('子 Agent') ? errText : `子 Agent 执行失败: ${errText}`,
          durationMs: 0,
          metadata: {
            errorType,
            reason: errText,
            tokenUsage: result.tokenUsage,
            modifiedFiles: result.modifiedFiles,
            // Phase 97 Part E：失败时也携带 childSessionId（UI 可追踪）
            childSessionId: result.childSessionId,
          },
        };
      }

      return {
        success: true,
        output: result.result,
        durationMs: 0,
        metadata: {
          tokenUsage: result.tokenUsage,
          modifiedFiles: result.modifiedFiles,
          description: description.slice(0, 100),
          // Phase 97 Part E：成功时携带 childSessionId（UI 可打开检查）
          childSessionId: result.childSessionId,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `子 Agent 生成失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
