// src/cli/commands/swarm.ts
// /swarm 命令：群组多 Agent 协作
// 借鉴 kimi-code 的 /swarm 功能，利用 RouteDev 已有的多 Agent 基础设施
//
// 流程：
//   1. 用户输入 /swarm <任务描述>
//   2. LLM 将任务拆分为可并行的子任务列表（输出 JSON：[{description, role, prompt}]）
//   3. 对每个子任务调用 spawn_agent（受 maxConcurrentSubAgents 限制）
//   4. 各子 Agent 结果汇总
//   5. 主 Agent 读取汇总结果，生成最终输出

import type { CommandDefinition } from '../command-registry.js';
import type { LLMMessage } from '../../router/types.js';
import type { SubagentType } from '../../tools/builtin/spawn-agent.js';
import { logger } from '../../utils/logger.js';

/** LLM 拆分出的子任务结构 */
interface SubTask {
  /** 子任务简短描述 */
  description: string;
  /** 子 Agent 角色 */
  role: SubagentType;
  /** 给子 Agent 的详细指令 */
  prompt: string;
}

/** 单个子 Agent 执行结果 */
interface SubTaskResult {
  /** 子任务描述 */
  description: string;
  /** 是否成功 */
  success: boolean;
  /** 子 Agent 返回的内容 */
  output: string;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 从 LLM 响应文本中提取 JSON 数组
 * 兼容裸 JSON、```json 代码块、前后多余文本等情况
 */
function extractJsonArray(text: string): unknown[] | null {
  // 尝试直接解析
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // 继续尝试其他方式
  }
  // 尝试提取 ```json ... ``` 代码块
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试
    }
  }
  // 尝试提取第一个 [ 到最后一个 ] 之间的内容
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 解析失败
    }
  }
  return null;
}

/**
 * 并发执行子任务，限制同时运行的子 Agent 数量
 *
 * @param tasks 子任务列表
 * @param spawnFn spawn_agent 工具执行函数（通过 toolExecutor.executeTool 调用）
 * @param maxConcurrent 最大并发数
 * @param onProgress 进度回调
 */
async function runSubTasksWithConcurrency(
  tasks: SubTask[],
  spawnFn: (task: SubTask) => Promise<SubTaskResult>,
  maxConcurrent: number,
  onProgress: (index: number, total: number, description: string) => void,
): Promise<SubTaskResult[]> {
  const results: SubTaskResult[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= tasks.length) return;
      const task = tasks[myIndex];
      onProgress(myIndex, tasks.length, task.description);
      results[myIndex] = await spawnFn(task);
    }
  }

  // 启动 maxConcurrent 个 worker
  const workerCount = Math.min(maxConcurrent, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export const swarmCommand: CommandDefinition = {
  name: 'swarm',
  description: '群组多 Agent 协作（任务拆分→并行执行→汇总）',
  usage: '/swarm <任务描述>',
  handler: async (args, ctx) => {
    const taskDescription = args.trim();
    if (!taskDescription) {
      return { type: 'handled', messages: ['用法: /swarm <任务描述>'] };
    }

    const { commandBridge, clientManager, config, toolExecutor } = ctx;

    // 获取可用的 LLM 客户端
    const readyClients = clientManager.getReadyClients();
    if (readyClients.length === 0) {
      return { type: 'handled', messages: ['错误：没有可用的 LLM 客户端，无法执行 /swarm'] };
    }
    const llmClient = readyClients[0].client;
    const modelId = config.router?.classifierModel ?? 'deepseek-v4-flash';

    commandBridge.addSystemMessage(`🐝 /swarm 启动：正在拆分任务...`);

    // ===== 第一步：LLM 拆分任务为可并行的子任务 =====
    const splitMessages: LLMMessage[] = [
      {
        role: 'system',
        content: `你是一个任务拆分专家。将用户给定的任务拆分为可并行的子任务列表。

要求：
1. 每个子任务应尽量独立，可并行执行
2. 为每个子任务分配合适的角色（role）：general（通用）、researcher（调研检索）、coder（编码实现）、reviewer（审查）
3. 每个子任务的 prompt 必须完整、清晰，不依赖主上下文
4. 子任务数量控制在 2-8 个

输出格式：纯 JSON 数组，不要包含任何其他文本。格式如下：
[
  {
    "description": "子任务简短描述（<60字符）",
    "role": "general",
    "prompt": "给子 Agent 的详细指令（≥10字符）"
  }
]`,
      },
      {
        role: 'user',
        content: `请拆分以下任务：\n\n${taskDescription}`,
      },
    ];

    let subTasks: SubTask[] = [];
    try {
      const response = await llmClient.complete({
        model: modelId,
        messages: splitMessages,
        temperature: 0.3,
        maxTokens: 2000,
      });

      const parsed = extractJsonArray(response.content);
      if (!parsed) {
        return {
          type: 'handled',
          messages: ['错误：LLM 拆分任务失败，无法解析 JSON 输出。请重试。'],
        };
      }

      subTasks = parsed
        .filter((item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null &&
          typeof (item as Record<string, unknown>).description === 'string' &&
          typeof (item as Record<string, unknown>).prompt === 'string')
        .map((item) => {
          const obj = item as Record<string, unknown>;
          const role = obj.role as string;
          // 校验 role 合法性，默认 general
          const validRoles: SubagentType[] = ['general', 'researcher', 'coder', 'reviewer'];
          return {
            description: obj.description as string,
            role: validRoles.includes(role as SubagentType) ? (role as SubagentType) : 'general',
            prompt: obj.prompt as string,
          };
        });

      if (subTasks.length === 0) {
        return {
          type: 'handled',
          messages: ['错误：LLM 拆分任务后未得到有效子任务。请重试。'],
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('swarm: task splitting failed', { error: msg });
      return {
        type: 'handled',
        messages: [`任务拆分失败：${msg}`],
      };
    }

    commandBridge.addSystemMessage(
      `📋 已拆分为 ${subTasks.length} 个子任务：\n` +
      subTasks.map((t, i) => `  ${i + 1}. [${t.role}] ${t.description}`).join('\n') +
      `\n\n🚀 开始并行执行（最大并发 ${config.agent?.maxConcurrentSubAgents ?? 5}）...`
    );

    // ===== 第二步：并行调用 spawn_agent 执行子任务 =====
    const maxConcurrent = config.agent?.maxConcurrentSubAgents ?? 5;

    const spawnOne = async (task: SubTask): Promise<SubTaskResult> => {
      try {
        const output = await toolExecutor.executeTool(
          'spawn_agent',
          `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          {
            description: task.description,
            prompt: task.prompt,
            subagentType: task.role,
          },
        );
        return {
          description: task.description,
          success: !output.startsWith('[工具错误]'),
          output,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          description: task.description,
          success: false,
          output: '',
          error: msg,
        };
      }
    };

    const results = await runSubTasksWithConcurrency(
      subTasks,
      spawnOne,
      maxConcurrent,
      (index, total, desc) => {
        commandBridge.addSystemMessage(`  [${index + 1}/${total}] 执行中: ${desc}`);
      },
    );

    // 统计成功/失败
    const succeeded = results.filter(r => r.success).length;
    const failed = results.length - succeeded;
    commandBridge.addSystemMessage(
      `✅ 子任务执行完成（成功 ${succeeded}/${results.length}${failed > 0 ? `，失败 ${failed}` : ''}）`
    );

    // ===== 第三步：汇总结果，LLM 生成最终输出 =====
    commandBridge.addSystemMessage('📝 正在汇总结果，生成最终输出...');

    const summaryContent = results
      .map((r, i) => {
        const status = r.success ? '✅ 成功' : '❌ 失败';
        const content = r.success ? r.output : (r.error ?? '未知错误');
        return `### 子任务 ${i + 1}: ${r.description}\n状态: ${status}\n结果:\n${content}`;
      })
      .join('\n\n---\n\n');

    const summaryMessages: LLMMessage[] = [
      {
        role: 'system',
        content: '你是一个任务汇总专家。根据多个子 Agent 的执行结果，生成一份连贯的最终报告。整合各子任务的结果，去除冗余，突出关键发现和结论。',
      },
      {
        role: 'user',
        content: `原始任务：${taskDescription}\n\n各子 Agent 执行结果：\n\n${summaryContent}\n\n请汇总以上结果，生成最终输出。`,
      },
    ];

    try {
      const finalResponse = await llmClient.complete({
        model: modelId,
        messages: summaryMessages,
        temperature: 0.5,
        maxTokens: 4000,
      });

      commandBridge.addSystemMessage('━━━ /swarm 最终输出 ━━━');
      commandBridge.addSystemMessage(finalResponse.content);

      logger.info('swarm command completed', {
        taskCount: subTasks.length,
        succeeded,
        failed,
        inputTokens: finalResponse.usage.inputTokens,
        outputTokens: finalResponse.usage.outputTokens,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('swarm: final summary failed', { error: msg });
      // 汇总失败时直接展示各子任务结果
      commandBridge.addSystemMessage('⚠️ 最终汇总失败，直接展示各子任务结果：');
      commandBridge.addSystemMessage(summaryContent);
    }

    return { type: 'handled' };
  },
};
