// tests/agent/deep-review/orchestrator.test.ts
// Phase 72：编排器测试——风险评分降级、串行执行、fail-open、进度回调

import { describe, it, expect, vi } from 'vitest';
import { DeepReviewOrchestrator } from '../../../src/agent/deep-review/orchestrator.js';
import type { DeepReviewConfig, ReviewFocus } from '../../../src/agent/deep-review/types.js';
import type { ToolExecutorAdapter } from '../../../src/agent/loop-config.js';
import type { PermissionEngine } from '../../../src/tools/permission-engine.js';

/** 构造一份默认 DeepReviewConfig */
function makeConfig(overrides: Partial<DeepReviewConfig> = {}): DeepReviewConfig {
  return {
    enabled: true,
    focuses: ['correctness', 'security', 'performance', 'style'],
    parallel: 2,
    arbitration: 'critical-veto',
    aggregateMode: 'concat',
    crossModel: false,
    riskThreshold: 40,
    reviewModel: 'auto',
    reviewStrictness: 'medium',
    ...overrides,
  };
}

/** 构造 mock toolExecutor，每个 reviewer 返回固定输出 */
function makeMockToolExecutor(
  outputs: Record<ReviewFocus, string>,
  failureFocuses: ReviewFocus[] = [],
): ToolExecutorAdapter {
  return {
    getToolDefinitions: () => [],
    executeTool: vi.fn(async (_toolName: string, toolCallId: string, _args: Record<string, unknown>) => {
      // 从 toolCallId 提取 focus（orchestrator 用 `deep-review-${focus}-...` 命名）
      const focus = toolCallId.split('-').slice(2, -2).join('-') as ReviewFocus;
      if (failureFocuses.includes(focus)) {
        return '[工具错误] reviewer 执行失败';
      }
      return outputs[focus] ?? '### 总结\n（无问题）';
    }),
  };
}

/** 构造 mock permissionEngine */
function makeMockPermissionEngine(): { engine: PermissionEngine; setSandboxLevel: ReturnType<typeof vi.fn>; getSandboxLevel: ReturnType<typeof vi.fn> } {
  const setSandboxLevel = vi.fn();
  const getSandboxLevel = vi.fn(() => 'workspace-write' as const);
  const engine = {
    setSandboxLevel,
    getSandboxLevel,
  } as unknown as PermissionEngine;
  return { engine, setSandboxLevel, getSandboxLevel };
}

/** 一段含 critical 问题的输出 */
const CRITICAL_OUTPUT = `### Critical（必须修复）
- [src/auth.ts:42] 密码明文存储 → 使用 bcrypt

### 总结
问题总数：1 个（critical: 1, major: 0, minor: 0）`;

/** 无问题输出 */
const CLEAN_OUTPUT = `### 总结
问题总数：0 个`;

