// tests/integration/phase48-task4.test.ts
// Phase 48 Task 4 集成测试：AgentProfileManager 接入 spawn-agent
//
// 测试策略：
//   1. AgentProfileManager 存在且有 loadAll/saveProfile 等方法（接口契约）
//   2. 自定义 profile 的工具白名单覆盖硬编码 SUBAGENT_TOOL_WHITELIST
//   3. 不传 profileManager 时行为不变（向后兼容）
//   4. resolveProfileForSubagent 返回 profile，spawn-agent 可使用 profile.systemPrompt
//   5. SubagentType → AgentRole 映射正确（researcher/coder→executor/reviewer）

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  createChildRegistry,
  resolveProfileForSubagent,
  SUBAGENT_TOOL_WHITELIST,
} from '../../src/tools/builtin/spawn-agent.js';
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
import type { AgentProfile, AgentRole } from '../../src/agents/profiles/types.js';
import type {
  ITool,
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
} from '../../src/tools/types.js';

// ============================================================
// Mock 工具：可配置 name，便于测试白名单过滤
// ============================================================

class MockTool implements ITool {
  readonly definition: ToolDefinition;
  constructor(name: string) {
    this.definition = {
      name,
      description: `mock tool ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
      requiresApproval: false,
      category: 'system',
    };
  }
  validateArgs(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }
  async execute(
    _args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    return { success: true, output: '', durationMs: 0 };
  }
}

/** 创建带若干 mock 工具的 ToolRegistry */
function makeRegistry(toolNames: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of toolNames) {
    reg.register(new MockTool(name));
  }
  return reg;
}

/** 创建 mock AgentProfileManager，按 role 返回指定 profile */
function makeMockProfileManager(
  profileByRole: Partial<Record<AgentRole, AgentProfile>>,
): AgentProfileManager {
  return {
    resolveProfileForTask(role: AgentRole) {
      const p = profileByRole[role];
      if (!p) throw new Error(`No mock profile for role: ${role}`);
      return {
        ...p,
        allowedTools: [...p.allowedTools],
        forbiddenTools: [...p.forbiddenTools],
      };
    },
  } as unknown as AgentProfileManager;
}

/** 构造一个完整的自定义 AgentProfile（允许部分字段覆盖） */
function makeCustomProfile(
  overrides: Partial<AgentProfile> & { id: string; role: AgentRole },
): AgentProfile {
  return {
    id: overrides.id,
    name: overrides.name ?? `Custom ${overrides.id}`,
    type: 'agent-profile',
    version: overrides.version ?? '1.0.0',
    role: overrides.role,
    modelId: overrides.modelId ?? 'default',
    description: overrides.description ?? 'custom profile for test',
    systemPrompt: overrides.systemPrompt ?? 'custom system prompt',
    allowedTools: overrides.allowedTools ?? [],
    forbiddenTools: overrides.forbiddenTools ?? [],
    canChallenge: overrides.canChallenge ?? false,
    challengeSeverity: overrides.challengeSeverity ?? 'warning',
    outputFormat: overrides.outputFormat ?? 'custom',
    boundSkills: overrides.boundSkills ?? [],
    maxTokens: overrides.maxTokens ?? 32000,
    maxSteps: overrides.maxSteps ?? 20,
    isBuiltin: overrides.isBuiltin ?? false,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  };
}

// ============================================================
// 1. AgentProfileManager 存在且有 loadAll/save 方法
// ============================================================
describe('Phase 48 Task 4 - AgentProfileManager 接口契约', () => {
  it('AgentProfileManager 类可被实例化', () => {
    const mgr = new AgentProfileManager(process.cwd());
    expect(mgr).toBeInstanceOf(AgentProfileManager);
  });

  it('AgentProfileManager.prototype 上存在 loadAll 和 saveProfile 方法', () => {
    expect(typeof AgentProfileManager.prototype.loadAll).toBe('function');
    expect(typeof AgentProfileManager.prototype.saveProfile).toBe('function');
  });

  it('AgentProfileManager.prototype 上存在 listProfiles / getProfile / resolveProfileForTask 方法', () => {
    expect(typeof AgentProfileManager.prototype.listProfiles).toBe('function');
    expect(typeof AgentProfileManager.prototype.getProfile).toBe('function');
    expect(typeof AgentProfileManager.prototype.resolveProfileForTask).toBe('function');
  });
});

// ============================================================
// 2. 自定义 profile 的工具白名单覆盖硬编码 SUBAGENT_TOOL_WHITELIST
// ============================================================
describe('Phase 48 Task 4 - 自定义 profile 工具白名单覆盖硬编码白名单', () => {
  it('reviewer 类型：profile.allowedTools 覆盖 SUBAGENT_TOOL_WHITELIST.reviewer', () => {
    // 父 registry 包含若干工具
    const parent = makeRegistry([
      'file_read', 'code_search', 'list_directory',
      'file_write', 'shell_exec', 'web_fetch', 'git_op',
      'spawn_agent',
    ]);

    // 硬编码 reviewer 白名单：['file_read', 'code_search', 'list_directory']
    // 自定义 reviewer profile：只允许 file_read 和 web_fetch（与硬编码白名单不同）
    const customProfile = makeCustomProfile({
      id: 'custom-reviewer',
      role: 'reviewer',
      allowedTools: ['file_read', 'web_fetch'],
    });
    const profileManager = makeMockProfileManager({ reviewer: customProfile });

    const child = createChildRegistry(parent, 'reviewer', profileManager);

    // 子 registry 应该保留 file_read 和 web_fetch（来自 profile.allowedTools）
    expect(child.has('file_read')).toBe(true);
    expect(child.has('web_fetch')).toBe(true);
    // 子 registry 不应该包含 code_search 和 list_directory
    // （虽然在硬编码白名单中，但 profile 白名单覆盖了它们）
    expect(child.has('code_search')).toBe(false);
    expect(child.has('list_directory')).toBe(false);
    // 子 registry 不应该包含非白名单工具
    expect(child.has('file_write')).toBe(false);
    expect(child.has('shell_exec')).toBe(false);
    expect(child.has('git_op')).toBe(false);
    // spawn_agent 始终被移除（防递归）
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('coder 类型：profile.allowedTools 覆盖 SUBAGENT_TOOL_WHITELIST.coder（coder → executor role）', () => {
    const parent = makeRegistry([
      'file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op',
      'code_search', 'web_fetch', 'spawn_agent',
    ]);

    // 硬编码 coder 白名单：['file_read', 'file_write', 'file_edit', 'shell_exec', 'git_op']
    // 自定义 coder profile（role=executor）：只允许 file_read 和 file_write
    const customProfile = makeCustomProfile({
      id: 'custom-executor',
      role: 'executor',
      allowedTools: ['file_read', 'file_write'],
    });
    const profileManager = makeMockProfileManager({ executor: customProfile });

    const child = createChildRegistry(parent, 'coder', profileManager);

    expect(child.has('file_read')).toBe(true);
    expect(child.has('file_write')).toBe(true);
    // 其他硬编码白名单工具应该被过滤掉（因为 profile 白名单覆盖）
    expect(child.has('file_edit')).toBe(false);
    expect(child.has('shell_exec')).toBe(false);
    expect(child.has('git_op')).toBe(false);
    // 非白名单工具也被过滤
    expect(child.has('code_search')).toBe(false);
    expect(child.has('web_fetch')).toBe(false);
    // spawn_agent 始终被移除
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('profile.allowedTools 为空时回退到硬编码白名单', () => {
    const parent = makeRegistry([
      'file_read', 'code_search', 'list_directory', 'file_write',
    ]);

    // 自定义 profile 但 allowedTools 为空数组 → 应回退到硬编码白名单
    const customProfile = makeCustomProfile({
      id: 'empty-reviewer',
      role: 'reviewer',
      allowedTools: [], // 空数组
    });
    const profileManager = makeMockProfileManager({ reviewer: customProfile });

    const child = createChildRegistry(parent, 'reviewer', profileManager);

    // 硬编码 reviewer 白名单应生效：['file_read', 'code_search', 'list_directory']
    expect(child.has('file_read')).toBe(true);
    expect(child.has('code_search')).toBe(true);
    expect(child.has('list_directory')).toBe(true);
    expect(child.has('file_write')).toBe(false);
  });
});

// ============================================================
// 3. 不传 profileManager 时行为不变（向后兼容）
// ============================================================
describe('Phase 48 Task 4 - 向后兼容：不传 profileManager', () => {
  it('reviewer 类型：未传 profileManager 时使用硬编码白名单', () => {
    const parent = makeRegistry([
      'file_read', 'code_search', 'list_directory',
      'file_write', 'shell_exec', 'web_fetch', 'git_op',
      'spawn_agent',
    ]);

    // 不传 profileManager（仅两个参数）
    const child = createChildRegistry(parent, 'reviewer');

    // 硬编码 reviewer 白名单：['file_read', 'code_search', 'list_directory']
    expect(child.has('file_read')).toBe(true);
    expect(child.has('code_search')).toBe(true);
    expect(child.has('list_directory')).toBe(true);
    // 非白名单工具被移除
    expect(child.has('file_write')).toBe(false);
    expect(child.has('shell_exec')).toBe(false);
    expect(child.has('web_fetch')).toBe(false);
    expect(child.has('git_op')).toBe(false);
    // spawn_agent 始终被移除
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('general 类型：未传 profileManager 时保留全部工具（除 spawn_agent）', () => {
    const parent = makeRegistry([
      'file_read', 'code_search', 'file_write', 'spawn_agent',
    ]);

    const child = createChildRegistry(parent, 'general');

    expect(child.has('file_read')).toBe(true);
    expect(child.has('code_search')).toBe(true);
    expect(child.has('file_write')).toBe(true);
    expect(child.has('spawn_agent')).toBe(false);
  });

  it('advisor 类型：未传 profileManager 时移除所有工具', () => {
    const parent = makeRegistry([
      'file_read', 'code_search', 'file_write', 'spawn_agent',
    ]);

    const child = createChildRegistry(parent, 'advisor');

    expect(child.size).toBe(0);
  });

  it('传入 undefined profileManager 时与不传行为一致', () => {
    const parent = makeRegistry([
      'file_read', 'code_search', 'list_directory', 'file_write', 'spawn_agent',
    ]);

    const child1 = createChildRegistry(parent, 'reviewer');
    const child2 = createChildRegistry(parent, 'reviewer', undefined);

    // 两者保留的工具集应该相同
    const names1 = child1.list().map((t) => t.definition.name).sort();
    const names2 = child2.list().map((t) => t.definition.name).sort();
    expect(names1).toEqual(names2);
  });

  it('SUBAGENT_TOOL_WHITELIST 仍可被外部访问（未删除硬编码白名单）', () => {
    // 硬编码白名单应仍存在且可访问，保证向后兼容
    expect(SUBAGENT_TOOL_WHITELIST.reviewer).toBeInstanceOf(Set);
    expect(SUBAGENT_TOOL_WHITELIST.reviewer.has('file_read')).toBe(true);
    expect(SUBAGENT_TOOL_WHITELIST.coder).toBeInstanceOf(Set);
    expect(SUBAGENT_TOOL_WHITELIST.coder.has('file_write')).toBe(true);
  });
});

// ============================================================
// 4. spawn-agent 使用 profile 的系统提示词（通过 resolveProfileForSubagent 验证）
// ============================================================
describe('Phase 48 Task 4 - profile 系统提示词与解析', () => {
  it('resolveProfileForSubagent 返回的 profile 包含 systemPrompt（spawn-agent 可读取）', () => {
    const customProfile = makeCustomProfile({
      id: 'custom-reviewer',
      role: 'reviewer',
      systemPrompt: '你是被自定义 profile 控制的 reviewer 子 Agent',
    });
    const profileManager = makeMockProfileManager({ reviewer: customProfile });

    const profile = resolveProfileForSubagent(profileManager, 'reviewer');

    expect(profile).not.toBeNull();
    expect(profile!.systemPrompt).toBe('你是被自定义 profile 控制的 reviewer 子 Agent');
    // systemPrompt 非空时，app-init.ts 中的 createSpawnAgentFn 会用它作为子 Agent 系统提示词
  });

  it('resolveProfileForSubagent 对 general/advisor 返回 null（不使用 profile）', () => {
    const profileManager = makeMockProfileManager({});

    expect(resolveProfileForSubagent(profileManager, 'general')).toBeNull();
    expect(resolveProfileForSubagent(profileManager, 'advisor')).toBeNull();
  });

  it('resolveProfileForSubagent 未传 profileManager 时返回 null', () => {
    expect(resolveProfileForSubagent(undefined, 'reviewer')).toBeNull();
    expect(resolveProfileForSubagent(undefined, 'coder')).toBeNull();
  });

  it('coder 类型映射到 executor role，能正确取到 executor profile', () => {
    const executorProfile = makeCustomProfile({
      id: 'custom-executor',
      role: 'executor',
      systemPrompt: 'custom executor prompt for coder',
      allowedTools: ['file_read'],
    });
    const profileManager = makeMockProfileManager({ executor: executorProfile });

    const profile = resolveProfileForSubagent(profileManager, 'coder');

    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('executor');
    expect(profile!.systemPrompt).toBe('custom executor prompt for coder');
  });

  it('researcher 类型映射到 researcher role，返回 profile 的 maxSteps（spawn 用于 maxIterations）', () => {
    const researcherProfile = makeCustomProfile({
      id: 'custom-researcher',
      role: 'researcher',
      systemPrompt: 'custom researcher prompt',
      maxSteps: 42, // 自定义 maxSteps
    });
    const profileManager = makeMockProfileManager({ researcher: researcherProfile });

    const profile = resolveProfileForSubagent(profileManager, 'researcher');

    expect(profile).not.toBeNull();
    expect(profile!.role).toBe('researcher');
    expect(profile!.maxSteps).toBe(42);
    // app-init.ts 中 createSpawnAgentFn 会用 profile.maxSteps 作为 maxIterations 回退
  });
});
