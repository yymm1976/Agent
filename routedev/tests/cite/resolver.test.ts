// tests/cite/resolver.test.ts
// CiteResolver 单元测试
//
// 覆盖：
//   1. file 引用：生成 read_file preflight
//   2. folder 引用：生成 list_directory preflight
//   3. skill 引用：提取 system prompt（SkillMdParser 解析）
//   4. macro 引用：提取 system prompt
//   5. url 引用：生成 web_fetch preflight
//   6. text 引用：截断到 maxTextCiteLength
//   7. tool 引用：生成 allowedTools 白名单
//   8. message 引用：版本一致时正常注入
//   9. message 引用：版本不一致时标记 outdated
//  10. message 引用：分支隔离时标记 unreachable
//  11. message 引用：节点删除时标记 deleted
//  12. 敏感文件引用：标记 blocked
//  13. 组装 injectedContext 字符串格式正确
//  14. 混合引用类型解析正确
//  15. 默认配置与依赖注入配置
//  16. readSkillOrMacro 抛异常时降级处理

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillMdParser } from '../../src/skills/skill-md-parser.js';
import {
  CiteResolver,
  DEFAULT_CITE_CONFIG,
  DEFAULT_SENSITIVE_PATTERNS,
} from '../../src/cite/resolver.js';
import type { CiteItem, MessageNodeInfo, CiteResolverDeps } from '../../src/cite/types.js';

// ============================================================
// 工具函数
// ============================================================

