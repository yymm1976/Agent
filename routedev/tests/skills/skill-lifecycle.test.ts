// tests/skills/skill-lifecycle.test.ts
// Skill 生命周期管理单元测试（Phase 52 Task 1）
//
// 测试策略：
//   - 构造 TaskRecord 历史与 SkillExecutionRecord 执行记录
//   - 验证五阶段生命周期的关键行为：
//     1. Creation — checkCreationTrigger 在重复相似任务时给出建议
//     2. Memory — recordExecution 写入 SkillMemory
//     3. Evaluation / Refinement — extractFailurePatterns 与 proposeRefinement
//     4. Management — cleanupExpiredMemory 清理过期记忆
//   - 验证陷阱 #171：failurePatterns/successPaths 各 ≤ 20 条
//   - 验证 autoApplyRefinement=false 时 requiresUserApproval === true

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SkillLifecycleManager,
  type TaskRecord,
  type SkillExecutionRecord,
} from '../../src/skills/skill-lifecycle.js';
import type { SkillLifecycleConfig } from '../../src/config/schema.js';

// ============================================================
// 工具函数
// ============================================================

/** 默认开启的配置（用于多数测试） */
function makeEnabledConfig(
  overrides: Partial<SkillLifecycleConfig> = {},
): SkillLifecycleConfig {
  return {
    enabled: true,
    creationTriggerThreshold: 3,
    memoryRetentionDays: 30,
    autoApplyRefinement: false,
    ...overrides,
  };
}

/** 构造单条任务记录 */
function makeTask(
  description: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    description,
    timestamp: Date.now(),
    outcome: 'success',
    ...overrides,
  };
}

