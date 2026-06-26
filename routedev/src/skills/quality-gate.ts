// src/skills/quality-gate.ts
// Skill 质量门集成（Phase 49 Task 3.5）
//
// 知识库原文：
//   "3 场景验证 = Skill 算合格。"
//   "Skill 写完必跑 3 场景验证：正常/边界/诱导。"
//
// 三层检查：
//   1. Schema 校验（结构完整性）—— SkillSchemaValidator
//   2. 兜底确认检查（安全性）—— FallbackChecker
//   3. 3 场景验证（功能性，可选——需要 LLM 调用）—— SkillValidator
//
// 结果：
//   - pass：全部通过
//   - fail：有危险问题（Schema 不通过 / 兜底检查不通过 / 3 场景验证不通过）
//
// 陷阱 #143：3 场景验证消耗大量 Token
//   默认只在 Skill 生成时运行，市场导入只做 Schema + 兜底检查。
//   通过 options.runScenarioValidation 显式开启。

import type { ParsedSkill } from './skill-md-parser.js';
import {
  SkillSchemaValidator,
  type SchemaValidationResult,
} from './skill-schema-validator.js';
import { FallbackChecker, type FallbackCheckResult } from './fallback-checker.js';
import {
  SkillValidator,
  type SkillValidationResult,
  type SkillValidatorDeps,
  type SkillTestCases,
} from './skill-validator.js';

/** 质量门总结果 */
export interface QualityGateResult {
  /** 总状态：pass（通过）/ warn（有警告但无危险）/ fail（有危险问题） */
  status: 'pass' | 'warn' | 'fail';
  /** Schema 校验结果 */
  schema: SchemaValidationResult;
  /** 兜底确认检查结果 */
  fallback: FallbackCheckResult;
  /** 3 场景验证结果（未运行时为 undefined） */
  scenario?: SkillValidationResult;
}

/** 质量门选项 */
export interface QualityGateOptions {
  /**
   * 是否运行 3 场景验证
   *
   * 陷阱 #143：3 场景验证消耗大量 Token
   *   - 默认 false（市场导入只做 Schema + 兜底）
   *   - Skill 生成时设为 true（需要提供 validatorDeps）
   */
  runScenarioValidation?: boolean;
  /** 3 场景验证依赖（LLM 客户端等）；runScenarioValidation=true 时必须提供 */
  validatorDeps?: SkillValidatorDeps;
  /** 用户提供的测试用例（可选） */
  testCases?: SkillTestCases;
}

/**
 * Skill 质量门——在生成/导入时自动运行
 *
 * 用法：
 *   const gate = new SkillQualityGate();
 *
 *   // 市场导入：只做 Schema + 兜底（陷阱 #143）
 *   const result1 = await gate.check(skill, {});
 *
 *   // Skill 生成：完整三层检查
 *   const result2 = await gate.check(skill, {
 *     runScenarioValidation: true,
 *     validatorDeps: { llmClient, modelId: 'gpt-4' },
 *   });
 *
 *   if (result2.status === 'fail') {
 *     // 阻止 Skill 加载，提示用户
 *   }
 */
export class SkillQualityGate {
  /**
   * 运行质量门检查
   *
   * @param skill 待检查的 Skill
   * @param options 检查选项
   * @returns 质量门总结果
   */
  async check(
    skill: ParsedSkill,
    options: QualityGateOptions = {},
  ): Promise<QualityGateResult> {
    // 1. Schema 校验（结构完整性）
    const schemaResult = SkillSchemaValidator.validate(skill);

    // 2. 兜底确认检查（安全性）
    const fallbackResult = FallbackChecker.check(skill);

    // 3. 3 场景验证（可选，陷阱 #143）
    let scenarioResult: SkillValidationResult | undefined;
    if (options.runScenarioValidation && options.validatorDeps) {
      const validator = new SkillValidator(options.validatorDeps);
      scenarioResult = await validator.validate(skill, options.testCases);
    }

    // 聚合判定
    // Schema 不通过或兜底检查不通过 → fail
    if (!schemaResult.valid || !fallbackResult.passed) {
      return {
        status: 'fail',
        schema: schemaResult,
        fallback: fallbackResult,
        scenario: scenarioResult,
      };
    }
    // 3 场景验证不通过 → fail
    if (scenarioResult && !scenarioResult.passed) {
      return {
        status: 'fail',
        schema: schemaResult,
        fallback: fallbackResult,
        scenario: scenarioResult,
      };
    }
    // 全部通过
    return {
      status: 'pass',
      schema: schemaResult,
      fallback: fallbackResult,
      scenario: scenarioResult,
    };
  }
}
