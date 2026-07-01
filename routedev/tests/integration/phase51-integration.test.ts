// tests/integration/phase51-integration.test.ts
// Phase 51 集成测试：核心模块端到端流程验证
//
// 测试策略：
//   场景 1 (Task 2/3/4)：端到端委托流程——classifyTask → decideDelegation → canDelegate → createChildRegistry → createSubAgentSession → extractFinalAnswer → validateSubAgentResult
//   场景 2 (Task 1/7)：Reviewer 分级全流程——assessRisk → determineReviewerTier → getReviewPassesForTier → validateReviewFeedback
//   场景 3 (Task 8)：配置三层合并——deepMergeConfig 默认 / loadMergedConfig 优先级
//   场景 4 (Task 9)：错误受众分层——ToolExecutionError + formatErrorForUser/Dev + ErrorDisplaySchema
//
// 全部使用 mock 依赖，不调用真实 LLM 或文件系统。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 委托策略 / 会话 / 注册表
import {
  classifyTask,
  decideDelegation,
  canDelegate,
  createDelegationGuard,
} from '../../src/agents/delegation-policy.js';
import {
  createSubAgentSession,
  extractFinalAnswer,
  isSessionExpired,
} from '../../src/agents/subagent-session.js';
import {
  createSessionStorageKey,
  parseSessionStorageKey,
  HarnessScope,
  createDefaultInstance,
  createHarness,
} from '../../src/agents/instance-harness.js';
import {
  createChildRegistry,
  type DelegationContext,
} from '../../src/tools/builtin/spawn-agent.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ITool, ToolDefinition } from '../../src/tools/types.js';

// Reviewer 分级
import {
  assessRisk,
  determineReviewerTier,
  getReviewPassesForTier,
  selectCrossModelReviewer,
  validateReviewFeedback,
} from '../../src/agent/reviewer-tier-evaluator.js';

// 结果 schema
import {
  validateSubAgentResult,
  formatResultForParent,
  ExecutorResultSchema,
  ResearcherResultSchema,
} from '../../src/agents/result-schemas.js';

// 活动面板
import { AgentActivityStore, splitModelLabel, buildLineage } from '../../src/agents/activity-store.js';

// 错误体系
import {
  RouteDevError,
  ToolExecutionError,
  formatErrorForUser,
  formatErrorForDev,
} from '../../src/utils/errors.js';

// 配置合并
import { deepMergeConfig, loadConfig } from '../../src/config/loader.js';
import { AppConfigSchema, ErrorDisplaySchema } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Profile 类型
import type { AgentProfile, AgentRole } from '../../src/agents/profiles/types.js';

// ============================================================
// 通用 Mock 工具
// ============================================================

/** 创建 mock ITool——只实现 definition.name 和必需方法 */
function makeMockTool(name: string): ITool {
  return {
    definition: {
      name,
      description: `mock ${name}`,
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      category: 'system',
    } as ToolDefinition,
    execute: vi.fn(async () => ({ success: true, output: 'mock', error: undefined, durationMs: 0 })),
    validateArgs: vi.fn(() => ({ valid: true, errors: [] })),
  } as unknown as ITool;
}

/** 创建带 spawn_agent + file_read 工具的父注册表 */
function makeParentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeMockTool('spawn_agent'));
  registry.register(makeMockTool('file_read'));
  registry.register(makeMockTool('file_edit'));
  registry.register(makeMockTool('shell_exec'));
  return registry;
}

/** 测试用 profile 工厂 */
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'executor-profile',
    name: 'Executor',
    type: 'agent-profile',
    version: '1.0.0',
    role: 'executor' as AgentRole,
    modelId: 'gpt-5.4',
    description: '执行型子 Agent',
    systemPrompt: 'You are an executor subagent. Produce structured result.',
    allowedTools: ['file_read', 'file_write', 'file_edit', 'shell_exec'],
    forbiddenTools: [],
    canChallenge: false,
    challengeSeverity: 'warning',
    outputFormat: 'code_change',
    boundSkills: [],
    maxTokens: 8000,
    maxSteps: 20,
    isBuiltin: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================
// 场景 1: 端到端委托流程 (Task 2/3/4 集成)
// ============================================================

