// tests/plugins/filesystem-discovery.test.ts
// Eve Filesystem-first 插件发现 + 四级扩展成本梯度 + Skills 按需加载 + Omnigent YAML 单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CONTEXT_COST_DESCRIPTIONS,
  DEFAULT_COST_BY_TYPE,
  SkillsRouter,
  FilesystemDiscovery,
  parseAgentYAML,
  type SkillDefinition,
} from '../../src/plugins/filesystem-discovery.js';

// ============================================================
// 四级扩展成本梯度
// ============================================================

describe('四级扩展成本梯度', () => {
  it('CONTEXT_COST_DESCRIPTIONS 应包含 4 个级别', () => {
    expect(CONTEXT_COST_DESCRIPTIONS.zero).toBeTruthy();
    expect(CONTEXT_COST_DESCRIPTIONS.low).toBeTruthy();
    expect(CONTEXT_COST_DESCRIPTIONS.medium).toBeTruthy();
    expect(CONTEXT_COST_DESCRIPTIONS.high).toBeTruthy();
  });

  it('DEFAULT_COST_BY_TYPE 应正确映射类型到成本', () => {
    expect(DEFAULT_COST_BY_TYPE.hook).toBe('zero');
    expect(DEFAULT_COST_BY_TYPE.skill).toBe('low');
    expect(DEFAULT_COST_BY_TYPE.plugin).toBe('medium');
    expect(DEFAULT_COST_BY_TYPE.mcp).toBe('high');
  });
});

// ============================================================
// SkillsRouter (Skills 按需加载)
// ============================================================

describe('SkillsRouter', () => {
  let router: SkillsRouter;

  beforeEach(() => {
    router = new SkillsRouter();
  });

  it('register 和 get 应正确存取 Skill', () => {
    const skill: SkillDefinition = {
      name: 'test-skill',
      description: 'A test skill',
      routingKeywords: ['test', 'demo'],
      content: 'skill body',
      sourcePath: '/tmp/skill.md',
    };
    router.register(skill);
    expect(router.get('test-skill')).toEqual(skill);
  });

  it('list 应返回所有已注册 Skill', () => {
    router.register({
      name: 'skill-a',
      description: 'skill A',
      routingKeywords: [],
      content: '',
      sourcePath: '',
    });
    router.register({
      name: 'skill-b',
      description: 'skill B',
      routingKeywords: [],
      content: '',
      sourcePath: '',
    });
    expect(router.list()).toHaveLength(2);
  });

  it('unregister 应移除 Skill', () => {
    router.register({
      name: 'to-remove',
      description: '',
      routingKeywords: [],
      content: '',
      sourcePath: '',
    });
    expect(router.unregister('to-remove')).toBe(true);
    expect(router.get('to-remove')).toBeUndefined();
  });

  it('route 应根据关键词匹配返回相关 Skill', () => {
    router.register({
      name: 'git-skill',
      description: 'Git operations helper',
      routingKeywords: ['git', 'commit', 'branch'],
      content: 'git skill body',
      sourcePath: '',
    });
    router.register({
      name: 'docker-skill',
      description: 'Docker container helper',
      routingKeywords: ['docker', 'container'],
      content: 'docker skill body',
      sourcePath: '',
    });

    const matched = router.route('help me with git commit');
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('git-skill');
  });

  it('route 应按分数排序返回多个 Skill', () => {
    router.register({
      name: 'high-score',
      description: 'git commit branch',
      routingKeywords: ['git', 'commit', 'branch'],
      content: '',
      sourcePath: '',
    });
    router.register({
      name: 'low-score',
      description: 'git helper',
      routingKeywords: ['git'],
      content: '',
      sourcePath: '',
    });

    const matched = router.route('git commit branch');
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0].name).toBe('high-score');
  });

  it('route 无匹配时应返回空数组', () => {
    router.register({
      name: 'test',
      description: 'test skill',
      routingKeywords: ['xyz'],
      content: '',
      sourcePath: '',
    });
    expect(router.route('completely unrelated task')).toEqual([]);
  });

  it('route 应尊重 maxSkills 限制', () => {
    for (let i = 0; i < 5; i++) {
      router.register({
        name: `skill-${i}`,
        description: 'common keyword',
        routingKeywords: ['common'],
        content: '',
        sourcePath: '',
      });
    }
    const matched = router.route('common keyword', 2);
    expect(matched.length).toBeLessThanOrEqual(2);
  });
});

