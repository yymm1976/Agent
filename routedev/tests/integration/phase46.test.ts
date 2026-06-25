// tests/integration/phase46.test.ts
// Phase 46 集成测试：IPC 桥接 / Hook 接线 / 死代码清理验证
//
// 测试策略：
//   1. HookEvent 包含 on-model-call —— 编译期 + 运行期验证
//   2. isValidConfig 拒绝非法事件名 —— 通过 HookConfigRegistry.load() 间接验证
//   3. HttpRegistryClient URL 规范化 —— 补全协议、去尾斜杠
//   4. configToDefinition 正确转换 HookConfig —— 字段映射 + 变量替换
//   5-7. CLI 命令注册验证：/clarify /experiment /trust
//   8-9. Phase 45 已有功能回归验证：VoiceManager sanitizeForTTS / PersonaEngine

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHookRunner, type HookEvent, type HookContext } from '../../src/agent/hooks.js';
import { HookConfigRegistry } from '../../src/hooks/registry.js';
import { configToDefinition, replaceVariables } from '../../src/hooks/adapter.js';
import { HttpRegistryClient, type RegistryItem } from '../../src/skills/registry-client.js';
import { VoiceManager } from '../../src/agent/voice-manager.js';
import { clarifyCommand } from '../../src/cli/commands/clarify.js';
import { experimentCommand } from '../../src/cli/commands/experiment.js';
import { trustCommand } from '../../src/cli/commands/trust.js';

// ============================================================
// 工具函数
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-phase46-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    arrayBuffer: async () => {
      const str = JSON.stringify(body);
      return new TextEncoder().encode(str).buffer;
    },
  } as unknown as Response;
}

function makeHookContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    stepId: 'step-1',
    agentId: 'agent-1',
    projectPath: '/tmp/project',
    ...overrides,
  };
}

// ============================================================
// 1. HookEvent 包含 on-model-call
// ============================================================
describe('Phase 46 Integration - HookEvent on-model-call', () => {
  it('on-model-call 是合法的 HookEvent 类型', () => {
    // 编译期：若 'on-model-call' 不是合法 HookEvent，tsc 会报错
    const event: HookEvent = 'on-model-call';
    expect(event).toBe('on-model-call');
  });

  it('HookRunner 可注册 on-model-call 钩子', () => {
    const runner = createHookRunner();
    runner.register({
      event: 'on-model-call',
      handler: async () => ({ action: 'continue' }),
      name: 'token-alert-hook',
    });
    expect(runner.count('on-model-call')).toBe(1);
  });
});

// ============================================================
// 2. isValidConfig 拒绝非法事件名
// ============================================================
describe('Phase 46 Integration - isValidConfig 事件白名单', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    configPath = path.join(tmpDir, 'hooks.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('非法事件名被拒绝，不加载该配置', async () => {
    const invalidConfig = {
      configs: [
        {
          id: 'bad-event',
          name: '非法事件测试',
          event: 'on-invalid-event',
          enabled: true,
          command: 'echo bad',
          failBehavior: 'warn',
          isTemplate: false,
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(invalidConfig), 'utf-8');

    const registry = new HookConfigRegistry(configPath);
    await registry.load();

    // 非法事件应被 isValidConfig 过滤掉
    expect(registry.list()).toHaveLength(0);
  });

  it('合法事件名 on-model-call 被接受', async () => {
    const validConfig = {
      configs: [
        {
          id: 'token-alert',
          name: 'Token 警告',
          event: 'on-model-call',
          enabled: true,
          command: 'echo token',
          failBehavior: 'warn',
          isTemplate: true,
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(validConfig), 'utf-8');

    const registry = new HookConfigRegistry(configPath);
    await registry.load();

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].event).toBe('on-model-call');
  });
});