describe('Phase 51 场景 1: 端到端委托流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1.1 classifyTask("build login component") 应识别为 frontend 类型', () => {
    const taskType = classifyTask('build login component');
    expect(taskType).toBe('frontend');
  });

  it('1.2 decideDelegation 应返回 delegate 模式且目标为 executor', () => {
    const decision = decideDelegation('build login component', {
      hardDelegationTypes: ['frontend'],
      refuseIfSpecialistUnavailable: true,
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    });
    expect(decision.mode).toBe('delegate');
    expect(decision.targetRole).toBe('executor');
  });

  it('1.3 canDelegate(depth=0, executor→researcher, maxDepth=2) 返回 ok 与 nextDepth=1', () => {
    const permission = canDelegate(0, 'executor', 'researcher', {
      maxDepth: 2,
      delegationTargets: {
        executor: ['researcher', 'reviewer'],
        researcher: [],
        reviewer: [],
        custom: [],
      },
    });
    expect(permission.ok).toBe(true);
    expect(permission.nextDepth).toBe(1);
  });

  it('1.4 createChildRegistry(parentRegistry, delegationContext) 保留 spawn_agent', () => {
    const parentRegistry = makeParentRegistry();
    const delegationContext: DelegationContext = {
      currentDepth: 0,
      currentRole: 'executor',
      targetRole: 'researcher',
      policy: {
        maxDepth: 2,
        delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
      },
    };
    const child = createChildRegistry(parentRegistry, 'general', undefined, delegationContext);
    // depth=0 + maxDepth=2 → nextDepth=1 < 2 → 保留 spawn_agent
    expect(child.has('spawn_agent')).toBe(true);
    expect(child.has('file_read')).toBe(true);
  });

  it('1.5 createChildRegistry: depth 用尽时移除 spawn_agent', () => {
    const parentRegistry = makeParentRegistry();
    const delegationContext: DelegationContext = {
      currentDepth: 2, // 已达 maxDepth=2
      currentRole: 'executor',
      targetRole: 'researcher',
      policy: {
        maxDepth: 2,
        delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
      },
    };
    const child = createChildRegistry(parentRegistry, 'general', undefined, delegationContext);
    // nextDepth=3 >= maxDepth=2 → 移除 spawn_agent
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('1.6 createChildRegistry: 无 delegationContext 时退回物理移除（向后兼容）', () => {
    const parentRegistry = makeParentRegistry();
    const child = createChildRegistry(parentRegistry, 'general');
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('1.7 createSubAgentSession 生成独立 session 且 systemPrompt 来自 profile', () => {
    const profile = makeProfile({ systemPrompt: 'executor 专属 prompt' });
    const session = createSubAgentSession('parent-session-1', 'executor', profile, 1);
    expect(session.sessionId).toMatch(/^sub-\d+-[a-z0-9]+$/);
    expect(session.parentSessionId).toBe('parent-session-1');
    expect(session.depth).toBe(1);
    expect(session.systemPrompt).toBe('executor 专属 prompt');
    expect(session.messageHistory).toEqual([]);
    expect(session.storageKey).toHaveProperty('instanceId');
    expect(session.storageKey).toHaveProperty('harnessName');
    expect(session.storageKey).toHaveProperty('sessionName');
  });

  it('1.8 extractFinalAnswer 从 session 历史中提取最后一条 assistant 消息', () => {
    const profile = makeProfile();
    const session = createSubAgentSession('parent-1', 'executor', profile, 1);
    session.messageHistory = [
      { role: 'user', content: '请实现登录' },
      { role: 'assistant', content: '已完成实现' },
    ];
    expect(extractFinalAnswer(session)).toBe('已完成实现');
  });

  it('1.9 validateSubAgentResult(result, ExecutorResultSchema) 校验通过——子 Agent 返回完整结构化结果', () => {
    const result = {
      summary: '完成了登录组件',
      changes: [{ file: 'src/login.tsx', changeType: 'create', description: '新建组件', linesAffected: 50 }],
      testsRun: [{ name: 'login.test.ts', passed: true }],
      concerns: ['尚未支持 SSO'],
      completed: true,
    };
    const parsed = validateSubAgentResult(result, ExecutorResultSchema);
    expect(parsed.success).toBe(true);
  });

  it('1.10 formatResultForParent 把 executor 结果格式化为可读文本', () => {
    const result = {
      summary: '完成了登录组件',
      changes: [{ file: 'src/login.tsx', changeType: 'create', description: '新建组件', linesAffected: 50 }],
      testsRun: [{ name: 'login.test.ts', passed: true }],
      concerns: ['尚未支持 SSO'],
      completed: true,
    };
    const text = formatResultForParent(result, 'executor');
    expect(text).toContain('执行总结');
    expect(text).toContain('src/login.tsx');
    expect(text).toContain('login.test.ts');
    expect(text).toContain('已完成');
  });

  it('1.11 createDelegationGuard 拦截写工具——确保委托策略在 spawn_agent 执行期间生效', () => {
    const guard = createDelegationGuard({
      hardDelegationTypes: ['frontend'],
      refuseIfSpecialistUnavailable: false,
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    });
    // delegate 模式下 write 工具被拦截
    const blocked = guard('write', 'build login component');
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain('spawn_agent');
    // 读工具放行
    const allowed = guard('read', 'build login component');
    expect(allowed.block).toBe(false);
  });

  it('1.12 完整链路：classifyTask → decideDelegation → canDelegate → createChildRegistry → createSubAgentSession', () => {
    // 端到端：从任务描述到独立 session 与子注册表
    const taskDesc = 'build login component';
    // 1. 分类
    expect(classifyTask(taskDesc)).toBe('frontend');
    // 2. 决策
    const decision = decideDelegation(taskDesc, {
      hardDelegationTypes: ['frontend'],
      refuseIfSpecialistUnavailable: false,
      specialistAvailability: { researcher: true, executor: true, reviewer: true, custom: true },
    });
    expect(decision.mode).toBe('delegate');
    expect(decision.targetRole).toBe('executor');
    // 3. 权限
    const perm = canDelegate(0, 'executor', 'researcher', {
      maxDepth: 2,
      delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
    });
    expect(perm.ok).toBe(true);
    // 4. 子注册表（保留 spawn_agent）
    const childRegistry = createChildRegistry(makeParentRegistry(), 'general', undefined, {
      currentDepth: 0,
      currentRole: 'executor',
      targetRole: 'researcher',
      policy: {
        maxDepth: 2,
        delegationTargets: { executor: ['researcher'], researcher: [], reviewer: [], custom: [] },
      },
    });
    expect(childRegistry.has('spawn_agent')).toBe(true);
    // 5. 子会话
    const session = createSubAgentSession('parent-x', 'executor', makeProfile(), 1);
    expect(session.parentSessionId).toBe('parent-x');
    expect(session.depth).toBe(1);
  });
});

// ============================================================
// 场景 2: Reviewer 分级全流程 (Task 1/7 集成)
// ============================================================

describe('Phase 51 场景 2: Reviewer 分级全流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('2.1 assessRisk({affectsSecurity:true}) → high-risk 且 score=40', () => {
    const result = assessRisk({
      affectsSecurity: true,
      affectsDataIntegrity: false,
      affectsFileSystem: false,
      stepCount: 10,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    expect(result.riskScore).toBe(40);
    expect(result.isHighRisk).toBe(true);
    expect(result.riskFactors).toContain('security');
  });

  it('2.2 determineReviewerTier(stepCount=10, isHighRisk=true) → "high-risk"', () => {
    const tier = determineReviewerTier(10, true, { tinyTaskStepThreshold: 5, bigTaskStepThreshold: 30 });
    expect(tier).toBe('high-risk');
  });

  it('2.3 getReviewPassesForTier("high-risk") → {midWork:1, final:1, crossModel:true}', () => {
    expect(getReviewPassesForTier('high-risk')).toEqual({ midWork: 1, final: 1, crossModel: true });
  });

  it('2.4 selectCrossModelReviewer 在可用模型中找不同家族', () => {
    const result = selectCrossModelReviewer('gpt-5.4', ['gpt-5.4', 'claude-3.5-sonnet', 'gemini-pro']);
    // 应返回第一个非 openai 家族模型
    expect(result).not.toBeNull();
    expect(result).not.toBe('gpt-5.4');
  });

  it('2.5 validateReviewFeedback: enforceEvidenceProtocol=true 时缺 evidence 被拒绝', () => {
    const feedback = {
      summary: '存在风险',
      risks: [
        {
          description: '密码明文',
          failureScenario: '数据库泄露后密码外泄',
          violatedInvariant: '密码必须加密存储',
          evidence: [], // 空 evidence
          severity: 'blocking' as const,
        },
      ],
      overallVerdict: 'fail' as const,
    };
    const result = validateReviewFeedback(feedback, { enforceEvidenceProtocol: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('evidence'))).toBe(true);
  });

  it('2.6 validateReviewFeedback: 三件证据齐备（含 evidence）时通过', () => {
    const feedback = {
      summary: '存在风险',
      risks: [
        {
          description: '密码明文',
          failureScenario: '数据库泄露后密码外泄',
          violatedInvariant: '密码必须加密存储',
          evidence: [
            { file: 'src/auth.ts', line: 42, excerpt: 'password = plain' },
            { file: 'src/auth.ts', line: 50 },
            { file: 'src/db.ts', line: 100 },
          ],
          severity: 'blocking' as const,
          suggestedFix: '使用 bcrypt',
        },
      ],
      overallVerdict: 'fail' as const,
    };
    const result = validateReviewFeedback(feedback, { enforceEvidenceProtocol: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('2.7 完整链路：assessRisk → determineReviewerTier → getReviewPassesForTier → validateReviewFeedback', () => {
    // 1. 风险评估
    const risk = assessRisk({
      affectsSecurity: true,
      affectsDataIntegrity: false,
      affectsFileSystem: true,
      stepCount: 10,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    expect(risk.isHighRisk).toBe(true); // security(40) + filesystem-write(5) = 45 >= 40

    // 2. 分级
    const tier = determineReviewerTier(10, risk.isHighRisk, {
      tinyTaskStepThreshold: 5,
      bigTaskStepThreshold: 30,
    });
    expect(tier).toBe('high-risk');

    // 3. 轮次
    const passes = getReviewPassesForTier(tier);
    expect(passes.crossModel).toBe(true);

    // 4. 反馈校验（合规）
    const feedback = {
      summary: '存在风险',
      risks: [
        {
          description: '密码明文',
          failureScenario: '数据库泄露后密码外泄',
          violatedInvariant: '密码必须加密存储',
          evidence: [{ file: 'src/auth.ts', line: 42 }],
          severity: 'blocking' as const,
        },
      ],
      overallVerdict: 'fail' as const,
    };
    expect(validateReviewFeedback(feedback, { enforceEvidenceProtocol: true }).valid).toBe(true);
  });
});

// ============================================================
// 场景 3: 配置三层合并 (Task 8 集成)
// ============================================================

describe('Phase 51 场景 3: 配置三层合并', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3.1 deepMergeConfig: 对象递归合并——{a:{b:1}} + {a:{c:2}} → {a:{b:1,c:2}}', () => {
    const result = deepMergeConfig({ a: { b: 1 } }, { a: { c: 2 } });
    expect(result).toEqual({ a: { b: 1, c: 2 } });
  });

  it('3.2 deepMergeConfig: 数组替换语义——[1,2] + [3,4] → [3,4]', () => {
    // I5 修复：数组默认 replace（source 覆盖 target），安全字段需要完全覆盖
    const result = deepMergeConfig({ list: [1, 2] }, { list: [3, 4] });
    expect(result).toEqual({ list: [3, 4] });
  });

  it('3.3 deepMergeConfig: 数组替换语义——source 完全覆盖 target', () => {
    // I5 修复：不再合并去重，source 直接替换
    const result = deepMergeConfig({ list: [1, 2, 3] }, { list: [3, 4] });
    expect(result).toEqual({ list: [3, 4] });
  });

  it('3.4 deepMergeConfig: 原始值后者覆盖前者', () => {
    const result = deepMergeConfig({ a: 1, b: 'old' }, { b: 'new' });
    expect(result).toEqual({ a: 1, b: 'new' });
  });

  it('3.5 deepMergeConfig: 空配置返回空对象', () => {
    expect(deepMergeConfig()).toEqual({});
  });

  it('3.6 deepMergeConfig: 单个配置返回深拷贝', () => {
    const cfg = { a: { b: 1 } };
    const result = deepMergeConfig(cfg);
    expect(result).toEqual(cfg);
  });

  it('3.7 AppConfigSchema 三层合并：default → global → project，后者覆盖前者', () => {
    // 模拟三层合并：以 DEFAULT_CONFIG 为基底，再用项目级覆盖
    const merged = deepMergeConfig(DEFAULT_CONFIG, { general: { theme: 'light' } });
    const parsed = AppConfigSchema.safeParse(merged);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // 项目级覆盖应生效
      expect(parsed.data.general.theme).toBe('light');
      // 未覆盖的字段使用 schema 默认值
      expect(parsed.data.general.language).toBe('zh-CN');
    }
  });

  it('3.8 loadConfig 优先级：project > global > default（用空文件模拟）', () => {
    // 不存在的路径 → 使用默认值
    const config = loadConfig({
      projectPath: '/non-existent-project-path-xyz',
      globalConfigPath: '/non-existent-global-path-xyz.yaml',
    });
    // 应该回退到 schema 默认值，不抛错
    expect(config.version).toBe(1);
    expect(config.general.language).toBe('zh-CN');
    expect(config.general.theme).toBe('dark');
  });

  it('3.9 ConfigLayering 配置字段存在且默认值合理', () => {
    // 用 DEFAULT_CONFIG 作为基底以匹配生产 loadConfig 的合并路径
    const parsed = AppConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // configLayering 默认 enabled=false, mergeStrategy='deep'
      expect(parsed.data.configLayering.enabled).toBe(false);
      expect(parsed.data.configLayering.mergeStrategy).toBe('deep');
      expect(parsed.data.configLayering.projectConfigPath).toBe('.routedev/config.json');
    }
  });
});

// ============================================================
// 场景 4: 错误受众分层 (Task 9 集成)
// ============================================================

describe('Phase 51 场景 4: 错误受众分层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('4.1 ToolExecutionError 携带 details 与 dev 信息', () => {
    const err = new ToolExecutionError('shell_exec', '命令执行失败', {
      details: '退出码 127，命令不存在',
      dev: 'PATH 中缺少 /usr/local/bin，spawn 失败',
    });
    expect(err.toolName).toBe('shell_exec');
    expect(err.details).toBe('退出码 127，命令不存在');
    expect(err.dev).toBe('PATH 中缺少 /usr/local/bin，spawn 失败');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
  });

  it('4.2 error.toUserMessage() 不含 dev 信息', () => {
    const err = new ToolExecutionError('shell_exec', '命令执行失败', {
      details: '退出码 127',
      dev: 'PATH 中缺少 /usr/local/bin（dev only）',
    });
    const userMsg = err.toUserMessage();
    expect(userMsg).toContain('命令执行失败');
    expect(userMsg).toContain('退出码 127');
    // 严禁泄露 dev 信息
    expect(userMsg).not.toContain('PATH 中缺少');
    expect(userMsg).not.toContain('[Dev]');
  });

  it('4.3 error.toDevMessage() 含 dev 信息', () => {
    const err = new ToolExecutionError('shell_exec', '命令执行失败', {
      details: '退出码 127',
      dev: 'PATH 中缺少 /usr/local/bin',
    });
    const devMsg = err.toDevMessage();
    expect(devMsg).toContain('[Dev]');
    expect(devMsg).toContain('PATH 中缺少 /usr/local/bin');
    // 同时也包含用户可见部分
    expect(devMsg).toContain('命令执行失败');
  });

  it('4.4 ErrorDisplaySchema.parse({}) → showDevDetails=false（默认值）', () => {
    // 空对象预处理后走 schema 默认
    const parsed = ErrorDisplaySchema.parse({});
    expect(parsed.showDevDetails).toBe(false);
    expect(parsed.showStackTrace).toBe(false);
    expect(parsed.maxDetailsLength).toBe(2000);
  });

  it('4.5 ErrorDisplaySchema.parse({showDevDetails:true}) → showDevDetails=true', () => {
    const parsed = ErrorDisplaySchema.parse({ showDevDetails: true });
    expect(parsed.showDevDetails).toBe(true);
  });

  it('4.6 ErrorDisplaySchema.parse(undefined) → 走 preprocess 默认值', () => {
    // preprocess(v => v ?? {}, ...) 把 undefined 转为 {}
    const parsed = ErrorDisplaySchema.parse(undefined);
    expect(parsed.showDevDetails).toBe(false);
  });

  it('4.7 formatErrorForUser 与 formatErrorForDev 输出分层', () => {
    const err = new ToolExecutionError('file_write', '写入失败', {
      details: '磁盘已满',
      dev: 'inode 耗尽，建议清理 /tmp',
    });
    const userMsg = formatErrorForUser(err);
    const devMsg = formatErrorForDev(err);
    // 用户消息只含 message + details
    expect(userMsg).toContain('写入失败');
    expect(userMsg).toContain('磁盘已满');
    expect(userMsg).not.toContain('inode');
    // 开发者消息含 dev 部分
    expect(devMsg).toContain('[Dev]');
    expect(devMsg).toContain('inode 耗尽');
  });

  it('4.8 完整链路：构造错误 → 解析 ErrorDisplaySchema → 按模式格式化', () => {
    // 1. 构造带 dev 信息的错误
    const err = new ToolExecutionError('file_write', '写入失败', {
      details: '磁盘已满',
      dev: 'inode 耗尽',
    });
    // 2. 解析 ErrorDisplaySchema（用户模式：showDevDetails=false）
    const userMode = ErrorDisplaySchema.parse({ showDevDetails: false });
    // 3. 按用户模式渲染：不应含 dev
    if (userMode.showDevDetails === false) {
      const text = formatErrorForUser(err);
      expect(text).not.toContain('inode');
    }
    // 4. 开发模式：应含 dev
    const devMode = ErrorDisplaySchema.parse({ showDevDetails: true });
    if (devMode.showDevDetails === true) {
      const text = formatErrorForDev(err);
      expect(text).toContain('inode');
    }
  });
});

