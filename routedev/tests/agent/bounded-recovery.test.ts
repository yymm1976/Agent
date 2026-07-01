// tests/agent/bounded-recovery.test.ts
// Phase 52 Task 3：长程工作流有界局部恢复测试
//
// 覆盖场景：
//   1. 步骤失败时计算恢复范围正确（包含失败步骤及其依赖）
//   2. 恢复范围超过 maxBacktrack 时返回 isGlobalRerun=true
//   3. 恢复后验证工件一致性（validateArtifactConsistency）
//   4. 下游工件在恢复后正确失效（invalidateDownstreamArtifacts）
//   5. artifactBinding=true 时工件被注册（registerArtifact + getArtifact）
//   6. 配置开关默认 false 时（BoundedRecoveryManager 仍可实例化）
//   7. 失败步骤不在 allStepIds 中时回退到全局重跑
//   8. 传递依赖闭包扩展（多层 dependsOn）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BoundedRecoveryManager,
  createBoundedRecoveryManager,
  type StepArtifact,
  type RecoveryScope,
} from '../../src/agent/bounded-recovery.js';
import {
  AppConfigSchema,
  BoundedRecoveryConfigSchema,
} from '../../src/config/schema.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建测试用 StepArtifact */
function makeArtifact(
  stepId: string,
  dependsOn: string[] = [],
  type: StepArtifact['type'] = 'code_change',
): StepArtifact {
  return {
    stepId,
    type,
    summary: `${stepId} 产出`,
    location: `/tmp/${stepId}.txt`,
    dependsOn,
    producedAt: Date.now(),
  };
}

/** 注册一组步骤工件（按顺序，每个依赖前一个） */
function registerLinearChain(
  manager: BoundedRecoveryManager,
  stepIds: string[],
): void {
  for (let i = 0; i < stepIds.length; i++) {
    const dependsOn = i > 0 ? [stepIds[i - 1]] : [];
    manager.registerArtifact(makeArtifact(stepIds[i], dependsOn));
  }
}

// ============================================================
// 测试用例
// ============================================================

