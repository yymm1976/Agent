// tests/policies/call-owner-mixin.test.ts
// Phase 66 Task 3：CallOwnerMixin 测试
//
// 覆盖：
//   1. shouldCallOwner 三分支（always_call/always_pass/conditional）
//   2. isHighRiskAction 默认关键词命中
//   3. inject 单条注入不修改原 policy
//   4. injectBatch 按类型批量注入
//   5. callOwnerCondition 自定义条件覆盖默认
//   6. 无 callOwner 字段时按 always_pass（向后兼容）

import { describe, it, expect } from 'vitest';
import { CallOwnerMixin } from '../../src/policies/call-owner-mixin.js';

describe('CallOwnerMixin (Phase 66 Task 3)', () => {
  // ============================================================
  // shouldCallOwner
  // ============================================================

  describe('shouldCallOwner', () => {
    it('1. always_call→true, always_pass→false, conditional→callOwnerCondition', () => {
      // always_call
      expect(CallOwnerMixin.shouldCallOwner({ callOwner: 'always_call' }, {})).toBe(true);
      // always_pass
      expect(CallOwnerMixin.shouldCallOwner({ callOwner: 'always_pass' }, {})).toBe(false);
      // conditional + condition returning true
      expect(
        CallOwnerMixin.shouldCallOwner(
          { callOwner: 'conditional', callOwnerCondition: () => true },
          {},
        ),
      ).toBe(true);
      // conditional + condition returning false
      expect(
        CallOwnerMixin.shouldCallOwner(
          { callOwner: 'conditional', callOwnerCondition: () => false },
          {},
        ),
      ).toBe(false);
    });

    it('5. callOwnerCondition 自定义条件覆盖默认', () => {
      // 自定义条件：基于 riskScore
      const condition = (action: any) => action.riskScore > 0.8;
      expect(
        CallOwnerMixin.shouldCallOwner(
          { callOwner: 'conditional', callOwnerCondition: condition },
          { riskScore: 0.9 },
        ),
      ).toBe(true);
      expect(
        CallOwnerMixin.shouldCallOwner(
          { callOwner: 'conditional', callOwnerCondition: condition },
          { riskScore: 0.5 },
        ),
      ).toBe(false);
    });

    it('6. 无 callOwner 字段时按 always_pass（向后兼容）', () => {
      expect(CallOwnerMixin.shouldCallOwner({}, {})).toBe(false);
      expect(CallOwnerMixin.shouldCallOwner({ otherField: 'x' }, {})).toBe(false);
      expect(CallOwnerMixin.shouldCallOwner({ callOwner: 'unknown_value' as any }, {})).toBe(false);
    });

    it('conditional 但无 callOwnerCondition 时返回 false', () => {
      expect(CallOwnerMixin.shouldCallOwner({ callOwner: 'conditional' }, {})).toBe(false);
    });

    it('callOwnerCondition 抛异常时 fail-open（返回 false）', () => {
      expect(
        CallOwnerMixin.shouldCallOwner(
          {
            callOwner: 'conditional',
            callOwnerCondition: () => {
              throw new Error('cond error');
            },
          },
          {},
        ),
      ).toBe(false);
    });
  });

  // ============================================================
  // isHighRiskAction
  // ============================================================

  describe('isHighRiskAction', () => {
    it('2. 默认关键词命中', () => {
      // 7 个默认关键词
      expect(CallOwnerMixin.isHighRiskAction({ description: '删除文件' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: '执行命令' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: '修改 .env 文件' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'rm -rf /' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'format C:' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'drop table users' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'git push --force push' })).toBe(true);
      // 安全动作
      expect(CallOwnerMixin.isHighRiskAction({ description: '查看文件内容' })).toBe(false);
      expect(CallOwnerMixin.isHighRiskAction({ description: '运行测试' })).toBe(false);
    });

    it('tool 字段也参与匹配', () => {
      expect(CallOwnerMixin.isHighRiskAction({ tool: 'rm -rf' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ tool: 'safe_tool' })).toBe(false);
    });

    it('大小写不敏感', () => {
      expect(CallOwnerMixin.isHighRiskAction({ description: 'DROP TABLE users' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'FORMAT C:' })).toBe(true);
      expect(CallOwnerMixin.isHighRiskAction({ description: 'FORCE PUSH' })).toBe(true);
    });

    it('空 action 返回 false', () => {
      expect(CallOwnerMixin.isHighRiskAction({})).toBe(false);
      expect(CallOwnerMixin.isHighRiskAction({ description: '', tool: '' })).toBe(false);
    });
  });

  // ============================================================
  // inject
  // ============================================================

  describe('inject', () => {
    it('3. inject 单条注入不修改原 policy', () => {
      const original = { id: 'p1', type: 'tool_approval', priority: 10, action: { block: true } };
      const injected = CallOwnerMixin.inject(original, 'always_call');

      // 新对象包含 callOwner
      expect(injected.callOwner).toBe('always_call');
      // 原 policy 未被修改
      expect((original as any).callOwner).toBeUndefined();
      // 其他字段保留
      expect(injected.id).toBe('p1');
      expect(injected.type).toBe('tool_approval');
      expect(injected.priority).toBe(10);
      expect(injected.action).toEqual({ block: true });
      // 不是同一对象引用
      expect(injected).not.toBe(original);
    });

    it('inject 覆盖已有的 callOwner 字段', () => {
      const policy = { id: 'p1', callOwner: 'always_pass' as const };
      const injected = CallOwnerMixin.inject(policy, 'always_call');
      expect(injected.callOwner).toBe('always_call');
      // 原 policy 不变
      expect(policy.callOwner).toBe('always_pass');
    });
  });

  // ============================================================
  // injectBatch
  // ============================================================

  describe('injectBatch', () => {
    it('4. 按类型批量注入', () => {
      const policies = [
        { id: 'p1', type: 'tool_approval' },
        { id: 'p2', type: 'intent_guard' },
        { id: 'p3', type: 'tool_approval' },
        { id: 'p4', type: 'audit_log' },
      ];
      const result = CallOwnerMixin.injectBatch(policies, 'tool_approval', 'always_call');

      // 仅 tool_approval 类型被注入
      expect(result[0].callOwner).toBe('always_call');
      expect(result[1].callOwner).toBeUndefined();
      expect(result[2].callOwner).toBe('always_call');
      expect(result[3].callOwner).toBeUndefined();

      // 原 policies 数组不变
      expect((policies[0] as any).callOwner).toBeUndefined();
      expect((policies[2] as any).callOwner).toBeUndefined();
    });

    it('injectBatch 空数组返回空数组', () => {
      const result = CallOwnerMixin.injectBatch([], 'tool_approval', 'always_call');
      expect(result).toEqual([]);
    });

    it('injectBatch 无匹配类型时全部原样返回', () => {
      const policies = [{ id: 'p1', type: 'intent_guard' }];
      const result = CallOwnerMixin.injectBatch(policies, 'tool_approval', 'always_call');
      expect(result[0].callOwner).toBeUndefined();
    });
  });
});