function makeItem(overrides: Partial<CiteItem> = {}): CiteItem {
  return {
    id: overrides.id ?? `cite-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? 'file',
    source: overrides.source ?? 'src/index.ts',
    label: overrides.label ?? 'index.ts',
    content: overrides.content,
    range: overrides.range,
    targetVersion: overrides.targetVersion,
    targetBranchId: overrides.targetBranchId,
    status: overrides.status,
    blocked: overrides.blocked,
    blockedReason: overrides.blockedReason,
    createdAt: overrides.createdAt ?? Date.now(),
    origin: overrides.origin ?? 'user-select',
  };
}

/** 构造 SKILL.md 内容 */
function makeSkillMd(name: string, body: string): string {
  return SkillMdParser.serialize(
    {
      name,
      description: `${name} 描述`,
      version: '1.0.0',
      author: 'tester',
      tags: ['test'],
    },
    body,
  );
}

/** 构造消息节点 */
function makeNode(overrides: Partial<MessageNodeInfo> = {}): MessageNodeInfo {
  return {
    nodeId: overrides.nodeId ?? 'node-1',
    version: overrides.version ?? 1,
    branchId: overrides.branchId ?? 'branch-1',
    deleted: overrides.deleted ?? false,
    content: overrides.content ?? '这是消息内容',
  };
}

// ============================================================
// CiteResolver 测试
// ============================================================

describe('CiteResolver', () => {
  // ------------------------------------------------------------
  // 1. file 引用：生成 read_file preflight
  // ------------------------------------------------------------
  describe('file 引用解析', () => {
    it('生成 read_file preflight，args.path 等于 item.source', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'f1',
        type: 'file',
        source: 'src/agent/branch.ts',
        label: 'branch.ts',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.preflightTools).toHaveLength(1);
      const preflight = result.preflightTools[0];
      expect(preflight.name).toBe('read_file');
      expect(preflight.args).toEqual({ path: 'src/agent/branch.ts' });
      expect(preflight.citeItemId).toBe('f1');
    });

    it('带 range 的 file 引用，preflight.args 包含 startLine / endLine', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'f2',
        type: 'file',
        source: 'src/foo.ts',
        range: { start: 10, end: 20 },
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.preflightTools[0].args).toEqual({
        path: 'src/foo.ts',
        startLine: 10,
        endLine: 20,
      });
    });
  });

  // ------------------------------------------------------------
  // 2. folder 引用：生成 list_directory preflight
  // ------------------------------------------------------------
  it('folder 引用生成 list_directory preflight', async () => {
    const resolver = new CiteResolver();
    const item = makeItem({
      id: 'fo1',
      type: 'folder',
      source: 'src/agent',
      label: 'agent 目录',
    });

    const result = await resolver.resolve({ items: [item] });

    expect(result.preflightTools).toHaveLength(1);
    expect(result.preflightTools[0].name).toBe('list_directory');
    expect(result.preflightTools[0].args).toEqual({ path: 'src/agent' });
  });

  // ------------------------------------------------------------
  // 3. skill 引用：提取 system prompt
  // ------------------------------------------------------------
  describe('skill 引用解析', () => {
    it('通过 readSkillOrMacro 读取 SKILL.md，提取 content 作为 skillPrompt', async () => {
      const skillMd = makeSkillMd('code-reviewer', '## 步骤\n1. 检查代码风格\n2. 检查测试覆盖');
      const deps: CiteResolverDeps = {
        readSkillOrMacro: vi.fn().mockResolvedValue(skillMd),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({
        id: 's1',
        type: 'skill',
        source: 'code-reviewer',
        label: 'code-reviewer',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(deps.readSkillOrMacro).toHaveBeenCalledWith('code-reviewer', 'skill');
      expect(result.skillPrompts).toHaveLength(1);
      expect(result.skillPrompts[0]).toContain('## 步骤');
      expect(result.skillPrompts[0]).toContain('检查代码风格');
    });

    it('未提供 readSkillOrMacro 时降级为 fallback 上下文，不抛异常', async () => {
      const resolver = new CiteResolver(); // 无 deps
      const item = makeItem({
        id: 's2',
        type: 'skill',
        source: 'missing-skill',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.skillPrompts).toHaveLength(0);
      expect(result.injectedContext).toContain('未提供 skill 内容读取器');
    });

    it('readSkillOrMacro 返回 null 时，输出"未找到"上下文', async () => {
      const deps: CiteResolverDeps = {
        readSkillOrMacro: vi.fn().mockResolvedValue(null),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({ id: 's3', type: 'skill', source: 'no-such-skill' });
      const result = await resolver.resolve({ items: [item] });

      expect(result.skillPrompts).toHaveLength(0);
      expect(result.injectedContext).toContain('未找到');
    });

    it('readSkillOrMacro 抛异常时降级处理，不中断解析', async () => {
      const deps: CiteResolverDeps = {
        readSkillOrMacro: vi.fn().mockRejectedValue(new Error('disk error')),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({ id: 's4', type: 'skill', source: 'will-fail' });
      const result = await resolver.resolve({ items: [item] });

      expect(result.skillPrompts).toHaveLength(0);
      expect(result.injectedContext).toContain('未找到');
    });
  });

  // ------------------------------------------------------------
  // 4. macro 引用：提取 system prompt
  // ------------------------------------------------------------
  it('macro 引用通过 readSkillOrMacro 读取 MACRO.md，提取 content 作为 macroPrompt', async () => {
    const macroMd = makeSkillMd('review-pr', '## 工作流程\n1. 读取 diff\n2. 检查风格');
    const deps: CiteResolverDeps = {
      readSkillOrMacro: vi.fn().mockResolvedValue(macroMd),
    };
    const resolver = new CiteResolver({ deps });

    const item = makeItem({
      id: 'm1',
      type: 'macro',
      source: 'review-pr',
      label: 'review-pr',
    });

    const result = await resolver.resolve({ items: [item] });

    expect(deps.readSkillOrMacro).toHaveBeenCalledWith('review-pr', 'macro');
    expect(result.macroPrompts).toHaveLength(1);
    expect(result.macroPrompts[0]).toContain('## 工作流程');
  });

  // ------------------------------------------------------------
  // 5. url 引用：生成 web_fetch preflight
  // ------------------------------------------------------------
  it('url 引用生成 web_fetch preflight，args.url 等于 item.source', async () => {
    const resolver = new CiteResolver();
    const item = makeItem({
      id: 'u1',
      type: 'url',
      source: 'https://example.com/article',
      label: 'example.com',
    });

    const result = await resolver.resolve({ items: [item] });

    expect(result.preflightTools).toHaveLength(1);
    expect(result.preflightTools[0].name).toBe('web_fetch');
    expect(result.preflightTools[0].args).toEqual({ url: 'https://example.com/article' });
  });

  // ------------------------------------------------------------
  // 6. text 引用：截断到 maxTextCiteLength
  // ------------------------------------------------------------
  describe('text 引用截断', () => {
    it('短文本完整注入，不截断', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 't1',
        type: 'text',
        source: 'inline',
        content: '这是引用的原文',
        label: '原文',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.injectedContext).toContain('这是引用的原文');
      expect(result.injectedContext).not.toContain('已截断');
    });

    it('超长文本截断到 maxTextCiteLength，并标注已截断', async () => {
      const resolver = new CiteResolver({
        config: { maxTextCiteLength: 50, maxTags: 10, maxPreflightTokens: 8000, enabled: true, autoRunPreflight: true },
      });
      const longText = 'A'.repeat(200);
      const item = makeItem({
        id: 't2',
        type: 'text',
        source: 'inline',
        content: longText,
        label: '长文本',
      });

      const result = await resolver.resolve({ items: [item] });

      // 截断后长度应 <= 50
      expect(result.injectedContext).toContain('已截断到 50');
      // 完整 200 字符的原文不应出现
      expect(result.injectedContext).not.toContain('A'.repeat(200));
    });
  });

  // ------------------------------------------------------------
  // 7. tool 引用：生成 allowedTools 白名单
  // ------------------------------------------------------------
  describe('tool 引用解析', () => {
    it('单 tool 引用：allowedTools 包含该工具名', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'tool1',
        type: 'tool',
        source: 'read_file',
        label: 'read_file',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.allowedTools).toEqual(['read_file']);
    });

    it('多 tool 引用：allowedTools 去重后包含所有工具名', async () => {
      const resolver = new CiteResolver();
      const items = [
        makeItem({ id: 'tool-a', type: 'tool', source: 'read_file' }),
        makeItem({ id: 'tool-b', type: 'tool', source: 'file_write' }),
        makeItem({ id: 'tool-c', type: 'tool', source: 'read_file' }), // 重复
      ];

      const result = await resolver.resolve({ items });

      expect(result.allowedTools).toHaveLength(2);
      expect(result.allowedTools).toContain('read_file');
      expect(result.allowedTools).toContain('file_write');
    });

    it('无 tool 引用时，allowedTools 字段不出现（undefined）', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({ id: 'no-tool', type: 'text', content: 'hi' });

      const result = await resolver.resolve({ items: [item] });

      expect(result.allowedTools).toBeUndefined();
    });
  });

  // ------------------------------------------------------------
  // 8. message 引用：版本一致时正常注入
  // ------------------------------------------------------------
  describe('message 引用解析 - 版本校验', () => {
    it('targetVersion 与 node.version 一致时，正常注入消息内容', async () => {
      const node = makeNode({ nodeId: 'n1', version: 3, content: '原始消息内容' });
      const deps: CiteResolverDeps = {
        messageNodeProvider: vi.fn().mockResolvedValue(node),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({
        id: 'msg1',
        type: 'message',
        source: 'n1',
        label: 'n1',
        targetVersion: 3,
        targetBranchId: 'branch-1',
      });

      const result = await resolver.resolve({
        items: [item],
        sessionContext: { currentBranchId: 'branch-1' },
      });

      expect(deps.messageNodeProvider).toHaveBeenCalledWith('n1');
      expect(result.blocked).toHaveLength(0);
      expect(result.injectedContext).toContain('原始消息内容');
      expect(result.injectedContext).toContain('版本：3');
    });

    it('targetVersion 与 node.version 不一致时，标记 outdated 并加入 blocked', async () => {
      const node = makeNode({ nodeId: 'n2', version: 5, content: '编辑后的内容' });
      const deps: CiteResolverDeps = {
        messageNodeProvider: vi.fn().mockResolvedValue(node),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({
        id: 'msg2',
        type: 'message',
        source: 'n2',
        targetVersion: 3, // 引用版本 3，但当前是 5
        targetBranchId: 'branch-1',
      });

      const result = await resolver.resolve({
        items: [item],
        sessionContext: { currentBranchId: 'branch-1' },
      });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].status).toBe('outdated');
      expect(result.blocked[0].blockedReason).toContain('3');
      expect(result.blocked[0].blockedReason).toContain('5');
      expect(result.injectedContext).toContain('已过期');
    });
  });

  // ------------------------------------------------------------
  // 9. message 引用：分支隔离时标记 unreachable
  // ------------------------------------------------------------
  it('message 引用 targetBranchId 与 currentBranchId 不一致时，标记 unreachable', async () => {
    const node = makeNode({ nodeId: 'n3', version: 1, branchId: 'branch-A' });
    const deps: CiteResolverDeps = {
      messageNodeProvider: vi.fn().mockResolvedValue(node),
    };
    const resolver = new CiteResolver({ deps });

    const item = makeItem({
      id: 'msg3',
      type: 'message',
      source: 'n3',
      targetVersion: 1,
      targetBranchId: 'branch-A',
    });

    const result = await resolver.resolve({
      items: [item],
      sessionContext: { currentBranchId: 'branch-B' }, // 不同分支
    });

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].status).toBe('unreachable');
    expect(result.injectedContext).toContain('分支不可见');
  });

  // ------------------------------------------------------------
  // 10. message 引用：节点删除时标记 deleted
  // ------------------------------------------------------------
  describe('message 引用 - 删除处理', () => {
    it('messageNodeProvider 返回 null 时，标记 deleted', async () => {
      const deps: CiteResolverDeps = {
        messageNodeProvider: vi.fn().mockResolvedValue(null),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({
        id: 'msg4',
        type: 'message',
        source: 'deleted-node',
        targetVersion: 1,
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].status).toBe('deleted');
      expect(result.injectedContext).toContain('已删除');
    });

    it('node.deleted 为 true 时，标记 deleted', async () => {
      const node = makeNode({ nodeId: 'n5', deleted: true });
      const deps: CiteResolverDeps = {
        messageNodeProvider: vi.fn().mockResolvedValue(node),
      };
      const resolver = new CiteResolver({ deps });

      const item = makeItem({
        id: 'msg5',
        type: 'message',
        source: 'n5',
        targetVersion: 1,
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].status).toBe('deleted');
    });

    it('未提供 messageNodeProvider 时降级，不抛异常', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'msg6',
        type: 'message',
        source: 'n6',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(0);
      expect(result.injectedContext).toContain('未提供节点查询器');
    });
  });

  // ------------------------------------------------------------
  // 11. 敏感文件引用：标记 blocked
  // ------------------------------------------------------------
  describe('敏感文件阻挡', () => {
    it('.env 文件被默认敏感模式阻挡', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'sen1',
        type: 'file',
        source: '.env',
        label: '.env',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].blocked).toBe(true);
      expect(result.blocked[0].blockedReason).toContain('.env');
      expect(result.preflightTools).toHaveLength(0); // 被阻挡不生成 preflight
    });

    it('credentials.json 文件被默认敏感模式阻挡', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'sen2',
        type: 'file',
        source: 'config/credentials.json',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(1);
    });

    it('.ssh 目录下的文件被默认敏感模式阻挡', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'sen3',
        type: 'file',
        source: '~/.ssh/id_rsa',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(1);
    });

    it('sessionContext.sensitivePatterns 覆盖默认敏感模式', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'sen4',
        type: 'file',
        source: '.env', // 默认会被阻挡
      });

      const result = await resolver.resolve({
        items: [item],
        sessionContext: { sensitivePatterns: [] }, // 清空敏感模式
      });

      expect(result.blocked).toHaveLength(0);
      expect(result.preflightTools).toHaveLength(1);
    });

    it('非敏感文件不被阻挡，正常生成 preflight', async () => {
      const resolver = new CiteResolver();
      const item = makeItem({
        id: 'sen5',
        type: 'file',
        source: 'src/index.ts',
      });

      const result = await resolver.resolve({ items: [item] });

      expect(result.blocked).toHaveLength(0);
      expect(result.preflightTools).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------
  // 12. 组装 injectedContext 字符串格式正确
  // ------------------------------------------------------------
  describe('injectedContext 组装', () => {
    it('空 items 列表时 injectedContext 为空字符串', async () => {
      const resolver = new CiteResolver();
      const result = await resolver.resolve({ items: [] });
      expect(result.injectedContext).toBe('');
    });

    it('多引用时 injectedContext 以 "---\\n引用上下文:" 开头，各 chunk 之间空行分隔', async () => {
      const resolver = new CiteResolver();
      const items = [
        makeItem({ id: 'mix1', type: 'file', source: 'a.ts', label: 'a' }),
        makeItem({ id: 'mix2', type: 'text', source: 'inline', content: '引用文本', label: 't' }),
      ];

      const result = await resolver.resolve({ items });

      expect(result.injectedContext.startsWith('---\n引用上下文:')).toBe(true);
      // 两个 chunk 之间用空行分隔
      expect(result.injectedContext).toContain('\n\n');
      // 包含两个引用的标识
      expect(result.injectedContext).toContain('📎 文件');
      expect(result.injectedContext).toContain('💬 用户引用的文本');
    });
  });

  // ------------------------------------------------------------
  // 13. 混合引用类型解析正确
  // ------------------------------------------------------------
  describe('混合引用', () => {
    it('file + skill + tool + url + text + message 混合解析', async () => {
      const skillMd = makeSkillMd('my-skill', 'Skill body');
      const node = makeNode({ nodeId: 'n-mix', version: 1, content: 'msg content' });
      const deps: CiteResolverDeps = {
        readSkillOrMacro: vi.fn().mockResolvedValue(skillMd),
        messageNodeProvider: vi.fn().mockResolvedValue(node),
      };
      const resolver = new CiteResolver({ deps });

      const items: CiteItem[] = [
        makeItem({ id: 'mix-file', type: 'file', source: 'a.ts' }),
        makeItem({ id: 'mix-skill', type: 'skill', source: 'my-skill' }),
        makeItem({ id: 'mix-tool', type: 'tool', source: 'read_file' }),
        makeItem({ id: 'mix-url', type: 'url', source: 'https://x.com' }),
        makeItem({ id: 'mix-text', type: 'text', content: '引用原文' }),
        makeItem({
          id: 'mix-msg',
          type: 'message',
          source: 'n-mix',
          targetVersion: 1,
          targetBranchId: 'branch-1',
        }),
      ];

      const result = await resolver.resolve({
        items,
        sessionContext: { currentBranchId: 'branch-1' },
      });

      // preflight：file + url = 2
      expect(result.preflightTools).toHaveLength(2);
      expect(result.preflightTools.some((p) => p.name === 'read_file')).toBe(true);
      expect(result.preflightTools.some((p) => p.name === 'web_fetch')).toBe(true);

      // skillPrompts：1
      expect(result.skillPrompts).toHaveLength(1);
      expect(result.skillPrompts[0]).toContain('Skill body');

      // allowedTools：1
      expect(result.allowedTools).toEqual(['read_file']);

      // blocked：0（message 版本一致）
      expect(result.blocked).toHaveLength(0);

      // injectedContext 包含所有类型的标识
      expect(result.injectedContext).toContain('📎 文件');
      expect(result.injectedContext).toContain('⚡ 技能');
      expect(result.injectedContext).toContain('🔧 工具');
      expect(result.injectedContext).toContain('🔗 链接');
      expect(result.injectedContext).toContain('💬 用户引用的文本');
      expect(result.injectedContext).toContain('📨 引用消息');
    });

    it('混合引用中包含敏感文件，敏感文件被阻挡但其他引用正常解析', async () => {
      const resolver = new CiteResolver();
      const items = [
        makeItem({ id: 'ok-file', type: 'file', source: 'src/a.ts' }),
        makeItem({ id: 'bad-file', type: 'file', source: '.env' }),
        makeItem({ id: 'ok-text', type: 'text', content: '正常文本' }),
      ];

      const result = await resolver.resolve({ items });

      // 一个 preflight（仅 ok-file），一个 blocked（bad-file）
      expect(result.preflightTools).toHaveLength(1);
      expect(result.preflightTools[0].args).toEqual({ path: 'src/a.ts' });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].id).toBe('bad-file');
      // injectedContext 同时包含正常引用与阻挡说明
      expect(result.injectedContext).toContain('🚫 阻挡');
      expect(result.injectedContext).toContain('正常文本');
    });
  });

  // ------------------------------------------------------------
  // 14. 默认配置与依赖注入
  // ------------------------------------------------------------
  describe('配置与依赖注入', () => {
    it('DEFAULT_CITE_CONFIG 提供合理默认值', () => {
      expect(DEFAULT_CITE_CONFIG.enabled).toBe(true);
      expect(DEFAULT_CITE_CONFIG.maxTags).toBe(10);
      expect(DEFAULT_CITE_CONFIG.maxTextCiteLength).toBe(2000);
      expect(DEFAULT_CITE_CONFIG.maxPreflightTokens).toBe(8000);
      expect(DEFAULT_CITE_CONFIG.autoRunPreflight).toBe(true);
    });

    it('DEFAULT_SENSITIVE_PATTERNS 包含 .env / credentials / .ssh 等关键模式', () => {
      expect(DEFAULT_SENSITIVE_PATTERNS).toContain('**/*.env');
      expect(DEFAULT_SENSITIVE_PATTERNS.some((p) => p.includes('credentials'))).toBe(true);
      expect(DEFAULT_SENSITIVE_PATTERNS.some((p) => p.includes('.ssh'))).toBe(true);
    });

    it('构造时传入 partial config，与默认值合并', async () => {
      const resolver = new CiteResolver({
        config: { maxTextCiteLength: 100 },
      });

      // 通过文本截断行为验证 maxTextCiteLength 已生效
      const item = makeItem({
        id: 'cfg1',
        type: 'text',
        content: 'A'.repeat(150),
      });
      const result = await resolver.resolve({ items: [item] });

      expect(result.injectedContext).toContain('已截断到 100');
    });

    it('autoRunPreflight 选项不影响 preflight 生成（只控制是否实际执行）', async () => {
      const resolver = new CiteResolver({
        config: { autoRunPreflight: false },
      });
      const item = makeItem({ id: 'cfg2', type: 'file', source: 'a.ts' });

      const result = await resolver.resolve({
        items: [item],
        autoRunPreflight: false,
      });

      // preflight 仍生成（只是不实际执行）
      expect(result.preflightTools).toHaveLength(1);
    });
  });
});