describe('BoundedRecoveryManager 有界局部恢复 (Phase 52 Task 3)', () => {
  let manager: BoundedRecoveryManager;

  beforeEach(() => {
    manager = createBoundedRecoveryManager();
  });

  // ============================================================
  // 场景 1：步骤失败时计算恢复范围正确
  // ============================================================
  describe('computeRecoveryScope 基本计算', () => {
    it('步骤失败时计算恢复范围正确（包含失败步骤及其依赖）', () => {
      // 步骤链：s1 → s2 → s3 → s4 → s5
      // s3 失败，maxBacktrack=3
      // 预期回溯范围：s3, s2, s1（向前回溯 3 步含失败步骤）
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s3', 3, stepIds);

      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.failedStepId).toBe('s3');
      // 回溯 3 步：s1, s2, s3（按依赖顺序）
      expect(scope.stepsToRerun).toEqual(['s1', 's2', 's3']);
      expect(scope.stepsToRerun).toContain('s3');
      expect(scope.reason).toContain('局部恢复');
    });

    it('失败步骤在边界时回溯范围不超过 allStepIds 起点', () => {
      // s1 失败，maxBacktrack=3，但 s1 前面没有步骤
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s1', 3, stepIds);

      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.stepsToRerun).toEqual(['s1']);
    });

    it('下游工件被正确收集到 invalidatedArtifacts', () => {
      // 步骤链：s1 → s2 → s3 → s4 → s5
      // s2 失败，maxBacktrack=2 → 回溯 s1, s2
      // 下游：s3, s4, s5 依赖了 s2（传递依赖）
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s2', 2, stepIds);

      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.stepsToRerun).toEqual(['s1', 's2']);
      // s3 直接依赖 s2，s4 依赖 s3，s5 依赖 s4——都是下游
      expect(scope.invalidatedArtifacts).toContain('s3');
      expect(scope.invalidatedArtifacts).toContain('s4');
      expect(scope.invalidatedArtifacts).toContain('s5');
    });
  });

  // ============================================================
  // 场景 2：恢复范围超过 maxBacktrack 时返回 isGlobalRerun=true
  // ============================================================
  describe('isGlobalRerun 触发条件', () => {
    it('依赖闭包扩展超过 maxBacktrack 时返回 isGlobalRerun=true', () => {
      // 步骤链：s1 → s2 → s3 → s4 → s5
      // s5 失败，maxBacktrack=2 → 初始回溯 s4, s5
      // 但 s4 依赖 s3, s3 依赖 s2, s2 依赖 s1 → 闭包扩展到 5 步，超过 maxBacktrack=2
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s5', 2, stepIds);

      expect(scope.isGlobalRerun).toBe(true);
      expect(scope.stepsToRerun).toEqual([]);
      expect(scope.reason).toContain('超过 maxBacktrack');
    });

    it('失败步骤不在 allStepIds 中时回退到全局重跑', () => {
      const stepIds = ['s1', 's2', 's3'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('nonexistent', 3, stepIds);

      expect(scope.isGlobalRerun).toBe(true);
      expect(scope.stepsToRerun).toEqual([]);
      expect(scope.reason).toContain('不在步骤列表中');
    });

    it('依赖闭包刚好等于 maxBacktrack 时不触发全局重跑', () => {
      // s3 失败，maxBacktrack=3，s3 依赖 s2，s2 依赖 s1
      // 闭包：s1, s2, s3 = 3 步，等于 maxBacktrack
      const stepIds = ['s1', 's2', 's3', 's4'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s3', 3, stepIds);

      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.stepsToRerun).toHaveLength(3);
    });
  });

  // ============================================================
  // 场景 3：恢复后验证工件一致性
  // ============================================================
  describe('validateArtifactConsistency 一致性验证', () => {
    it('恢复后所有工件依赖链完整时返回 true', () => {
      // 步骤链：s1 → s2 → s3 → s4
      // s3 失败，回溯 s1, s2, s3
      // s4 依赖 s3（s3 在重跑集合中）→ 一致
      const stepIds = ['s1', 's2', 's3', 's4'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s3', 3, stepIds);
      const isConsistent = manager.validateArtifactConsistency(scope);

      expect(isConsistent).toBe(true);
    });

    it('下游工件依赖了已失效但未重跑的工件时返回 false（陷阱 #173）', () => {
      // 构造场景：
      //   s1 → s2 → s3
      //   s4 依赖 s2（s4 是 s2 的下游，但不依赖 s3）
      // s3 失败，maxBacktrack=1 → 只重跑 s3
      // 但 s2 的下游 s4 仍存在，且 s2 不在重跑集合中
      // 此时如果手动把 s2 标记为失效但不重跑，s4 的依赖就断了
      const stepIds = ['s1', 's2', 's3', 's4'];
      manager.registerArtifact(makeArtifact('s1', []));
      manager.registerArtifact(makeArtifact('s2', ['s1']));
      manager.registerArtifact(makeArtifact('s3', ['s2']));
      manager.registerArtifact(makeArtifact('s4', ['s2'])); // s4 也依赖 s2

      // s3 失败，maxBacktrack=1 → 只重跑 s3
      const scope = manager.computeRecoveryScope('s3', 1, stepIds);

      // 手动构造不一致场景：把 s2 加入 invalidatedArtifacts 但不加入 stepsToRerun
      const inconsistentScope: RecoveryScope = {
        ...scope,
        invalidatedArtifacts: ['s2', ...scope.invalidatedArtifacts],
      };

      const isConsistent = manager.validateArtifactConsistency(inconsistentScope);
      expect(isConsistent).toBe(false);
    });

    it('全局重跑场景下一致性检查通过（所有工件都将被重跑）', () => {
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      // 触发全局重跑
      const scope = manager.computeRecoveryScope('s5', 2, stepIds);
      expect(scope.isGlobalRerun).toBe(true);

      // 全局重跑时 stepsToRerun 为空，但 invalidatedArtifacts 包含下游
      // 一致性检查应通过（因为没有工件依赖了"已失效但未重跑"的工件）
      const isConsistent = manager.validateArtifactConsistency(scope);
      expect(isConsistent).toBe(true);
    });
  });

  // ============================================================
  // 场景 4：下游工件在恢复后正确失效
  // ============================================================
  describe('invalidateDownstreamArtifacts 下游清理', () => {
    it('清理依赖了回溯步骤的下游工件', () => {
      // 步骤链：s1 → s2 → s3 → s4 → s5
      // s2 失败，maxBacktrack=2 → 回溯 s1, s2
      // 下游 s3, s4, s5 应被清理
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s2', 2, stepIds);
      expect(scope.invalidatedArtifacts).toContain('s3');
      expect(scope.invalidatedArtifacts).toContain('s4');
      expect(scope.invalidatedArtifacts).toContain('s5');

      // 清理前工件存在
      expect(manager.getArtifact('s3')).toBeDefined();
      expect(manager.getArtifact('s4')).toBeDefined();
      expect(manager.getArtifact('s5')).toBeDefined();

      manager.invalidateDownstreamArtifacts(scope);

      // 清理后下游工件被移除
      expect(manager.getArtifact('s3')).toBeUndefined();
      expect(manager.getArtifact('s4')).toBeUndefined();
      expect(manager.getArtifact('s5')).toBeUndefined();
      // 重跑集合中的工件保留（将由重跑步骤重新产出）
      expect(manager.getArtifact('s1')).toBeDefined();
      expect(manager.getArtifact('s2')).toBeDefined();
    });

    it('无下游工件时清理操作安全', () => {
      // 只有 s1，s1 失败，无下游
      const stepIds = ['s1'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s1', 1, stepIds);
      expect(scope.invalidatedArtifacts).toEqual([]);

      // 不应抛出异常
      expect(() => manager.invalidateDownstreamArtifacts(scope)).not.toThrow();
    });

    it('全局重跑场景下清理所有下游工件', () => {
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      registerLinearChain(manager, stepIds);

      const scope = manager.computeRecoveryScope('s5', 2, stepIds);
      expect(scope.isGlobalRerun).toBe(true);

      // 全局重跑时 stepsToRerun 为空，所有下游工件都应被清理
      manager.invalidateDownstreamArtifacts(scope);

      // 至少部分下游被清理（具体哪些取决于 collectDownstreamArtifacts 的实现）
      const remaining = manager.getAllArtifacts();
      // 全局重跑不重跑任何步骤，所以 invalidatedArtifacts 中的都被清理了
      for (const stepId of scope.invalidatedArtifacts) {
        expect(remaining.find((a) => a.stepId === stepId)).toBeUndefined();
      }
    });
  });

  // ============================================================
  // 场景 5：artifactBinding=true 时工件被注册
  // ============================================================
  describe('工件注册与查询', () => {
    it('registerArtifact 注册后 getArtifact 可查询', () => {
      const artifact = makeArtifact('step-a', []);
      manager.registerArtifact(artifact);

      const retrieved = manager.getArtifact('step-a');
      expect(retrieved).toBeDefined();
      expect(retrieved?.stepId).toBe('step-a');
      expect(retrieved?.type).toBe('code_change');
      expect(retrieved?.summary).toBe('step-a 产出');
      expect(retrieved?.dependsOn).toEqual([]);
    });

    it('未注册的 stepId 查询返回 undefined', () => {
      expect(manager.getArtifact('nonexistent')).toBeUndefined();
    });

    it('getAllArtifacts 返回所有已注册工件', () => {
      manager.registerArtifact(makeArtifact('a1', []));
      manager.registerArtifact(makeArtifact('a2', ['a1']));
      manager.registerArtifact(makeArtifact('a3', ['a2']));

      const all = manager.getAllArtifacts();
      expect(all).toHaveLength(3);
      expect(all.map((a) => a.stepId)).toEqual(['a1', 'a2', 'a3']);
    });

    it('重复注册同一 stepId 时后者覆盖前者', () => {
      manager.registerArtifact(makeArtifact('s1', [], 'code_change'));
      manager.registerArtifact(makeArtifact('s1', [], 'test_result'));

      const retrieved = manager.getArtifact('s1');
      expect(retrieved?.type).toBe('test_result');
    });
  });

  // ============================================================
  // 场景 6：配置开关默认 false 时仍可实例化
  // ============================================================
  describe('配置开关与实例化', () => {
    it('BoundedRecoveryManager 在配置默认 false 时仍可实例化', () => {
      // 配置开关在接入层控制，BoundedRecoveryManager 本身不依赖配置
      const m = createBoundedRecoveryManager();
      expect(m).toBeInstanceOf(BoundedRecoveryManager);
      expect(m.getAllArtifacts()).toEqual([]);
    });

    it('BoundedRecoveryConfigSchema 默认值正确（enabled=false）', () => {
      const defaultConfig = BoundedRecoveryConfigSchema.parse({});
      expect(defaultConfig.enabled).toBe(false);
      expect(defaultConfig.maxBacktrack).toBe(3);
      expect(defaultConfig.artifactBinding).toBe(true);
      expect(defaultConfig.validateConsistency).toBe(true);
    });

    it('AppConfigSchema 包含 boundedRecovery 字段且默认值正确', () => {
      const config = AppConfigSchema.safeParse({});
      expect(config.success).toBe(true);
      if (config.success) {
        expect(config.data.boundedRecovery).toBeDefined();
        expect(config.data.boundedRecovery.enabled).toBe(false);
        expect(config.data.boundedRecovery.maxBacktrack).toBe(3);
      }
    });

    it('BoundedRecoveryConfigSchema 拒绝 maxBacktrack 超出范围', () => {
      // maxBacktrack 最小 1
      const tooSmall = BoundedRecoveryConfigSchema.safeParse({
        maxBacktrack: 0,
      });
      expect(tooSmall.success).toBe(false);

      // maxBacktrack 最大 10
      const tooLarge = BoundedRecoveryConfigSchema.safeParse({
        maxBacktrack: 11,
      });
      expect(tooLarge.success).toBe(false);

      // 合法值
      const valid = BoundedRecoveryConfigSchema.safeParse({
        maxBacktrack: 5,
      });
      expect(valid.success).toBe(true);
    });
  });

  // ============================================================
  // 场景 7：传递依赖闭包扩展
  // ============================================================
  describe('传递依赖闭包', () => {
    it('多层 dependsOn 传递依赖被正确扩展到回溯范围', () => {
      // 构造场景：
      //   s1 → s2 → s3（线性链）
      //   s4 依赖 s1（分支）
      //   s5 依赖 s4
      // s3 失败，maxBacktrack=2 → 初始回溯 s2, s3
      // s2 依赖 s1 → 扩展纳入 s1
      // 闭包：s1, s2, s3 = 3 步，超过 maxBacktrack=2 → 全局重跑
      const stepIds = ['s1', 's2', 's3', 's4', 's5'];
      manager.registerArtifact(makeArtifact('s1', []));
      manager.registerArtifact(makeArtifact('s2', ['s1']));
      manager.registerArtifact(makeArtifact('s3', ['s2']));
      manager.registerArtifact(makeArtifact('s4', ['s1']));
      manager.registerArtifact(makeArtifact('s5', ['s4']));

      const scope = manager.computeRecoveryScope('s3', 2, stepIds);
      expect(scope.isGlobalRerun).toBe(true);
    });

    it('分支依赖不扩展时保持局部恢复', () => {
      // 构造场景：
      //   s1 → s2 → s3
      //   s4 独立（不依赖 s1/s2/s3）
      // s3 失败，maxBacktrack=3 → 回溯 s1, s2, s3
      // s4 不在依赖闭包中，不应被纳入
      const stepIds = ['s1', 's2', 's3', 's4'];
      manager.registerArtifact(makeArtifact('s1', []));
      manager.registerArtifact(makeArtifact('s2', ['s1']));
      manager.registerArtifact(makeArtifact('s3', ['s2']));
      manager.registerArtifact(makeArtifact('s4', [])); // 独立

      const scope = manager.computeRecoveryScope('s3', 3, stepIds);
      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.stepsToRerun).toEqual(['s1', 's2', 's3']);
      // s4 不在重跑集合中
      expect(scope.stepsToRerun).not.toContain('s4');
    });

    it('跨分支下游工件被正确识别', () => {
      // 构造场景：
      //   s1 → s2 → s3
      //   s1 → s4（s4 也依赖 s1）
      // s2 失败，maxBacktrack=2 → 回溯 s1, s2
      // s3 依赖 s2（下游），s4 依赖 s1（也是下游，因为 s1 在重跑集合中）
      const stepIds = ['s1', 's2', 's3', 's4'];
      manager.registerArtifact(makeArtifact('s1', []));
      manager.registerArtifact(makeArtifact('s2', ['s1']));
      manager.registerArtifact(makeArtifact('s3', ['s2']));
      manager.registerArtifact(makeArtifact('s4', ['s1']));

      const scope = manager.computeRecoveryScope('s2', 2, stepIds);
      expect(scope.isGlobalRerun).toBe(false);
      expect(scope.stepsToRerun).toEqual(['s1', 's2']);
      // s3 和 s4 都是下游（依赖了 s1 或 s2）
      expect(scope.invalidatedArtifacts).toContain('s3');
      expect(scope.invalidatedArtifacts).toContain('s4');
    });
  });
});