/** 构造单条执行记录 */
function makeExecution(
  overrides: Partial<SkillExecutionRecord> = {},
): SkillExecutionRecord {
  return {
    timestamp: Date.now(),
    taskDescription: 'test task',
    stepsTaken: ['step1', 'step2'],
    outcome: 'success',
    durationMs: 1000,
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// 测试用例
// ============================================================

describe('SkillLifecycleManager (Phase 52 Task 1)', () => {
  let manager: SkillLifecycleManager;

  beforeEach(() => {
    manager = new SkillLifecycleManager(makeEnabledConfig());
  });

  // ---- Creation 阶段 ----

  it('1. 重复执行相似任务 ≥ 阈值时触发创建建议', () => {
    // 3 条高度相似的任务描述（共享多个关键词）
    const history: TaskRecord[] = [
      makeTask('运行单元测试 vitest'),
      makeTask('运行单元测试 jest'),
      makeTask('运行单元测试 mocha'),
    ];

    const suggestion = manager.checkCreationTrigger(history);

    expect(suggestion).not.toBeNull();
    expect(suggestion!.similarTaskCount).toBeGreaterThanOrEqual(3);
    expect(suggestion!.exampleTaskDescriptions.length).toBeGreaterThan(0);
    expect(suggestion!.reason).toContain('相似任务');
  });

  it('7. 配置开关默认 false 时不执行任何操作（checkCreationTrigger 返回 null）', () => {
    const disabledManager = new SkillLifecycleManager(
      makeEnabledConfig({ enabled: false }),
    );
    // 即便有大量相似任务，开关关闭时也不应触发
    const history: TaskRecord[] = [
      makeTask('运行单元测试 vitest'),
      makeTask('运行单元测试 vitest'),
      makeTask('运行单元测试 vitest'),
    ];

    const suggestion = disabledManager.checkCreationTrigger(history);
    expect(suggestion).toBeNull();
  });

  // ---- Memory 阶段 ----

  it('2. Skill 执行后记录到 SkillMemory', () => {
    const record = makeExecution({
      taskDescription: '执行部署',
      stepsTaken: ['拉取代码', '构建镜像', 'kubectl apply'],
      outcome: 'success',
    });

    manager.recordExecution('skill-deploy', record);

    const memory = manager.getMemory('skill-deploy');
    expect(memory).toBeDefined();
    expect(memory!.skillId).toBe('skill-deploy');
    expect(memory!.executions).toHaveLength(1);
    expect(memory!.executions[0].taskDescription).toBe('执行部署');
    // 成功路径应被记录
    expect(memory!.successPaths).toHaveLength(1);
    expect(memory!.successPaths[0]).toEqual(['拉取代码', '构建镜像', 'kubectl apply']);
  });

  // ---- Evaluation 阶段 ----

  it('3. 失败模式从执行历史中正确聚类', () => {
    const skillId = 'skill-deploy';
    // 同一 failurePoint 出现 3 次，应聚合成 frequency=3
    for (let i = 0; i < 3; i++) {
      manager.recordExecution(
        skillId,
        makeExecution({
          outcome: 'failure',
          failurePoint: '镜像推送超时',
          timestamp: Date.now() - i * 1000,
        }),
      );
    }
    // 另一种 failurePoint 出现 2 次
    for (let i = 0; i < 2; i++) {
      manager.recordExecution(
        skillId,
        makeExecution({
          outcome: 'partial',
          failurePoint: 'kubeconfig 无效',
          timestamp: Date.now() - i * 1000,
        }),
      );
    }

    const patterns = manager.extractFailurePatterns(skillId);

    // 应聚合成 2 条模式
    expect(patterns).toHaveLength(2);
    // 按频率降序：镜像推送超时(3) > kubeconfig 无效(2)
    expect(patterns[0].pattern).toBe('镜像推送超时');
    expect(patterns[0].frequency).toBe(3);
    expect(patterns[1].pattern).toBe('kubeconfig 无效');
    expect(patterns[1].frequency).toBe(2);
    // exampleExecutionIds 至少有 1 条
    expect(patterns[0].exampleExecutionIds.length).toBeGreaterThan(0);
  });

  // ---- Refinement 阶段 ----

  it('4. 优化建议基于失败模式生成', () => {
    const skillId = 'skill-deploy';
    // 注入失败记录
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'failure', failurePoint: '镜像推送超时' }),
    );
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'failure', failurePoint: '镜像推送超时' }),
    );
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'success' }),
    );

    const proposal = manager.proposeRefinement(skillId);

    expect(proposal).not.toBeNull();
    expect(proposal!.skillId).toBe(skillId);
    expect(proposal!.basedOnFailurePatterns).toContain('镜像推送超时');
    expect(proposal!.proposedChanges).toContain('镜像推送超时');
    expect(proposal!.expectedImprovement).toContain('镜像推送超时');
    // 应包含成功/失败次数的统计
    expect(proposal!.rationale).toMatch(/\d+\s*次失败/);
  });

  it('5. autoApplyRefinement=false 时不自动修改 Skill（requiresUserApproval === true）', () => {
    const skillId = 'skill-deploy';
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'failure', failurePoint: '网络超时' }),
    );

    const proposal = manager.proposeRefinement(skillId);

    expect(proposal).not.toBeNull();
    // autoApplyRefinement=false 时必须要求用户审批
    expect(proposal!.requiresUserApproval).toBe(true);
  });

  it('autoApplyRefinement=true 时 requiresUserApproval === false（但仍仅生成提议，不修改 Skill）', () => {
    const autoManager = new SkillLifecycleManager(
      makeEnabledConfig({ autoApplyRefinement: true }),
    );
    const skillId = 'skill-deploy';
    autoManager.recordExecution(
      skillId,
      makeExecution({ outcome: 'failure', failurePoint: '网络超时' }),
    );

    const proposal = autoManager.proposeRefinement(skillId);

    expect(proposal).not.toBeNull();
    expect(proposal!.requiresUserApproval).toBe(false);
  });

  it('无失败模式时 proposeRefinement 返回 null', () => {
    const skillId = 'skill-deploy';
    // 仅记录成功
    manager.recordExecution(skillId, makeExecution({ outcome: 'success' }));

    const proposal = manager.proposeRefinement(skillId);
    expect(proposal).toBeNull();
  });

  // ---- Management 阶段 ----

  it('6. 记忆超过保留时长后自动清理', () => {
    const retentionDays = 7;
    const retentionManager = new SkillLifecycleManager(
      makeEnabledConfig({ memoryRetentionDays: retentionDays }),
    );

    const skillId = 'skill-old';
    // 记录一条 30 天前的执行（已超过 7 天保留期）
    retentionManager.recordExecution(
      skillId,
      makeExecution({
        outcome: 'success',
        timestamp: Date.now() - 30 * DAY_MS,
      }),
    );

    // 验证记忆存在
    expect(retentionManager.getMemory(skillId)).toBeDefined();

    // 清理过期记忆
    const cleaned = retentionManager.cleanupExpiredMemory(retentionDays);
    expect(cleaned).toBe(1);
    expect(retentionManager.getMemory(skillId)).toBeUndefined();
  });

  it('cleanupExpiredMemory 保留近期记忆（不误删）', () => {
    const retentionDays = 30;
    const skillId = 'skill-recent';
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'success', timestamp: Date.now() - DAY_MS }),
    );

    const cleaned = manager.cleanupExpiredMemory(retentionDays);
    expect(cleaned).toBe(0);
    expect(manager.getMemory(skillId)).toBeDefined();
  });

  it('cleanupExpiredMemory 传 0 时不清理（陷阱 #171：必须严格执行）', () => {
    const skillId = 'skill-test';
    manager.recordExecution(
      skillId,
      makeExecution({ outcome: 'success', timestamp: Date.now() - 365 * DAY_MS }),
    );

    // memoryRetentionDays=0 是非法值，应直接返回 0 不做清理
    const cleaned = manager.cleanupExpiredMemory(0);
    expect(cleaned).toBe(0);
    expect(manager.getMemory(skillId)).toBeDefined();
  });

  // ---- 陷阱 #171：条数上限 ----

  it('8. failurePatterns 超过 20 条时按频率淘汰低频项', () => {
    const skillId = 'skill-many-failures';
    // 注入 25 种不同的 failurePoint，每种各 1 次（frequency=1）
    // 然后再让其中 5 种各加一次（frequency=2）
    // 最终应保留 20 条，且 frequency=2 的 5 条不被淘汰

    // 前 20 种各加一次（frequency=1）
    for (let i = 0; i < 20; i++) {
      manager.recordExecution(
        skillId,
        makeExecution({
          outcome: 'failure',
          failurePoint: `failure-${i}`,
        }),
      );
    }

    // 验证当前 20 条
    let patterns = manager.extractFailurePatterns(skillId);
    expect(patterns).toHaveLength(20);

    // 再加 5 种新的 failurePoint（第 21~25 种），frequency=1
    for (let i = 20; i < 25; i++) {
      manager.recordExecution(
        skillId,
        makeExecution({
          outcome: 'failure',
          failurePoint: `failure-${i}`,
        }),
      );
    }

    patterns = manager.extractFailurePatterns(skillId);
    // 陷阱 #171：必须 ≤ 20 条
    expect(patterns).toHaveLength(20);

    // 验证最新加入的 failure-20~24 中至少有一条被淘汰（不能全部保留）
    // 即 25 条不同模式中最多保留 20 条
    const allPatterns = new Set(patterns.map((p) => p.pattern));
    expect(allPatterns.size).toBe(20);
    // 总输入 25 种不同的 pattern，集合大小 20 表示有 5 条被淘汰
  });

  it('successPaths 超过 20 条时淘汰最旧（陷阱 #171）', () => {
    const skillId = 'skill-many-success';
    // 注入 25 种不同的成功路径
    for (let i = 0; i < 25; i++) {
      manager.recordExecution(
        skillId,
        makeExecution({
          outcome: 'success',
          stepsTaken: [`path-${i}-step1`, `path-${i}-step2`],
        }),
      );
    }

    const memory = manager.getMemory(skillId);
    expect(memory).toBeDefined();
    // 陷阱 #171：必须 ≤ 20 条
    expect(memory!.successPaths.length).toBeLessThanOrEqual(20);
    // 验证最新加入的 path-24 仍存在（保留最新淘汰最旧）
    const lastPathKey = `path-24-step1|path-24-step2`;
    const hasLast = memory!.successPaths.some((p) => p.join('|') === lastPathKey);
    expect(hasLast).toBe(true);
  });

  // ---- 综合行为 ----

  it('getMemory 返回深拷贝，外部修改不影响内部状态', () => {
    const skillId = 'skill-isolation';
    manager.recordExecution(
      skillId,
      makeExecution({
        outcome: 'success',
        stepsTaken: ['orig-step1', 'orig-step2'],
      }),
    );

    const memory = manager.getMemory(skillId)!;
    // 外部修改
    memory.executions[0].stepsTaken.push('external-mod');
    memory.failurePatterns.push({
      pattern: 'fake',
      frequency: 999,
      lastSeenAt: 0,
      exampleExecutionIds: [],
    });

    // 内部状态不应受影响
    const fresh = manager.getMemory(skillId)!;
    expect(fresh.executions[0].stepsTaken).toEqual(['orig-step1', 'orig-step2']);
    expect(fresh.failurePatterns).toHaveLength(0);
  });

  it('未关联 SkillId 的任务才参与创建触发判定', () => {
    // 3 条相似任务，但都已关联 SkillId
    const history: TaskRecord[] = [
      makeTask('运行单元测试 vitest', { skillId: 'skill-test' }),
      makeTask('运行单元测试 jest', { skillId: 'skill-test' }),
      makeTask('运行单元测试 mocha', { skillId: 'skill-test' }),
    ];

    const suggestion = manager.checkCreationTrigger(history);
    // 已关联 Skill 的任务不应触发新 Skill 创建
    expect(suggestion).toBeNull();
  });

  it('相似任务数低于阈值时不触发创建', () => {
    const history: TaskRecord[] = [
      makeTask('运行单元测试 vitest'),
      makeTask('运行单元测试 jest'),
    ];

    // 阈值为 3，只有 2 条任务
    const suggestion = manager.checkCreationTrigger(history);
    expect(suggestion).toBeNull();
  });
});
