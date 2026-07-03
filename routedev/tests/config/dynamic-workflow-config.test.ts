import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('DynamicWorkflowConfig schema', () => {
  describe('默认值', () => {
    it('解析空对象时所有子字段使用默认值', () => {
      const result = AppConfigSchema.parse({ ...DEFAULT_CONFIG, dynamicWorkflow: {} });
      const dw = result.dynamicWorkflow;
      expect(dw.enabled).toBe(false);
      expect(dw.synthesizeBarrier.enabled).toBe(false);
      expect(dw.synthesizeBarrier.barrierTimeoutMs).toBe(60000);
      expect(dw.synthesizeBarrier.defaultStrategy).toBe('concat-dedup');
      expect(dw.loopUntilDone.maxRounds).toBe(5);
      expect(dw.quarantine.contaminationTraceDepth).toBe(10);
      expect(dw.tournament.candidateCount).toBe(3);
    });

    it('完全省略 dynamicWorkflow 字段时使用默认值', () => {
      const { dynamicWorkflow: _, ...rest } = DEFAULT_CONFIG as Record<string, unknown>;
      const result = AppConfigSchema.parse(rest);
      expect(result.dynamicWorkflow.enabled).toBe(false);
    });
  });

  describe('synthesizeBarrier 配置验证', () => {
    it('strategy 只允许三种枚举值', () => {
      expect(() =>
        AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            synthesizeBarrier: { defaultStrategy: 'invalid-strategy' },
          },
        }),
      ).toThrow();
    });

    it('有效 strategy 值可以被解析', () => {
      for (const strategy of ['merge-fields', 'concat-dedup', 'judging'] as const) {
        const result = AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            synthesizeBarrier: { defaultStrategy: strategy },
          },
        });
        expect(result.dynamicWorkflow.synthesizeBarrier.defaultStrategy).toBe(strategy);
      }
    });
  });

  describe('loopUntilDone 配置验证', () => {
    it('maxRounds 超过 20 时抛出验证错误', () => {
      expect(() =>
        AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            loopUntilDone: { maxRounds: 25 },
          },
        }),
      ).toThrow();
    });

    it('maxRounds 在有效范围内可以被解析', () => {
      const result = AppConfigSchema.parse({
        ...DEFAULT_CONFIG,
        dynamicWorkflow: {
          loopUntilDone: { maxRounds: 10 },
        },
      });
      expect(result.dynamicWorkflow.loopUntilDone.maxRounds).toBe(10);
    });
  });

  describe('tournament 配置验证', () => {
    it('candidateCount 超过 5 时抛出验证错误', () => {
      expect(() =>
        AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            tournament: { candidateCount: 6 },
          },
        }),
      ).toThrow();
    });

    it('candidateCount 在有效范围内可以被解析', () => {
      const result = AppConfigSchema.parse({
        ...DEFAULT_CONFIG,
        dynamicWorkflow: {
          tournament: { candidateCount: 4 },
        },
      });
      expect(result.dynamicWorkflow.tournament.candidateCount).toBe(4);
    });
  });

  describe('adversarialVerification 配置', () => {
    it('frequency 只允许三种枚举值', () => {
      expect(() =>
        AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            adversarialVerification: { frequency: 'never' },
          },
        }),
      ).toThrow();
    });

    it('valid frequency 可以被解析', () => {
      for (const freq of ['every-step', 'every-n-steps', 'end-only'] as const) {
        const result = AppConfigSchema.parse({
          ...DEFAULT_CONFIG,
          dynamicWorkflow: {
            adversarialVerification: { frequency: freq },
          },
        });
        expect(result.dynamicWorkflow.adversarialVerification.frequency).toBe(freq);
      }
    });
  });

  describe('quarantine 配置', () => {
    it('untrustedDeniedTools 默认包含四个受限工具', () => {
      const result = AppConfigSchema.parse({ ...DEFAULT_CONFIG });
      const denied = result.dynamicWorkflow.quarantine.untrustedDeniedTools;
      expect(denied).toContain('file_write');
      expect(denied).toContain('file_edit');
      expect(denied).toContain('shell_exec');
      expect(denied).toContain('git_op');
    });
  });
});