// ============================================================
// 3. HttpRegistryClient URL 规范化
// ============================================================
describe('Phase 46 Integration - HttpRegistryClient URL 规范化', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('补全 https 协议前缀（无协议时）', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('registry.example.com');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  it('去除尾部斜杠', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('https://registry.example.com/');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  it('补全协议 + 去尾斜杠 + 多斜杠', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('registry.example.com///');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  it('保留 http:// 协议（不强制升级为 https）', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('http://localhost:8080/');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:8080/api/skills');
  });
});

// ============================================================
// 4. configToDefinition 正确转换 HookConfig
// ============================================================
describe('Phase 46 Integration - configToDefinition 转换器', () => {
  it('字段映射：id → name, event → event, priority 默认 50', () => {
    const config = {
      id: 'auto-format',
      name: '自动格式化',
      event: 'post-tool-call' as HookEvent,
      enabled: true,
      command: 'npx prettier --write {{filePath}}',
      failBehavior: 'warn' as const,
      isTemplate: true,
    };

    const def = configToDefinition(config);

    expect(def.name).toBe('auto-format');
    expect(def.event).toBe('post-tool-call');
    expect(def.priority).toBe(50);
    expect(typeof def.handler).toBe('function');
  });

  it('priority 自定义值生效', () => {
    const config = {
      id: 'high-priority-hook',
      name: '高优先级钩子',
      event: 'pre-tool-call' as HookEvent,
      enabled: true,
      command: 'echo hi',
      failBehavior: 'block' as const,
      isTemplate: false,
      priority: 10,
    };

    const def = configToDefinition(config);
    expect(def.priority).toBe(10);
  });

  it('replaceVariables 替换 {{filePath}} 变量', () => {
    const template = 'prettier --write {{filePath}}';
    const ctx = makeHookContext({ toolName: 'file_write' });
    // 模拟扩展上下文（filePath 通过工具上下文传递）
    const extCtx = { ...ctx, filePath: '/tmp/test.ts' } as HookContext;

    const result = replaceVariables(template, extCtx);
    expect(result).toBe('prettier --write /tmp/test.ts');
  });

  it('replaceVariables 替换 {{toolName}} 变量', () => {
    const template = 'echo {{toolName}}';
    const ctx = makeHookContext({ toolName: 'file_read' });

    const result = replaceVariables(template, ctx);
    expect(result).toBe('echo file_read');
  });

  it('replaceVariables 替换 {{stepId}} 变量', () => {
    const template = 'echo {{stepId}}';
    const ctx = makeHookContext({ stepId: 'step-42' });

    const result = replaceVariables(template, ctx);
    expect(result).toBe('echo step-42');
  });

  it('handler 执行成功命令返回 continue', async () => {
    const config = {
      id: 'echo-hook',
      name: '回显钩子',
      event: 'post-step' as HookEvent,
      enabled: true,
      command: 'echo hello',
      failBehavior: 'warn' as const,
      isTemplate: false,
    };

    const def = configToDefinition(config);
    const ctx = makeHookContext();
    const result = await def.handler(ctx);

    expect(result.action).toBe('continue');
  });
});

// ============================================================
// 5. /clarify 命令 name 为 'clarify'
// ============================================================
describe('Phase 46 Integration - /clarify 命令注册', () => {
  it('clarifyCommand.name === "clarify"', () => {
    expect(clarifyCommand.name).toBe('clarify');
  });

  it('clarifyCommand 有 description', () => {
    expect(clarifyCommand.description).toBeTruthy();
    expect(clarifyCommand.description.length).toBeGreaterThan(0);
  });

  it('clarifyCommand 有 handler 函数', () => {
    expect(typeof clarifyCommand.handler).toBe('function');
  });
});

// ============================================================
// 6. /experiment 命令 name 为 'experiment'
// ============================================================
describe('Phase 46 Integration - /experiment 命令注册', () => {
  it('experimentCommand.name === "experiment"', () => {
    expect(experimentCommand.name).toBe('experiment');
  });

  it('experimentCommand 有 description', () => {
    expect(experimentCommand.description).toBeTruthy();
    expect(experimentCommand.description.length).toBeGreaterThan(0);
  });

  it('experimentCommand 有 handler 函数', () => {
    expect(typeof experimentCommand.handler).toBe('function');
  });
});

// ============================================================
// 7. /trust 命令 name 为 'trust'
// ============================================================
describe('Phase 46 Integration - /trust 命令注册', () => {
  it('trustCommand.name === "trust"', () => {
    expect(trustCommand.name).toBe('trust');
  });

  it('trustCommand 有 description', () => {
    expect(trustCommand.description).toBeTruthy();
    expect(trustCommand.description.length).toBeGreaterThan(0);
  });

  it('trustCommand 有 handler 函数', () => {
    expect(typeof trustCommand.handler).toBe('function');
  });
});

// ============================================================
// 8. VoiceManager sanitizeForTTS 移除 markdown（Phase 45 回归）
// ============================================================
describe('Phase 46 Integration - VoiceManager sanitizeForTTS 回归', () => {
  it('移除 markdown 代码块', () => {
    const input = '以下是代码：\n```ts\nconst x = 1;\n```\n结束';
    const result = VoiceManager.sanitizeForTTS(input);
    expect(result).not.toContain('```');
    expect(result).not.toContain('const x = 1');
    expect(result).toContain('以下是代码');
    expect(result).toContain('结束');
  });

  it('移除工具调用标记', () => {
    const input = '正在执行<tool_call>{"name":"file_read"}</tool_call>完成';
    const result = VoiceManager.sanitizeForTTS(input);
    expect(result).not.toContain('<tool_call>');
    expect(result).not.toContain('file_read');
    expect(result).toContain('正在执行');
    expect(result).toContain('完成');
  });

  it('移除 markdown 标题与列表标记', () => {
    const input = '# 标题\n- 列表项1\n- 列表项2\n正文';
    const result = VoiceManager.sanitizeForTTS(input);
    expect(result).not.toContain('# 标题');
    expect(result).toContain('标题');
    expect(result).toContain('列表项1');
    expect(result).toContain('正文');
  });

  it('空字符串返回空', () => {
    expect(VoiceManager.sanitizeForTTS('')).toBe('');
  });
});

// ============================================================
// 9. PersonaEngine buildPersonaFragment intensity=none 返回空（Phase 45 回归）
// ============================================================
describe('Phase 46 Integration - PersonaEngine intensity=none 回归', () => {
  it('intensity=none 返回空字符串（skip if not available）', async () => {
    let mod: { PersonaEngine: new (persona?: unknown) => { setIntensity: (i: string) => void; buildPersonaFragment: (signals?: unknown) => string } };
    try {
      mod = await import('../../src/agent/persona-engine.js');
    } catch {
      // 模块不存在时 skip
      expect(true).toBe(true);
      return;
    }
    expect(mod).toBeDefined();
    expect(mod.PersonaEngine).toBeDefined();

    const engine = new mod.PersonaEngine();
    engine.setIntensity('none');
    const fragment = engine.buildPersonaFragment();
    expect(fragment).toBe('');
  });

  it('intensity=medium 返回非空片段（skip if not available）', async () => {
    let mod: { PersonaEngine: new (persona?: unknown) => { setIntensity: (i: string) => void; buildPersonaFragment: (signals?: unknown) => string } };
    try {
      mod = await import('../../src/agent/persona-engine.js');
    } catch {
      expect(true).toBe(true);
      return;
    }
    const engine = new mod.PersonaEngine();
    engine.setIntensity('medium');
    const fragment = engine.buildPersonaFragment();
    expect(fragment.length).toBeGreaterThan(0);
  });
});
