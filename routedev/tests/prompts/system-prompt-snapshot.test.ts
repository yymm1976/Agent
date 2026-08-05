// tests/prompts/system-prompt-snapshot.test.ts
// B-02A：系统提示稳定/动态分区与去重快照测试
//
// 验收点：
//   - 行为指令不丢失（稳定区包含身份/执行纪律/工具协议）
//   - 工具描述只存在于 schema（系统提示不再逐工具复述描述）
//   - 稳定区 hash 不随动态变量（项目规则/会话）变化
//   - 提示 token/字符数低于合理上限
import { describe, expect, it } from 'vitest';
import {
  PromptTemplateManager,
  splitPromptZones,
  promptStats,
  stableZoneHash,
  summarizeToolsForPrompt,
  STABLE_ZONE_BOUNDARY,
} from '../../src/prompts/manager.js';

const BASE_CONTEXT = {
  language: '中文',
  autonomyMode: 'auto',
  availableTools: '- 文件读写：file_read, file_write',
  projectRules: '项目规则 A',
  projectMemory: '记忆 B',
  cwd: '/tmp/proj',
  taskShape: 'multi-step-impl',
  userProfile: '',
};

describe('B-02A 稳定/动态分区', () => {
  it('main.system 渲染后可拆分为稳定区与动态区', async () => {
    const manager = new PromptTemplateManager();
    const zones = await manager.renderPromptZones('main.system', BASE_CONTEXT);
    expect(zones.stable.length).toBeGreaterThan(0);
    expect(zones.dynamic.length).toBeGreaterThan(0);
    expect(zones.stable).not.toContain(STABLE_ZONE_BOUNDARY);
  });

  it('稳定区包含身份/执行纪律/工具协议；动态区包含项目规则与会话', async () => {
    const manager = new PromptTemplateManager();
    const zones = await manager.renderPromptZones('main.system', BASE_CONTEXT);
    expect(zones.stable).toContain('你是 RouteDev');
    expect(zones.stable).toContain('<execution_policy>');
    expect(zones.stable).toContain('<tool_protocol>');
    expect(zones.dynamic).toContain('项目规则 A');
    expect(zones.dynamic).toContain('/tmp/proj');
  });

  it('稳定区 hash 不随动态变量变化（项目规则/工作目录不同 → hash 相同）', async () => {
    const manager = new PromptTemplateManager();
    const a = await manager.renderPromptZones('main.system', BASE_CONTEXT);
    const b = await manager.renderPromptZones('main.system', {
      ...BASE_CONTEXT,
      projectRules: '完全不同的规则',
      cwd: '/elsewhere',
      taskShape: 'qa',
    });
    expect(stableZoneHash(a.stable)).toBe(stableZoneHash(b.stable));
  });

  it('动态变量不同 → 动态区不同（保证拆分有效）', async () => {
    const manager = new PromptTemplateManager();
    const a = await manager.renderPromptZones('main.system', BASE_CONTEXT);
    const b = await manager.renderPromptZones('main.system', { ...BASE_CONTEXT, projectRules: '不同规则' });
    expect(a.dynamic).not.toBe(b.dynamic);
  });

  it('无边界标记的模板（项目覆盖）全部视为动态区（P1 缓存安全修正）', () => {
    const zones = splitPromptZones('没有标记的模板内容');
    // 无标记 = 无法证明前缀稳定 → 全部动态，绝不误判为缓存前缀
    expect(zones.stable).toBe('');
    expect(zones.dynamic).toBe('没有标记的模板内容');
  });

  it('P1: availableTools/autonomyMode 在动态区（不在稳定缓存前缀内）', async () => {
    const manager = new PromptTemplateManager();
    const zones = await manager.renderPromptZones('main.system', {
      ...BASE_CONTEXT,
      availableTools: '文件工具：file_read, file_write',
      autonomyMode: 'auto',
    });
    // 工具面/自主度每轮变化——必须落在动态区，否则缓存前缀随工具面漂移
    expect(zones.stable).not.toContain('file_read');
    // session 块（语言/自主度/工作目录/任务形状）在边界之后
    expect(zones.stable).not.toContain('工作目录');
    expect(zones.dynamic).toContain('file_read');
    expect(zones.dynamic).toContain('自主度：auto');
    expect(zones.dynamic).toContain('工作目录');
  });
});

describe('B-02A 提示成本与去重', () => {
  it('完整渲染的提示在合理预算内（< 4000 字符、< 2000 token）', async () => {
    const manager = new PromptTemplateManager();
    const rendered = await manager.render('main.system', BASE_CONTEXT);
    const stats = promptStats(rendered);
    expect(stats.chars).toBeGreaterThan(1000);
    expect(stats.chars).toBeLessThan(4000);
    expect(stats.tokens).toBeLessThan(2000);
  });

  it('工具摘要只含工具名分组，不含参数与长描述', () => {
    const summary = summarizeToolsForPrompt([
      { name: 'file_read', category: 'file' },
      { name: 'file_write', category: 'file' },
      { name: 'shell_exec', category: 'shell' },
      { name: 'mcp__foo', category: 'mcp' },
    ]);
    expect(summary).toContain('file_read');
    expect(summary).toContain('文件读写');
    expect(summary).toContain('命令执行');
    expect(summary).toContain('MCP 扩展');
    // 不含参数复述（schema 才是参数权威来源）
    expect(summary).not.toContain('properties');
    expect(summary).not.toContain('required');
  });

  it('空工具列表返回占位', () => {
    expect(summarizeToolsForPrompt([])).toBe('（无可用工具）');
  });

  it('promptStats 中文感知估算', () => {
    const stats = promptStats('中文内容'.repeat(100));
    expect(stats.chars).toBe(400);
    expect(stats.tokens).toBeGreaterThanOrEqual(400); // CJK 每字 1.5 token
  });
});
