// tests/agents/context-contract.test.ts
// Task 2 + Task 3 单元测试：ContextPacker / DelegationContract / DelegationEnforcer

import { describe, it, expect } from 'vitest';
import { ContextPacker, ROLE_WEIGHTS } from '../../src/agents/context-packer.js';
import type { ContextSources } from '../../src/agents/context-packer.js';
import { DelegationContractManager } from '../../src/agents/delegation-contract.js';
import type { DelegationContract, ChallengeRequest, ParentResponse } from '../../src/agents/delegation-contract.js';
import { DelegationEnforcer } from '../../src/agents/delegation-enforcer.js';

// ============================================================
// 辅助工厂
// ============================================================

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    taskBoundary: {
      designDoc: '设计文档：实现登录模块',
      readFiles: ['src/auth/login.ts'],
      writeFiles: ['src/auth/login.ts'],
      goal: '完成登录功能',
      constraints: ['使用 JWT', '不引入新依赖'],
    },
    ...overrides,
  };
}

function makeContract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return {
    taskId: 'task-1',
    parentAgentId: 'parent',
    childAgentId: 'child',
    profileId: 'executor',
    grant: {
      readFiles: ['src/auth/login.ts'],
      writeFiles: ['src/auth/login.ts'],
      allowedTools: ['file_read', 'file_write', 'file_edit'],
      maxTokens: 1000,
      maxSteps: 10,
      canChallenge: true,
    },
    obligation: {
      mustFollowDesign: true,
      mustReportProgress: true,
      mustNotAlterGoal: true,
      challengeChannel: 'parent_only',
    },
    deliverable: {
      format: 'code',
      successCriteria: ['登录接口可用'],
      failureCriteria: ['测试不通过'],
    },
    ...overrides,
  };
}

// ============================================================
// ContextPacker
// ============================================================

