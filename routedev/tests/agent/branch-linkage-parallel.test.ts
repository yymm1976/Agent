// tests/agent/branch-linkage-parallel.test.ts
// Task 4 & 5 测试：BranchLinkageManager + ParallelExperimentManager
//
// BranchLinkageManager（9 个）：linkGoal / linkExperiment / getLinkage / updateStatus /
//   abandonGoal / getOrphanedExperiments / recordExperimentResult / getExperimentSummaries / save+load
// ParallelExperimentManager（7 个）：detectConflicts 无冲突 / write_write blocking /
//   read_write warning / formatComparison / recommendWinner / getAdoptionPlan / getAdoptionPlan+cherryPickFiles

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BranchLinkageManager } from '../../src/agent/branch-linkage.js';
import {
  ParallelExperimentManager,
  type ExperimentIntent,
  type ExperimentComparison,
  type ParallelExperimentResult,
} from '../../src/agent/parallel-experiment.js';

// ============================================================
// BranchLinkageManager 测试
// ============================================================

describe('BranchLinkageManager', () => {
  let tmpDir: string;
  let manager: BranchLinkageManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-linkage-'));
    manager = new BranchLinkageManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('linkGoal 绑定 goal 到消息分支', () => {
    const linkage = manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    expect(linkage.messageBranchId).toBe('branch-1');
    expect(linkage.messageBranchName).toBe('探索方案A');
    expect(linkage.goalId).toBe('goal-001');
    expect(linkage.experimentIds).toEqual([]);
    expect(linkage.status).toBe('planned');
  });

  it('linkExperiment 绑定 experiment 到消息分支', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    const linkage = manager.linkExperiment('branch-1', 'exp-001');
    expect(linkage.experimentIds).toContain('exp-001');
    // 重复绑定不应重复添加
    manager.linkExperiment('branch-1', 'exp-001');
    expect(manager.getLinkage('branch-1')!.experimentIds).toHaveLength(1);
  });

  it('getLinkage 返回正确联动信息', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.linkExperiment('branch-1', 'exp-001');
    const linkage = manager.getLinkage('branch-1');
    expect(linkage).toBeDefined();
    expect(linkage!.goalId).toBe('goal-001');
    expect(linkage!.experimentIds).toEqual(['exp-001']);
    // 不存在的分支返回 undefined
    expect(manager.getLinkage('nonexistent')).toBeUndefined();
  });

  it('updateStatus 更新状态', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.updateStatus('branch-1', 'running');
    expect(manager.getLinkage('branch-1')!.status).toBe('running');
    manager.updateStatus('branch-1', 'completed');
    expect(manager.getLinkage('branch-1')!.status).toBe('completed');
  });

  it('abandonGoal 标记旧 goal 为 abandoned', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.abandonGoal('branch-1', '需求变更');
    expect(manager.getLinkage('branch-1')!.status).toBe('abandoned');
    // 重新绑定 goal 后状态应重置为 planned
    manager.linkGoal('branch-1', '探索方案A-v2', 'goal-002');
    expect(manager.getLinkage('branch-1')!.status).toBe('planned');
    expect(manager.getLinkage('branch-1')!.goalId).toBe('goal-002');
  });

  it('getOrphanedExperiments 返回需确认的 experiment', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.linkExperiment('branch-1', 'exp-001');
    manager.linkExperiment('branch-1', 'exp-002');
    const orphaned = manager.getOrphanedExperiments('branch-1');
    expect(orphaned).toHaveLength(2);
    expect(orphaned).toContain('exp-001');
    expect(orphaned).toContain('exp-002');
    // 无关联 experiment 的分支返回空
    expect(manager.getOrphanedExperiments('branch-noexp')).toEqual([]);
  });

  it('recordExperimentResult 记录结果摘要', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.linkExperiment('branch-1', 'exp-001');
    manager.updateStatus('branch-1', 'running');
    manager.recordExperimentResult('branch-1', 'exp-001', {
      summary: '实现了功能A，测试通过',
      modifiedFiles: ['src/a.ts', 'src/b.ts'],
      testsPassed: true,
    });
    const summaries = manager.getExperimentSummaries('branch-1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].experimentId).toBe('exp-001');
    expect(summaries[0].summary).toBe('实现了功能A，测试通过');
    expect(summaries[0].modifiedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    // 所有 experiment 都有结果后，状态应自动更新为 completed
    expect(manager.getLinkage('branch-1')!.status).toBe('completed');
  });

  it('getExperimentSummaries 返回 experiment 摘要列表', () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.linkExperiment('branch-1', 'exp-001');
    manager.linkExperiment('branch-1', 'exp-002');
    manager.recordExperimentResult('branch-1', 'exp-001', {
      summary: '方案一',
      modifiedFiles: ['a.ts'],
    });
    manager.recordExperimentResult('branch-1', 'exp-002', {
      summary: '方案二',
      modifiedFiles: ['b.ts'],
      testsPassed: false,
    });
    const summaries = manager.getExperimentSummaries('branch-1');
    expect(summaries).toHaveLength(2);
    const ids = summaries.map(s => s.experimentId).sort();
    expect(ids).toEqual(['exp-001', 'exp-002']);
  });

  it('save + load 往返一致', async () => {
    manager.linkGoal('branch-1', '探索方案A', 'goal-001');
    manager.linkExperiment('branch-1', 'exp-001');
    manager.recordExperimentResult('branch-1', 'exp-001', {
      summary: '测试摘要',
      modifiedFiles: ['x.ts'],
      testsPassed: true,
    });
    manager.updateStatus('branch-1', 'completed');
    await manager.save();

    // 新建 manager 从同一目录加载
    const loaded = new BranchLinkageManager(tmpDir);
    await loaded.load();

    const linkage = loaded.getLinkage('branch-1');
    expect(linkage).toBeDefined();
    expect(linkage!.goalId).toBe('goal-001');
    expect(linkage!.experimentIds).toEqual(['exp-001']);
    expect(linkage!.status).toBe('completed');
    expect(linkage!.messageBranchName).toBe('探索方案A');

    const summaries = loaded.getExperimentSummaries('branch-1');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('测试摘要');
    expect(summaries[0].modifiedFiles).toEqual(['x.ts']);
  });
});