describe('DeepReviewOrchestrator', () => {
  describe('review', () => {
    it('配置 enabled=false → 直接降级（triggered=false）', async () => {
      const config = makeConfig({ enabled: false });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor({} as Record<ReviewFocus, string>),
        config,
        cwd: '.',
      });

      const result = await orchestrator.review({
        diff: '+'.repeat(200),
        changedFiles: ['security/auth.ts'],
      });

      expect(result.triggered).toBe(false);
      expect(result.reports).toHaveLength(0);
    });

    it('风险评分低于阈值 → triggered=false', async () => {
      // 阈值 40，构造低风险变更：少量行 + 普通文件
      const config = makeConfig({ riskThreshold: 40 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor({} as Record<ReviewFocus, string>),
        config,
        cwd: '.',
      });

      const result = await orchestrator.review({
        diff: '+a\n+b', // 2 行新增 → 行数 0 分
        changedFiles: ['foo.ts'], // 文件 3 分
      });

      expect(result.triggered).toBe(false);
      expect(result.riskScore).toBeLessThan(40);
    });

    it('风险评分达标 → triggered=true 并执行 reviewer', async () => {
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CLEAN_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      const config = makeConfig({ riskThreshold: 10 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor(outputs),
        config,
        cwd: '.',
      });

      // 构造高风险变更：500 行 + security 路径
      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      const result = await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
      });

      expect(result.triggered).toBe(true);
      expect(result.reports).toHaveLength(4); // 4 个 focus
      expect(result.reports.every(r => r.success)).toBe(true);
    });

    it('串行执行 4 个 reviewer（每个 focus 一个）', async () => {
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CLEAN_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      const mockExecutor = makeMockToolExecutor(outputs);
      const config = makeConfig({ riskThreshold: 10 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: mockExecutor,
        config,
        cwd: '.',
      });

      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
      });

      // 应调用 spawn_agent 4 次（每个 focus 一次）
      expect(mockExecutor.executeTool).toHaveBeenCalledTimes(4);
    });

    it('单个 reviewer 失败不阻断（fail-open）', async () => {
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CLEAN_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      // 让 security 失败
      const mockExecutor = makeMockToolExecutor(outputs, ['security']);
      const config = makeConfig({ riskThreshold: 10 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: mockExecutor,
        config,
        cwd: '.',
      });

      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      const result = await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
      });

      // 4 个 reviewer 都被执行（失败的不阻断）
      expect(result.reports).toHaveLength(4);
      // security 失败
      const securityReport = result.reports.find(r => r.focus === 'security');
      expect(securityReport?.success).toBe(false);
      expect(securityReport?.error).toContain('[工具错误]');
      // 其他成功
      const successCount = result.reports.filter(r => r.success).length;
      expect(successCount).toBe(3);
      // 整体结果仍返回（未抛异常）
      expect(result.triggered).toBe(true);
    });

    it('进度回调被调用', async () => {
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CLEAN_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      const config = makeConfig({ riskThreshold: 10 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor(outputs),
        config,
        cwd: '.',
      });

      const onProgress = vi.fn();
      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
        onProgress,
      });

      // 4 个 reviewer → 进度回调应被调用 4 次
      expect(onProgress).toHaveBeenCalledTimes(4);
      // 第一次调用：completed=1, total=4
      expect(onProgress.mock.calls[0][0]).toBe(1);
      expect(onProgress.mock.calls[0][1]).toBe(4);
      // 最后一次：completed=4
      expect(onProgress.mock.calls[3][0]).toBe(4);
    });

    it('沙箱级在每次 spawn 前后正确切换与恢复', async () => {
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CLEAN_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      const { engine, setSandboxLevel, getSandboxLevel } = makeMockPermissionEngine();
      const config = makeConfig({ riskThreshold: 10 });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor(outputs),
        permissionEngine: engine,
        config,
        cwd: '.',
      });

      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
      });

      // getSandboxLevel 调用 4 次（每个 reviewer 一次，用于保存原级）
      expect(getSandboxLevel).toHaveBeenCalledTimes(4);
      // setSandboxLevel 调用 8 次：4 次设为 read-only + 4 次恢复
      expect(setSandboxLevel).toHaveBeenCalledTimes(8);
      // 第一次设为 read-only
      expect(setSandboxLevel.mock.calls[0][0]).toBe('read-only');
      // 最后一次恢复为原级
      expect(setSandboxLevel.mock.calls[7][0]).toBe('workspace-write');
    });

    it('仲裁结论正确反映问题严重度', async () => {
      // security reviewer 返回 critical 问题
      const outputs: Record<ReviewFocus, string> = {
        correctness: CLEAN_OUTPUT,
        security: CRITICAL_OUTPUT,
        performance: CLEAN_OUTPUT,
        style: CLEAN_OUTPUT,
      };
      const config = makeConfig({
        riskThreshold: 10,
        arbitration: 'critical-veto',
      });
      const orchestrator = new DeepReviewOrchestrator({
        toolExecutor: makeMockToolExecutor(outputs),
        config,
        cwd: '.',
      });

      const diff = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      const result = await orchestrator.review({
        diff,
        changedFiles: ['security/auth.ts'],
      });

      // 有 critical → critical-veto → reject
      expect(result.arbitration).toBe('reject');
      expect(result.aggregatedIssues.some(i => i.severity === 'critical')).toBe(true);
    });
  });
});