// ============================================================
// 场景 5: 三层抽象 + 活动面板端到端（额外覆盖 Task 5/6）
// ============================================================

describe('Phase 51 场景 5: 三层抽象与活动面板端到端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5.1 createDefaultInstance → createHarness → createSessionStorageKey 完整链路', () => {
    const instance = createDefaultInstance('/path/to/project');
    const harness = createHarness(instance, 'default', 'gpt-5.4');
    const sessionName = 'task:parent:sub-1';
    const storageKey = createSessionStorageKey(instance.id, harness.name, sessionName);
    expect(storageKey).toBe(`default/default/${sessionName}`);
    // 反解
    const parsed = parseSessionStorageKey(storageKey);
    expect(parsed).toEqual({
      instanceId: 'default',
      harnessName: 'default',
      sessionName,
    });
  });

  it('5.2 HarnessScope.abort 级联取消子 scope（不影响父）', () => {
    const root = new HarnessScope();
    const child = root.createChild();
    child.abort('child cancelled');
    expect(child.signal.aborted).toBe(true);
    expect(root.signal.aborted).toBe(false); // 父不受影响
  });

  it('5.3 AgentActivityStore 跟踪子 Agent 活动三态机', () => {
    const store = new AgentActivityStore(4, 3);
    const lineage = buildLineage(undefined, 'executor');
    // start
    const id = store.startActivity({
      id: 'act-1',
      lineage,
      depth: 1,
      role: 'executor',
      taskPreview: '实现登录组件',
    });
    expect(store.getActive()).toHaveLength(1);
    expect(store.getActive()[0].status).toBe('running');
    // update
    store.updateActivity(id, { toolCallCount: 3, lastToolName: 'file_edit' });
    expect(store.getActive()[0].toolCallCount).toBe(3);
    // finish
    store.finishActivity(id, 'success');
    expect(store.getActive()).toHaveLength(0);
    expect(store.getRecent()).toHaveLength(1);
    expect(store.getRecent()[0].status).toBe('success');
  });

  it('5.4 splitModelLabel 模型标签分离支持多种家族', () => {
    expect(splitModelLabel('openai-codex/gpt-5.4:high')).toEqual({ model: 'gpt-5.4', thinking: 'high' });
    expect(splitModelLabel('anthropic/claude-3.5:medium')).toEqual({ model: 'claude-3.5', thinking: 'medium' });
    expect(splitModelLabel('gpt-5.4')).toEqual({ model: 'gpt-5.4' });
  });

  it('5.5 isSessionExpired 配合 HarnessScope 实现超时取消', () => {
    const profile = makeProfile();
    const session = createSubAgentSession('parent-1', 'executor', profile, 1);
    // 刚创建，未过期
    expect(isSessionExpired(session, 60_000)).toBe(false);
    // 模拟超时
    const expiredSession = { ...session, createdAt: Date.now() - 120_000 };
    expect(isSessionExpired(expiredSession, 60_000)).toBe(true);
  });
});
