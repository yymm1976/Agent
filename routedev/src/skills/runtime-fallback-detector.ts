// src/skills/runtime-fallback-detector.ts
// 运行时兜底检测器（Phase 49 Task 3.7）
//
// 知识库原文（主题-AI项目长期迭代 失败模式表）：
//   "AI 兜底不告知 → 累积大量'看起来对但实际错'的代码。"
//
// 与 FallbackChecker（3.3）的区别：
//   - FallbackChecker 检查 Skill 文本中是否有兜底声明配对确认指令（静态检查）
//   - RuntimeFallbackDetector 检查 Skill 执行中 AI 是否默默降级（运行时检测）
//
// 实现：
//   - 检测 AI 输出中的"兜底信号词"：改用、回退、降级、跳过、暂时、先用...代替
//   - 检测到兜底信号 → 检查是否伴随"已询问用户"或"等待确认"
//   - 未询问就兜底 → 标记为违规，记录到质量审计日志
//
// 集成点：作为 SkillFlow 引擎的中间件，在每个 step 节点输出后检测。

/** 运行时兜底违规 */
export interface FallbackViolation {
  /** 违规类型 */
  type: 'silent-fallback';
  /** 匹配到的兜底信号词 */
  signal: string;
  /** 输出摘要（前 200 字符） */
  excerpt: string;
  /** 修复建议 */
  suggestion: string;
}

/**
 * 兜底信号正则——匹配 AI 输出中的兜底行为
 *
 * 匹配：
 *   - 改用 / 回退到 / 降级为
 *   - 跳过 N 个字符后接"步骤"
 *   - 暂时使用 / 先用 N 个字符后接"代替"
 *   - 简化处理
 */
const FALLBACK_SIGNALS = /改用|回退到|降级为|跳过.{0,4}步骤|暂时使用|先用.{0,8}代替|简化处理/i;

/**
 * 确认信号正则——匹配 AI 输出中的显式确认
 *
 * 匹配：
 *   - 询问用户 / 请用户确认 / 等待确认 / 已告知用户
 *   - abort...ask（英文）
 */
const CONFIRM_SIGNALS = /询问用户|请用户确认|等待确认|已告知用户|abort.*ask/i;

/** 输出摘要最大长度 */
const EXCERPT_MAX_LENGTH = 200;

/**
 * 运行时兜底检测器——检测 AI 在 Skill 执行中是否默默降级
 *
 * 用法：
 *   const violation = RuntimeFallbackDetector.detect(aiOutput);
 *   if (violation) {
 *     // 记录到审计日志，提示用户
 *   }
 */
export class RuntimeFallbackDetector {
  /**
   * 检测单条 AI 输出是否有未告知的兜底
   *
   * 判定逻辑：
   *   - 输出含兜底信号词（如"改用"）且无确认信号词（如"询问用户"）→ 返回违规
   *   - 输出含兜底信号词且含确认信号词 → 返回 null（已显式确认，合规）
   *   - 输出无兜底信号词 → 返回 null（无兜底行为）
   *
   * @param output AI 的单条输出文本
   * @returns 违规对象（检测到未告知兜底时）或 null（合规）
   */
  static detect(output: string): FallbackViolation | null {
    if (!output || typeof output !== 'string') {
      return null;
    }

    const hasFallbackSignal = FALLBACK_SIGNALS.test(output);
    if (!hasFallbackSignal) {
      // 无兜底信号 → 合规
      return null;
    }

    const hasConfirmSignal = CONFIRM_SIGNALS.test(output);
    if (hasConfirmSignal) {
      // 有兜底信号但有显式确认 → 合规
      return null;
    }

    // 检测到兜底信号且无确认 → 违规
    const matched = output.match(FALLBACK_SIGNALS)?.[0] ?? '';
    return {
      type: 'silent-fallback',
      signal: matched,
      excerpt: output.slice(0, EXCERPT_MAX_LENGTH),
      suggestion: '检测到 AI 默默兜底，请确认是否已告知用户',
    };
  }
}
