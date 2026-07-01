// tests/agent/goal-hook.test.ts
// Phase 40 Task 8 & 9：/goal 生命周期进化 + Hook 增强 测试
// 覆盖：GoalPromptBuilder(7) + GoalPersistence(5) + GoalAuditor(5) + HookEnhancementManager(2) = 19
//
// 本任务：已移除 HookEnhancementManager 的试用模式/Hook Group/函数型 Hook 注册测试
//        （这些 API 作为死代码删除，仅保留 analyzeCommand/detectBase64Command 等安全审查测试）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  GoalPromptBuilder,
  type FivePartGoalSpec,
} from '../../src/agent/goal-prompt-builder.js';
import {
  GoalPersistence,
  type PersistedGoal,
} from '../../src/agent/goal-persistence.js';
import {
  GoalAuditor,
  DEFAULT_AUDIT_CONFIG,
} from '../../src/agent/goal-audit.js';
import { HookEnhancementManager } from '../../src/hooks/hook-enhancement.js';

// ============================================================
// 辅助工厂
// ============================================================

function makeSpec(overrides?: Partial<FivePartGoalSpec>): FivePartGoalSpec {
  return {
    goal: '实现用户登录功能',
    scope: '修改 src/auth/ 目录',
    constraints: ['基于 TypeScript', '不破坏现有测试'],
    doneWhen: ['类型检查通过', '登录测试通过'],
    stopIf: ['Token 预算用尽'],
    tokenBudget: 50000,
    ...overrides,
  };
}

function makePersistedGoal(overrides?: Partial<PersistedGoal>): PersistedGoal {
  const now = Date.now();
  return {
    id: 'goal-test-1',
    spec: makeSpec(),
    plan: {
      steps: [
        { id: 's1', description: '步骤1', status: 'completed', dependencies: [] },
        { id: 's2', description: '步骤2', status: 'in_progress', dependencies: ['s1'] },
        { id: 's3', description: '步骤3', status: 'pending', dependencies: ['s2'] },
      ],
    },
    status: 'executing',
    checkpointIds: ['cp-1'],
    createdAt: now,
    updatedAt: now,
    tokenUsed: 10000,
    tokenBudget: 50000,
    ...overrides,
  };
}

// ============================================================
// GoalPromptBuilder（7 个）
// ============================================================

describe('GoalPromptBuilder', () => {
  const builder = new GoalPromptBuilder();

  it('1. isAmbiguous 短输入返回 true', () => {
    expect(GoalPromptBuilder.isAmbiguous('修bug')).toBe(true);
    expect(GoalPromptBuilder.isAmbiguous('')).toBe(true);
    expect(GoalPromptBuilder.isAmbiguous('   ')).toBe(true);
  });

  it('2. isAmbiguous 含模糊词返回 true', () => {
    expect(GoalPromptBuilder.isAmbiguous('实现一些功能，大概差不多了')).toBe(true);
    expect(GoalPromptBuilder.isAmbiguous('优化一些相关的东西之类的')).toBe(true);
  });

  it('3. isAmbiguous 简单命令返回 false', () => {
    expect(GoalPromptBuilder.isAmbiguous('查看 git 状态')).toBe(false);
    expect(GoalPromptBuilder.isAmbiguous('列出文件')).toBe(false);
    // 含明确动词且足够长
    expect(GoalPromptBuilder.isAmbiguous('实现用户登录功能并编写测试')).toBe(false);
  });

  it('4. generateClarificationQuestions 覆盖四个维度', () => {
    const questions = GoalPromptBuilder.generateClarificationQuestions('实现登录');
    const dimensions = questions.map((q) => q.dimension);
    expect(dimensions).toContain('实现细节');
    expect(dimensions).toContain('必要决策');
    expect(dimensions).toContain('完成标准');
    expect(dimensions).toContain('范围边界');
    expect(questions.length).toBe(4);
    // 每个问题都有非空文本
    for (const q of questions) {
      expect(q.question.length).toBeGreaterThan(0);
    }
  });

  it('5. enrichGoal 合并用户回答', () => {
    const original = '实现登录功能';
    const answers = {
      实现细节: '用 JWT',
      完成标准: '测试通过',
    };
    const enriched = GoalPromptBuilder.enrichGoal(original, answers);
    expect(enriched).toContain('实现登录功能');
    expect(enriched).toContain('JWT');
    expect(enriched).toContain('测试通过');
    expect(enriched).toContain('补充');
  });

  it('6. serialize + parse 往返一致', () => {
    const spec = makeSpec();
    const markdown = GoalPromptBuilder.serialize(spec);
    const parsed = GoalPromptBuilder.parse(markdown);
    expect(parsed.goal).toBe(spec.goal);
    expect(parsed.scope).toBe(spec.scope);
    expect(parsed.constraints).toEqual(spec.constraints);
    expect(parsed.doneWhen).toEqual(spec.doneWhen);
    expect(parsed.stopIf).toEqual(spec.stopIf);
    expect(parsed.tokenBudget).toBe(spec.tokenBudget);
  });

  it('7. build 生成五段式规范', async () => {
    const spec = await builder.build('实现用户登录功能，基于 TypeScript', {
      完成标准: '登录测试通过',
      范围边界: '只改 src/auth/',
    });
    expect(spec.goal).toContain('实现用户登录功能');
    expect(spec.scope).toContain('src/auth/');
    expect(spec.constraints.length).toBeGreaterThan(0);
    expect(spec.doneWhen.length).toBeGreaterThan(0);
    expect(spec.stopIf.length).toBeGreaterThan(0);
    expect(spec.tokenBudget).toBeGreaterThan(0);
    // 完成标准应包含澄清回答
    expect(spec.doneWhen.some((d) => d.includes('登录测试通过'))).toBe(true);
  });
});