describe('ContextPacker', () => {
  const packer = new ContextPacker();

  it('1. researcher 角色权重 codeMap 最高', () => {
    const w = ROLE_WEIGHTS.researcher;
    const max = Math.max(w.codeMap, w.taskBoundary, w.memory, w.facts, w.parentReasoning);
    expect(w.codeMap).toBe(max);
    expect(w.codeMap).toBe(0.9);
  });

  it('2. executor 角色权重 taskBoundary 最高', () => {
    const w = ROLE_WEIGHTS.executor;
    const max = Math.max(w.codeMap, w.taskBoundary, w.memory, w.facts, w.parentReasoning);
    expect(w.taskBoundary).toBe(max);
    expect(w.taskBoundary).toBe(1.0);
  });

  it('3. 上下文包 token 数不超过预算', async () => {
    const pkg = await packer.pack({
      role: 'executor',
      taskId: 't-1',
      sources: makeSources(),
      budgetTokens: 500,
    });
    expect(pkg.metadata.estimatedTokens).toBeLessThanOrEqual(500);
    const sum = pkg.sections.reduce((acc, s) => acc + s.estimatedTokens, 0);
    expect(sum).toBe(pkg.metadata.estimatedTokens);
  });

  it('4. 代码地图符号按 rankScore 排序', async () => {
    const sources = makeSources({
      codeMap: {
        relevantSymbols: [
          { id: 'a', name: 'lowFn', type: 'function', filePath: 'a.ts', rankScore: 0.3 },
          { id: 'b', name: 'highFn', type: 'function', filePath: 'b.ts', rankScore: 0.9 },
          { id: 'c', name: 'midFn', type: 'function', filePath: 'c.ts', rankScore: 0.6 },
        ],
      },
    });
    const pkg = await packer.pack({
      role: 'researcher',
      taskId: 't-2',
      sources,
      budgetTokens: 2000,
    });
    const codeMapSection = pkg.sections.find(s => s.title === '代码地图');
    expect(codeMapSection).toBeDefined();
    const content = codeMapSection!.content;
    const highIdx = content.indexOf('highFn');
    const midIdx = content.indexOf('midFn');
    const lowIdx = content.indexOf('lowFn');
    expect(highIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(highIdx);
    expect(lowIdx).toBeGreaterThan(midIdx);
  });

  it('5. 超预算时 truncated=true', async () => {
    const sources = makeSources({
      taskBoundary: {
        designDoc: '这是一个相当长的设计文档，用于触发截断逻辑，确保内容超过极小的 token 预算',
        readFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        writeFiles: ['src/a.ts'],
        goal: '完成某个功能模块',
        constraints: ['约束一', '约束二', '约束三'],
      },
    });
    const pkg = await packer.pack({
      role: 'executor',
      taskId: 't-3',
      sources,
      budgetTokens: 10,
    });
    expect(pkg.metadata.truncated).toBe(true);
    expect(pkg.metadata.estimatedTokens).toBeLessThanOrEqual(10);
  });

  it('6. 空源数据返回空包', async () => {
    const emptySources: ContextSources = {
      taskBoundary: {
        designDoc: '',
        readFiles: [],
        writeFiles: [],
        goal: '',
        constraints: [],
      },
    };
    const pkg = await packer.pack({
      role: 'executor',
      taskId: 't-4',
      sources: emptySources,
      budgetTokens: 500,
    });
    expect(pkg.sections.length).toBe(0);
    expect(pkg.metadata.estimatedTokens).toBe(0);
    expect(pkg.metadata.truncated).toBe(false);
  });

  it('7. 同一任务多次打包结果一致（snapshot 一致）', async () => {
    const sources = makeSources();
    const pkg1 = await packer.pack({ role: 'reviewer', taskId: 't-5', sources, budgetTokens: 1000 });
    const pkg2 = await packer.pack({ role: 'reviewer', taskId: 't-5', sources, budgetTokens: 1000 });
    expect(pkg1.metadata.sourceSnapshot).toBe(pkg2.metadata.sourceSnapshot);
    expect(pkg1.sections).toEqual(pkg2.sections);
  });

  it('8. parentReasoning 在 reviewer 角色中权重最高（跨角色比较）', () => {
    const reviewerPR = ROLE_WEIGHTS.reviewer.parentReasoning;
    const allPR = (Object.keys(ROLE_WEIGHTS) as Array<keyof typeof ROLE_WEIGHTS>).map(
      r => ROLE_WEIGHTS[r].parentReasoning,
    );
    const maxPR = Math.max(...allPR);
    expect(reviewerPR).toBe(maxPR);
    expect(reviewerPR).toBe(0.6);
  });
});

// ============================================================
// DelegationContract
// ============================================================

describe('DelegationContract', () => {
  it('9. createContract + getContract', () => {
    const mgr = new DelegationContractManager();
    const contract = makeContract({ taskId: 'task-9' });
    mgr.createContract(contract);
    expect(mgr.getContract('task-9')).toEqual(contract);
    expect(mgr.getContract('not-exist')).toBeUndefined();
  });

  it('10. formatContractForPrompt 包含角色和文件列表', () => {
    const contract = makeContract({ profileId: 'executor' });
    const prompt = DelegationContractManager.formatContractForPrompt(contract);
    expect(prompt).toContain('你的角色：executor');
    expect(prompt).toContain('src/auth/login.ts');
    expect(prompt).toContain('【委托契约】');
    expect(prompt).toContain('【服从义务】');
    expect(prompt).toContain('【质疑权利】');
  });

  it('11. validateContract 拒绝空 readFiles', () => {
    const contract = makeContract({});
    contract.grant.readFiles = [];
    const errors = DelegationContractManager.validateContract(contract);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('readFiles'))).toBe(true);
  });

  it('12. submitChallenge + getPendingChallenges', () => {
    const mgr = new DelegationContractManager();
    const contract = makeContract({ taskId: 'task-12' });
    mgr.createContract(contract);
    const challenge: ChallengeRequest = {
      taskId: 'task-12',
      role: 'executor',
      type: 'missing_info',
      severity: 'blocking',
      description: '缺少数据库连接信息',
      evidence: ['设计文档未提及 DB_URL'],
    };
    const result = mgr.submitChallenge('task-12', challenge);
    expect(result.accepted).toBe(true);
    const pending = mgr.getPendingChallenges('task-12');
    expect(pending.length).toBe(1);
    expect(pending[0].description).toBe('缺少数据库连接信息');
  });

  it('13. respondToChallenge 后 getChallengeResponse 返回回应', () => {
    const mgr = new DelegationContractManager();
    mgr.createContract(makeContract({ taskId: 'task-13' }));
    mgr.submitChallenge('task-13', {
      taskId: 'task-13',
      role: 'executor',
      type: 'design_conflict',
      severity: 'blocking',
      description: '设计文档与现有架构冲突',
      evidence: ['e1'],
    });
    const response: ParentResponse = { action: 'clarify', newInstructions: '请改用方案 B' };
    mgr.respondToChallenge('task-13', response);
    expect(mgr.getChallengeResponse('task-13')).toEqual(response);
    // 回应后 pending 清空
    expect(mgr.getPendingChallenges('task-13').length).toBe(0);
  });

  it('14. challenge 超过 3 次被拒绝（反死循环）', () => {
    const mgr = new DelegationContractManager();
    mgr.createContract(makeContract({ taskId: 'task-14' }));
    const mk = (): ChallengeRequest => ({
      taskId: 'task-14',
      role: 'executor',
      type: 'missing_info',
      severity: 'warning',
      description: '再次质疑',
      evidence: [],
    });
    expect(mgr.submitChallenge('task-14', mk()).accepted).toBe(true);
    expect(mgr.submitChallenge('task-14', mk()).accepted).toBe(true);
    expect(mgr.submitChallenge('task-14', mk()).accepted).toBe(true);
    const fourth = mgr.submitChallenge('task-14', mk());
    expect(fourth.accepted).toBe(false);
    expect(fourth.reason).toContain('上限');
    expect(mgr.getChallengeCount('task-14')).toBe(3);
  });
});