// ============================================================
// ParallelExperimentManager 测试
// ============================================================

describe('ParallelExperimentManager', () => {
  describe('detectConflicts', () => {
    it('无冲突时 canParallelize=true', () => {
      const intents: ExperimentIntent[] = [
        {
          branchId: 'b1',
          branchName: '方案A',
          estimatedWriteFiles: ['src/a.ts'],
          estimatedReadFiles: ['src/config.ts'],
          goalDescription: '实现A',
        },
        {
          branchId: 'b2',
          branchName: '方案B',
          estimatedWriteFiles: ['src/b.ts'],
          estimatedReadFiles: ['src/config.ts'],
          goalDescription: '实现B',
        },
      ];
      const result = ParallelExperimentManager.detectConflicts(intents);
      expect(result.hasConflict).toBe(false);
      expect(result.conflicts).toHaveLength(0);
      expect(result.canParallelize).toBe(true);
    });

    it('write_write 冲突 blocking', () => {
      const intents: ExperimentIntent[] = [
        {
          branchId: 'b1',
          branchName: '方案A',
          estimatedWriteFiles: ['src/shared.ts', 'src/a.ts'],
          estimatedReadFiles: [],
          goalDescription: '实现A',
        },
        {
          branchId: 'b2',
          branchName: '方案B',
          estimatedWriteFiles: ['src/shared.ts', 'src/b.ts'],
          estimatedReadFiles: [],
          goalDescription: '实现B',
        },
      ];
      const result = ParallelExperimentManager.detectConflicts(intents);
      expect(result.hasConflict).toBe(true);
      const blocking = result.conflicts.filter(c => c.severity === 'blocking');
      expect(blocking).toHaveLength(1);
      expect(blocking[0].type).toBe('write_write');
      expect(blocking[0].files).toContain('src/shared.ts');
      expect(result.canParallelize).toBe(false);
    });

    it('read_write 冲突 warning', () => {
      const intents: ExperimentIntent[] = [
        {
          branchId: 'b1',
          branchName: '方案A',
          estimatedWriteFiles: ['src/a.ts'],
          estimatedReadFiles: ['src/data.ts'],
          goalDescription: '实现A',
        },
        {
          branchId: 'b2',
          branchName: '方案B',
          estimatedWriteFiles: ['src/data.ts'],
          estimatedReadFiles: [],
          goalDescription: '实现B',
        },
      ];
      const result = ParallelExperimentManager.detectConflicts(intents);
      expect(result.hasConflict).toBe(true);
      const warnings = result.conflicts.filter(c => c.severity === 'warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe('read_write');
      expect(warnings[0].files).toContain('src/data.ts');
      // warning 不阻止并行
      expect(result.canParallelize).toBe(true);
    });
  });

  describe('formatComparison', () => {
    it('生成对比报告', () => {
      const results: ParallelExperimentResult[] = [
        {
          branchId: 'b1',
          experimentId: 'exp-001',
          status: 'completed',
          summary: '方案A完成',
          modifiedFiles: ['src/a.ts'],
          testsPassed: true,
          tokenUsage: 1000,
          durationMs: 5000,
        },
        {
          branchId: 'b2',
          experimentId: 'exp-002',
          status: 'completed',
          summary: '方案B完成',
          modifiedFiles: ['src/b.ts', 'src/c.ts'],
          testsPassed: false,
          tokenUsage: 2000,
          durationMs: 8000,
        },
      ];
      const comparison: ExperimentComparison = {
        results,
        winner: 'b1',
        comparison: [
          {
            branchId: 'b1',
            branchName: '方案A',
            modifiedFiles: ['src/a.ts'],
            testsPassed: true,
            tokenUsage: 1000,
            durationMs: 5000,
          },
          {
            branchId: 'b2',
            branchName: '方案B',
            modifiedFiles: ['src/b.ts', 'src/c.ts'],
            testsPassed: false,
            tokenUsage: 2000,
            durationMs: 8000,
          },
        ],
      };
      const report = ParallelExperimentManager.formatComparison(comparison);
      expect(report).toContain('并行实验对比报告');
      expect(report).toContain('推荐分支');
      expect(report).toContain('方案A');
      expect(report).toContain('方案B');
      expect(report).toContain('src/a.ts');
    });
  });

  describe('recommendWinner', () => {
    it('推荐 testsPassed=true 且 token 最低的分支', () => {
      const comparison: ExperimentComparison = {
        results: [],
        comparison: [
          {
            branchId: 'b1',
            branchName: '方案A',
            modifiedFiles: ['a.ts'],
            testsPassed: true,
            tokenUsage: 1500,
            durationMs: 5000,
          },
          {
            branchId: 'b2',
            branchName: '方案B',
            testsPassed: true,
            modifiedFiles: ['b.ts'],
            tokenUsage: 800,
            durationMs: 3000,
          },
          {
            branchId: 'b3',
            branchName: '方案C',
            testsPassed: false,
            modifiedFiles: ['c.ts'],
            tokenUsage: 500,
            durationMs: 1000,
          },
        ],
      };
      const winner = ParallelExperimentManager.recommendWinner(comparison);
      // b3 虽然 token 最低但 testsPassed=false，应排除
      // b1 和 b2 都通过测试，b2 token 更低
      expect(winner).toBe('b2');
    });

    it('所有分支测试未通过时返回 undefined', () => {
      const comparison: ExperimentComparison = {
        results: [],
        comparison: [
          {
            branchId: 'b1',
            branchName: '方案A',
            modifiedFiles: [],
            testsPassed: false,
            tokenUsage: 100,
            durationMs: 0,
          },
        ],
      };
      expect(ParallelExperimentManager.recommendWinner(comparison)).toBeUndefined();
    });
  });

  describe('getAdoptionPlan', () => {
    it('生成采纳计划', () => {
      const comparison: ExperimentComparison = {
        results: [
          {
            branchId: 'b1',
            experimentId: 'exp-001',
            status: 'completed',
            modifiedFiles: ['src/a.ts', 'src/b.ts'],
            testsPassed: true,
          },
          {
            branchId: 'b2',
            experimentId: 'exp-002',
            status: 'completed',
            modifiedFiles: ['src/c.ts'],
            testsPassed: false,
          },
        ],
        winner: 'b1',
        comparison: [
          {
            branchId: 'b1',
            branchName: '方案A',
            modifiedFiles: ['src/a.ts', 'src/b.ts'],
            testsPassed: true,
            tokenUsage: 1000,
            durationMs: 5000,
          },
          {
            branchId: 'b2',
            branchName: '方案B',
            modifiedFiles: ['src/c.ts'],
            testsPassed: false,
            tokenUsage: 2000,
            durationMs: 8000,
          },
        ],
      };
      const plan = ParallelExperimentManager.getAdoptionPlan(comparison, 'b1');
      expect(plan.adoptBranchId).toBe('b1');
      expect(plan.adoptFiles).toEqual(['src/a.ts', 'src/b.ts']);
      expect(plan.cherryPickFrom).toEqual([]);
    });

    it('带 cherryPickFiles 的混合采纳', () => {
      const comparison: ExperimentComparison = {
        results: [
          {
            branchId: 'b1',
            experimentId: 'exp-001',
            status: 'completed',
            modifiedFiles: ['src/a.ts', 'src/b.ts'],
            testsPassed: true,
          },
          {
            branchId: 'b2',
            experimentId: 'exp-002',
            status: 'completed',
            modifiedFiles: ['src/c.ts', 'src/d.ts'],
            testsPassed: false,
          },
        ],
        winner: 'b1',
        comparison: [
          {
            branchId: 'b1',
            branchName: '方案A',
            modifiedFiles: ['src/a.ts', 'src/b.ts'],
            testsPassed: true,
            tokenUsage: 1000,
            durationMs: 5000,
          },
          {
            branchId: 'b2',
            branchName: '方案B',
            modifiedFiles: ['src/c.ts', 'src/d.ts'],
            testsPassed: false,
            tokenUsage: 2000,
            durationMs: 8000,
          },
        ],
      };
      // 从 b2 cherry-pick src/c.ts
      const plan = ParallelExperimentManager.getAdoptionPlan(comparison, 'b1', {
        cherryPickFiles: ['src/c.ts'],
      });
      expect(plan.adoptBranchId).toBe('b1');
      expect(plan.adoptFiles).toEqual(['src/a.ts', 'src/b.ts']);
      expect(plan.cherryPickFrom).toHaveLength(1);
      expect(plan.cherryPickFrom[0].branchId).toBe('b2');
      expect(plan.cherryPickFrom[0].files).toEqual(['src/c.ts']);
    });
  });
});