// ============================================================
// GoalPersistence（5 个）
// ============================================================

describe('GoalPersistence', () => {
  let tempDir: string;
  let persistence: GoalPersistence;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-goal-'));
    persistence = new GoalPersistence(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('8. save + load 往返一致', async () => {
    const goal = makePersistedGoal();
    await persistence.save(goal);

    const loaded = await persistence.load(goal.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(goal.id);
    expect(loaded!.status).toBe(goal.status);
    expect(loaded!.spec.goal).toBe(goal.spec.goal);
    expect(loaded!.plan.steps.length).toBe(goal.plan.steps.length);
    expect(loaded!.tokenBudget).toBe(goal.tokenBudget);
  });

  it('9. listResumable 返回 executing/paused 状态', async () => {
    const executing = makePersistedGoal({ id: 'goal-exec' });
    const paused = makePersistedGoal({ id: 'goal-paused', status: 'paused' });
    const completed = makePersistedGoal({ id: 'goal-done', status: 'completed' });
    const failed = makePersistedGoal({ id: 'goal-fail', status: 'failed' });

    await persistence.save(executing);
    await persistence.save(paused);
    await persistence.save(completed);
    await persistence.save(failed);

    const resumable = await persistence.listResumable();
    const ids = resumable.map((g) => g.id);
    expect(ids).toContain('goal-exec');
    expect(ids).toContain('goal-paused');
    expect(ids).not.toContain('goal-done');
    expect(ids).not.toContain('goal-fail');
    expect(resumable.length).toBe(2);
  });

  it('10. archive 移动到 archived 目录', async () => {
    const goal = makePersistedGoal({ id: 'goal-arch' });
    await persistence.save(goal);

    // 确认在 goals 目录
    const before = await persistence.load(goal.id);
    expect(before).not.toBeNull();

    await persistence.archive(goal.id);

    // 原位置不再存在
    const after = await persistence.load(goal.id);
    expect(after).toBeNull();

    // archived 目录存在该文件
    const archivedPath = path.join(tempDir, '.routedev', 'goals', 'archived', `${goal.id}.json`);
    const archivedContent = await fs.readFile(archivedPath, 'utf-8');
    const archived = JSON.parse(archivedContent) as PersistedGoal;
    expect(archived.id).toBe(goal.id);
  });

  it('11. shouldSoftStop tokenUsed >= 90% 预算时返回 true', () => {
    const budget = 10000;
    const at89 = makePersistedGoal({ tokenUsed: 8900, tokenBudget: budget });
    const at90 = makePersistedGoal({ tokenUsed: 9000, tokenBudget: budget });
    const at100 = makePersistedGoal({ tokenUsed: 10000, tokenBudget: budget });
    const over = makePersistedGoal({ tokenUsed: 12000, tokenBudget: budget });

    expect(GoalPersistence.shouldSoftStop(at89)).toBe(false);
    expect(GoalPersistence.shouldSoftStop(at90)).toBe(true);
    expect(GoalPersistence.shouldSoftStop(at100)).toBe(true);
    expect(GoalPersistence.shouldSoftStop(over)).toBe(true);
  });

  it('12. generateProgressReport 包含步骤状态', () => {
    const goal = makePersistedGoal();
    const report = GoalPersistence.generateProgressReport(goal);
    expect(report).toContain('Progress Report');
    expect(report).toContain(goal.id);
    expect(report).toContain('completed');
    expect(report).toContain('in_progress');
    expect(report).toContain('pending');
    // 包含每个步骤的描述
    for (const step of goal.plan.steps) {
      expect(report).toContain(step.description);
    }
    // 包含 token 使用情况
    expect(report).toContain('Token');
    expect(report).toContain(String(goal.tokenUsed));
  });
});

// ============================================================
// GoalAuditor（5 个）
// ============================================================

describe('GoalAuditor', () => {
  it('13. CompletionGate 通过 + Verifier 通过 → overallPassed=true', async () => {
    const auditor = new GoalAuditor();
    const outcome = await auditor.audit({
      spec: { doneWhen: ['类型检查通过'] },
      typecheckPassed: true,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: true, evidence: ['doneWhen 全部满足'] },
    });
    expect(outcome.overallPassed).toBe(true);
    expect(outcome.results.length).toBeGreaterThanOrEqual(2);
  });

  it('14. CompletionGate 失败 → overallPassed=false', async () => {
    const auditor = new GoalAuditor();
    const outcome = await auditor.audit({
      spec: { doneWhen: ['类型检查通过'] },
      typecheckPassed: false,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: true, evidence: ['verifier 认为 ok'] },
    });
    expect(outcome.overallPassed).toBe(false);
    const gate = outcome.results.find((r) => r.layer === 'completion_gate');
    expect(gate?.passed).toBe(false);
  });

  it('15. reviewer error 级别质疑推翻 CompletionGate 通过', async () => {
    const auditor = new GoalAuditor({
      reviewerAgent: { enabled: true, profileId: 'senior' },
    });
    const outcome = await auditor.audit({
      spec: { doneWhen: ['测试通过'] },
      typecheckPassed: true,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: true, evidence: ['ok'] },
      reviewerResult: {
        passed: false,
        evidence: ['测试覆盖不足，遗漏边界情况'],
        severity: 'error',
      },
    });
    // CompletionGate 通过，但 reviewer error 推翻
    expect(outcome.overallPassed).toBe(false);
    const reviewer = outcome.results.find((r) => r.layer === 'reviewer_agent');
    expect(reviewer?.severity).toBe('error');
  });

  it('16. arbitration=all_must_pass 时任一层失败则整体失败', async () => {
    const auditor = new GoalAuditor({
      arbitration: 'all_must_pass',
      reviewerAgent: { enabled: true },
    });
    // CompletionGate 通过，verifier 失败
    const outcome = await auditor.audit({
      spec: { doneWhen: ['测试通过'] },
      typecheckPassed: true,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: false, evidence: ['doneWhen 未满足'], missing: ['测试通过'] },
      reviewerResult: { passed: true, evidence: ['ok'], severity: 'info' },
    });
    expect(outcome.overallPassed).toBe(false);
  });

  it('17. getResults 返回所有层结果', async () => {
    const auditor = new GoalAuditor({
      reviewerAgent: { enabled: true },
    });
    await auditor.audit({
      spec: { doneWhen: ['ok'] },
      typecheckPassed: true,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: true, evidence: ['ok'] },
      reviewerResult: { passed: true, evidence: ['ok'], severity: 'info' },
    });
    const results = auditor.getResults();
    expect(results.length).toBe(3);
    const layers = results.map((r) => r.layer);
    expect(layers).toContain('completion_gate');
    expect(layers).toContain('verifier_llm');
    expect(layers).toContain('reviewer_agent');
  });
});