// ============================================================
// DelegationEnforcer
// ============================================================

describe('DelegationEnforcer', () => {
  it('15. 拦截未授权工具', () => {
    const contract = makeContract({});
    contract.grant.allowedTools = ['file_read', 'file_write'];
    const enforcer = new DelegationEnforcer(contract);
    const result = enforcer.beforeToolCall('shell_exec', { command: 'rm -rf /' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('shell_exec');
  });

  it('16. 拦截未授权文件写入', () => {
    const contract = makeContract({});
    contract.grant.allowedTools = ['file_read', 'file_write'];
    contract.grant.writeFiles = ['src/auth/login.ts'];
    const enforcer = new DelegationEnforcer(contract);
    const result = enforcer.beforeToolCall('file_write', { path: 'src/secret/leak.ts', content: 'x' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('src/secret/leak.ts');
  });

  it('17. maxSteps 到达后拒绝', () => {
    const contract = makeContract({});
    contract.grant.maxSteps = 2;
    const enforcer = new DelegationEnforcer(contract);
    expect(enforcer.incrementStep().allowed).toBe(true); // step=1
    expect(enforcer.incrementStep().allowed).toBe(true); // step=2
    const over = enforcer.incrementStep(); // step=3
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain('最大步数');
    expect(enforcer.getStepCount()).toBe(3);
  });

  it('18. maxTokens 到达后拒绝', () => {
    const contract = makeContract({});
    contract.grant.maxTokens = 100;
    const enforcer = new DelegationEnforcer(contract);
    expect(enforcer.addTokens(50).allowed).toBe(true); // 50
    const over = enforcer.addTokens(60); // 110 > 100
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain('Token 预算');
    expect(enforcer.getTokenUsed()).toBe(110);
  });

  it('19. 90% 预算时返回警告', () => {
    const contract = makeContract({});
    contract.grant.maxTokens = 100;
    const enforcer = new DelegationEnforcer(contract);
    const result = enforcer.addTokens(95); // 95 > 90 (90%) 但 <= 100
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('⚠️');
  });
});
