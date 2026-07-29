// src/tools/tool-call-repair/pipeline.ts
// 工具调用修复 pipeline：串联 scavenge → flatten → storm → truncation 四道工序
//
// 调用顺序设计：
//   1. scavenge — 先捞回丢失的工具调用，确保后续工序能看到完整调用列表
//   2. truncation — 修复参数 JSON（必须在 flatten 之前，否则 flatten 处理的是字符串而非对象）
//   3. flatten — 打平过深嵌套参数
//   4. storm — 最后做重复检测，因为前几道工序可能新增或修改参数，重复检测需基于最终状态
//
// 接入点：loop.ts 在 `if (result.toolCalls.length > 0)` 之前调用
//   ```
//   const repairResult = repairPipeline.run(ctx);
//   result.toolCalls = repairResult.toolCalls;
//   for (const reflection of repairResult.reflections) {
//     messages.push({ role: 'user', content: reflection });
//   }
//   ```

import type { ToolCallRequest } from '../../router/types.js';
import type { RepairContext, PipelineResult, RepairStepResult } from './types.js';
import { scavenge } from './scavenge.js';
import { flatten } from './flatten.js';
import { storm } from './storm.js';
import { truncation } from './truncation.js';
import { logger } from '../../utils/logger.js';

/** 单道工序的执行器签名 */
type RepairStep = (ctx: RepairContext) => RepairStepResult;

/** pipeline 内部维护的工序列表（顺序固定，外部不可配置顺序） */
const STEPS: Array<{ name: string; fn: RepairStep }> = [
  { name: 'scavenge', fn: scavenge },
  { name: 'truncation', fn: truncation },
  { name: 'flatten', fn: flatten },
  { name: 'storm', fn: storm },
];

/**
 * 运行修复 pipeline
 *
 * @param ctx 当前轮的修复上下文
 * @returns PipelineResult.toolCalls 为修复后的工具调用列表
 *          PipelineResult.reflections 为待注入 LLM 上下文的反思提示
 */
export function run(ctx: RepairContext): PipelineResult {
  const summary: PipelineResult['summary'] = [];
  const reflections: string[] = [];
  let toolCalls: ToolCallRequest[] = [...ctx.toolCalls];

  // 逐道工序串联执行，每道工序的输出作为下一道的输入
  for (const step of STEPS) {
    // 更新上下文，让下一道工序看到最新的 toolCalls
    const stepCtx: RepairContext = { ...ctx, toolCalls };
    const result = step.fn(stepCtx);

    toolCalls = result.toolCalls;
    summary.push({ step: step.name, repaired: result.repaired, reason: result.reason });

    if (result.injectedReflection) {
      reflections.push(result.injectedReflection);
    }

    // 工序失败不中断 pipeline，继续执行下一道
    // （失败指 repaired=false，即"无需修复"，是正常路径）
    if (result.repaired) {
      logger.debug('ToolCallRepair.pipeline: step repaired', {
        step: step.name,
        reason: result.reason,
      });
    }
  }

  return { toolCalls, summary, reflections };
}