// ============================================================
// HookEnhancementManager（2 个：仅静态安全审查方法）
// ============================================================

describe('HookEnhancementManager', () => {
  it('24. analyzeCommand 检测危险命令', () => {
    const dangerous = HookEnhancementManager.analyzeCommand('rm -rf /');
    expect(dangerous.safe).toBe(false);
    expect(dangerous.risks.length).toBeGreaterThan(0);

    const force = HookEnhancementManager.analyzeCommand('git push --force origin main');
    expect(force.safe).toBe(false);

    const safe = HookEnhancementManager.analyzeCommand('pnpm test');
    expect(safe.safe).toBe(true);
    expect(safe.risks.length).toBe(0);
  });

  it('25. detectBase64Command 检测 base64 编码', () => {
    expect(HookEnhancementManager.detectBase64Command('echo dGVzdA== | base64 -d | sh')).toBe(true);
    expect(HookEnhancementManager.detectBase64Command('base64 -d input.txt')).toBe(true);
    expect(HookEnhancementManager.detectBase64Command('eval(atob("dGVzdA=="))')).toBe(true);
    expect(HookEnhancementManager.detectBase64Command('pnpm test')).toBe(false);
    expect(HookEnhancementManager.detectBase64Command('echo hello')).toBe(false);
  });
});
