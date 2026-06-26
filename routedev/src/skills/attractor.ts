// src/skills/attractor.ts
// 吸因子引导层（Phase 49 Task 1.7 — Attractor）
//
// 知识库原文（主题-AI项目长期迭代）：
//   "Harness 是约束，吸因子是引导。把 AI 视作团队，
//    通过引导而非约束使其收敛到稳定状态。"
//
// SkillFlow 的 checkpoint / onFailure / maxIterations 都是"约束层"——
// 告诉 AI 不能做什么、做错了怎么办。但纯约束会让 AI"被动合规"而非"主动收敛"。
// 吸因子引导层在约束之上叠加"引导"：
//   - 约束让 AI 不犯错
//   - 引导让 AI 主动做对
//   - 两者缺一不可
//
// 实现：
//   - 每个 step 节点的 prompt 末尾自动追加"吸因子提示"
//   - 吸因子提示包含：目标画像（什么样算"做对了"）+ 风格样本（参照打样）
//   - 引导而非命令：用"期望产出"而非"禁止事项"的表述

import type { FlowNode, SkillFlow } from './skill-flow-types.js';

/**
 * 吸因子注入器——在节点 prompt 末尾追加引导文本
 *
 * 对比：
 *   约束式（checkpoint）："如果构建失败，重试"
 *   引导式（吸因子）："期望产出：构建产物路径 + 成功日志。
 *                     参照样本：项目根目录的 build-sample.txt。
 *                     做到这个样子就算成功。"
 *
 * 与约束层的协同：
 *   - 吸因子在 prompt 注入阶段起作用（引导 AI 怎么做）
 *   - checkpoint 在产出验证阶段起作用（约束 AI 必须达标）
 *   - 两者不冲突——吸因子降低 AI 走偏概率，checkpoint 兜底防止吸因子失效
 */
export class AttractorInjector {
  /**
   * 为节点 prompt 追加吸因子引导
   *
   * 注：node.attractor 字段全部可选，未配置任何字段时不追加（向后兼容）。
   * 知识库警告（陷阱 151）：吸因子过度引导会让 AI 失去灵活性，
   * 因此 attractor 字段全部可选——不配置时 SkillFlow 仍能靠 checkpoint 约束运行。
   *
   * @param node 当前节点（必须有 attractor 字段才会注入）
   * @param _flow 所属流水线（保留参数，便于后续扩展跨节点引导）
   * @returns 追加吸因子引导后的 prompt；未配置 attractor 时原样返回
   */
  inject(node: FlowNode, _flow?: SkillFlow): string {
    const attractor = node.attractor;
    if (!attractor) {
      // 未配置吸因子——不注入，靠 checkpoint 约束
      return node.prompt;
    }

    // 三个字段都为空时不注入（避免空块）
    const hasDesiredOutput = attractor.desiredOutput && attractor.desiredOutput.trim().length > 0;
    const hasStyleSample = attractor.styleSample && attractor.styleSample.trim().length > 0;
    const hasDoneCriteria = attractor.doneCriteria && attractor.doneCriteria.trim().length > 0;
    if (!hasDesiredOutput && !hasStyleSample && !hasDoneCriteria) {
      return node.prompt;
    }

    // 引导而非命令：用"期望产出"而非"禁止事项"的表述
    const lines: string[] = [
      '',
      '',
      '=== 期望产出（吸因子引导）===',
      '注：以下为引导而非硬性要求，样本未覆盖的场景按项目通用规范处理',
    ];

    if (hasDesiredOutput) {
      lines.push(`目标画像：${attractor.desiredOutput}`);
    }
    if (hasStyleSample) {
      lines.push(`风格样本：参照 ${attractor.styleSample}（参照其结构/命名/错误处理风格，勿照抄业务逻辑）`);
    }
    if (hasDoneCriteria) {
      lines.push(`完成判定：${attractor.doneCriteria}`);
    }

    lines.push('=== 吸因子引导结束 ===');
    lines.push('');

    return node.prompt + lines.join('\n');
  }
}