// ============================================================
// FilesystemDiscovery (Filesystem-first 插件发现)
// ============================================================

describe('FilesystemDiscovery', () => {
  let tmpDir: string;
  let discovery: FilesystemDiscovery;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-fs-'));
    discovery = new FilesystemDiscovery(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discoverSkills 目录不存在时应返回空数组', async () => {
    const skills = await discovery.discoverSkills();
    expect(skills).toEqual([]);
  });

  it('discoverSkills 应发现 SKILL.md 文件', async () => {
    const skillDir = path.join(tmpDir, '.routedev', 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: My custom skill\nkeywords: test, demo\n---\n# My Skill\nBody content',
    );

    const skills = await discovery.discoverSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
    expect(skills[0].description).toBe('My custom skill');
    expect(skills[0].routingKeywords).toEqual(['test', 'demo']);
    expect(skills[0].content).toContain('My Skill');
  });

  it('discoverSkills 应跳过没有 SKILL.md 的目录', async () => {
    const skillDir = path.join(tmpDir, '.routedev', 'skills', 'empty-skill');
    fs.mkdirSync(skillDir, { recursive: true });

    const skills = await discovery.discoverSkills();
    expect(skills).toEqual([]);
  });

  it('discoverPlugins 应发现 .ts/.js 文件', async () => {
    const pluginsDir = path.join(tmpDir, '.routedev', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'my-plugin.ts'), 'export default {};');
    fs.writeFileSync(path.join(pluginsDir, 'another.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(pluginsDir, 'not-a-plugin.txt'), 'text');

    const plugins = await discovery.discoverPlugins();
    expect(plugins).toHaveLength(2);
    expect(plugins).toContain('my-plugin');
    expect(plugins).toContain('another');
  });

  it('discoverHooks 应发现 .ts/.js 文件', async () => {
    const hooksDir = path.join(tmpDir, '.routedev', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-exec.ts'), 'export default {};');

    const hooks = await discovery.discoverHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks).toContain('pre-exec');
  });

  it('discoverPlugins 目录不存在时应返回空数组', async () => {
    const plugins = await discovery.discoverPlugins();
    expect(plugins).toEqual([]);
  });
});

// ============================================================
// parseAgentYAML (Omnigent YAML 声明式 Agent)
// ============================================================

describe('parseAgentYAML (Omnigent YAML)', () => {
  it('应解析基本 Agent 定义', () => {
    const yaml = `
name: code-reviewer
prompt: You are a code reviewer
`;
    const agent = parseAgentYAML(yaml);
    expect(agent.name).toBe('code-reviewer');
    expect(agent.prompt).toBe('You are a code reviewer');
  });

  it('应解析带引号的值', () => {
    const yaml = `
name: "quoted-name"
prompt: 'single quoted prompt'
`;
    const agent = parseAgentYAML(yaml);
    expect(agent.name).toBe('quoted-name');
    expect(agent.prompt).toBe('single quoted prompt');
  });

  it('应跳过空行和注释', () => {
    const yaml = `
# This is a comment
name: test-agent

# Another comment
prompt: test prompt
`;
    const agent = parseAgentYAML(yaml);
    expect(agent.name).toBe('test-agent');
    expect(agent.prompt).toBe('test prompt');
  });

  it('应解析嵌套对象（executor）', () => {
    const yaml = `
name: test
prompt: test
executor:
  harness: claude-sdk
`;
    const agent = parseAgentYAML(yaml);
    expect(agent.executor).toBeDefined();
    expect(agent.executor?.harness).toBe('claude-sdk');
  });

  it('空字符串应返回空对象', () => {
    const agent = parseAgentYAML('');
    expect(agent).toEqual({});
  });
});
