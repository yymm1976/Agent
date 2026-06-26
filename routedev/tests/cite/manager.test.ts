// tests/cite/manager.test.ts
// CiteManager 单元测试
//
// 覆盖：
//   1. add/list：基本添加与查询
//   2. remove：按 ID 删除（存在/不存在）
//   3. clear：清空所有引用
//   4. size：当前引用数量
//   5. maxTags 上限触发时拒绝添加（CiteLimitExceededError）
//   6. 重复引用（同 type+source）抛出 DuplicateCiteError
//   7. formatForUI：生成正确的标签数据（图标/颜色/截断）
//   8. formatForUI：长文本截断显示，悬浮显示全文
//   9. toJSON：输出结构化列表（深拷贝，外部修改不影响内部状态）
//  10. 不同引用类型的标签样式（file/skill/tool/url/message）
//  11. blocked 状态在 formatForUI 中正确反映
//  12. createCiteItem 工厂函数自动填充 id/createdAt

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CiteManager,
  CiteLimitExceededError,
  DuplicateCiteError,
  createCiteItem,
  generateCiteId,
  getTagStyle,
  getStatusBadge,
} from '../../src/cite/manager.js';
import type { CiteItem } from '../../src/cite/types.js';

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

// ============================================================
// CiteManager 测试
// ============================================================

describe('CiteManager', () => {
  let manager: CiteManager;

  beforeEach(() => {
    manager = new CiteManager(10);
  });

  // ------------------------------------------------------------
  // 1. add / list：基本添加与查询
  // ------------------------------------------------------------
  describe('add / list：CRUD 基本操作', () => {
    it('add 后 list 应包含该引用，且按添加顺序排列', () => {
      const item1 = makeItem({ id: 'a1', source: 'src/a.ts', label: 'a.ts' });
      const item2 = makeItem({ id: 'a2', source: 'src/b.ts', label: 'b.ts' });

      manager.add(item1);
      manager.add(item2);

      const list = manager.list();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('a1');
      expect(list[1].id).toBe('a2');
      expect(list[0].source).toBe('src/a.ts');
    });

    it('list 返回只读视图，TypeScript 层 readonly 防止误写（运行时仍为数组引用）', () => {
      const item = makeItem({ id: 'a1', source: 'src/a.ts' });
      manager.add(item);

      const list = manager.list();
      // readonly 是 TypeScript 编译时检查，list() 返回内部引用以便高效读取
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('a1');
      // 不通过 add 直接修改内部数组会被 TypeScript 拒绝（编译时保护）
    });
  });

  // ------------------------------------------------------------
  // 2. remove：按 ID 删除
  // ------------------------------------------------------------
  describe('remove', () => {
    it('删除存在的引用返回 true，列表中不再包含', () => {
      const item = makeItem({ id: 'r1', source: 'src/r.ts' });
      manager.add(item);

      const result = manager.remove('r1');
      expect(result).toBe(true);
      expect(manager.size()).toBe(0);
      expect(manager.list()).toHaveLength(0);
    });

    it('删除不存在的 ID 返回 false，不抛异常', () => {
      const result = manager.remove('non-existent-id');
      expect(result).toBe(false);
    });
  });

  // ------------------------------------------------------------
  // 3. clear：清空所有引用
  // ------------------------------------------------------------
  describe('clear', () => {
    it('清空后 size 为 0，list 为空数组', () => {
      manager.add(makeItem({ id: 'c1', source: 'a.ts' }));
      manager.add(makeItem({ id: 'c2', source: 'b.ts' }));
      manager.add(makeItem({ id: 'c3', source: 'c.ts' }));
      expect(manager.size()).toBe(3);

      manager.clear();

      expect(manager.size()).toBe(0);
      expect(manager.list()).toEqual([]);
    });

    it('对空列表调用 clear 不抛异常', () => {
      expect(() => manager.clear()).not.toThrow();
      expect(manager.size()).toBe(0);
    });
  });

  // ------------------------------------------------------------
  // 4. maxTags 上限触发时拒绝添加
  // ------------------------------------------------------------
  describe('maxTags 上限', () => {
    it('达到上限后 add 抛出 CiteLimitExceededError', () => {
      const small = new CiteManager(2);
      small.add(makeItem({ id: 'm1', source: 'a.ts' }));
      small.add(makeItem({ id: 'm2', source: 'b.ts' }));

      expect(() => small.add(makeItem({ id: 'm3', source: 'c.ts' })))
        .toThrow(CiteLimitExceededError);
      expect(small.size()).toBe(2); // 第三个未添加
    });

    it('CiteLimitExceededError 的 message 包含上限数字', () => {
      const m = new CiteManager(1);
      m.add(makeItem({ id: 'x1', source: 'a.ts' }));
      try {
        m.add(makeItem({ id: 'x2', source: 'b.ts' }));
        throw new Error('应抛出 CiteLimitExceededError');
      } catch (err) {
        expect(err).toBeInstanceOf(CiteLimitExceededError);
        expect((err as Error).message).toContain('1');
      }
    });

    it('maxTags 至少为 1（传入 0 或负数时按 1 处理）', () => {
      const m = new CiteManager(0);
      m.add(makeItem({ id: 'y1', source: 'a.ts' }));
      expect(m.size()).toBe(1);
      expect(() => m.add(makeItem({ id: 'y2', source: 'b.ts' })))
        .toThrow(CiteLimitExceededError);
    });
  });

  // ------------------------------------------------------------
  // 5. 重复引用检测
  // ------------------------------------------------------------
  describe('重复引用', () => {
    it('同 type+source 的引用抛出 DuplicateCiteError', () => {
      const item1 = makeItem({ id: 'd1', type: 'file', source: 'src/x.ts' });
      const item2 = makeItem({ id: 'd2', type: 'file', source: 'src/x.ts' });

      manager.add(item1);
      expect(() => manager.add(item2)).toThrow(DuplicateCiteError);
      expect(manager.size()).toBe(1);
    });

    it('相同 source 但不同 type 不算重复', () => {
      const fileItem = makeItem({ id: 'f1', type: 'file', source: 'src/x.ts' });
      const textItem = makeItem({
        id: 't1', type: 'text', source: 'src/x.ts', content: '一些文本',
      });

      manager.add(fileItem);
      expect(() => manager.add(textItem)).not.toThrow();
      expect(manager.size()).toBe(2);
    });

    it('DuplicateCiteError 的 message 包含 source 与 type', () => {
      manager.add(makeItem({ id: 'a1', type: 'skill', source: 'my-skill' }));
      try {
        manager.add(makeItem({ id: 'a2', type: 'skill', source: 'my-skill' }));
        throw new Error('应抛出 DuplicateCiteError');
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateCiteError);
        expect((err as Error).message).toContain('my-skill');
        expect((err as Error).message).toContain('skill');
      }
    });
  });

  // ------------------------------------------------------------
  // 6. formatForUI：标签数据生成
  // ------------------------------------------------------------
  describe('formatForUI', () => {
    it('为每个引用生成 CiteTag，包含 id / type / label / color / icon / removable', () => {
      manager.add(makeItem({ id: 'u1', type: 'file', source: 'a.ts', label: 'a.ts' }));

      const tags = manager.formatForUI();
      expect(tags).toHaveLength(1);
      const tag = tags[0];
      expect(tag.id).toBe('u1');
      expect(tag.type).toBe('file');
      expect(tag.label).toBe('a.ts');
      expect(tag.color).toBeDefined();
      expect(tag.icon).toBeDefined();
      expect(tag.removable).toBe(true);
    });

    it('不同引用类型有不同图标与颜色', () => {
      const cases: Array<{ type: CiteItem['type']; expectedIcon: string; expectedColor: string }> = [
        { type: 'file',    expectedIcon: '📎', expectedColor: 'blue' },
        { type: 'folder',  expectedIcon: '📁', expectedColor: 'blue' },
        { type: 'text',    expectedIcon: '💬', expectedColor: 'purple' },
        { type: 'skill',   expectedIcon: '⚡', expectedColor: 'green' },
        { type: 'tool',    expectedIcon: '🔧', expectedColor: 'orange' },
        { type: 'macro',   expectedIcon: '📋', expectedColor: 'cyan' },
        { type: 'url',     expectedIcon: '🔗', expectedColor: 'blue' },
        { type: 'message', expectedIcon: '💬', expectedColor: 'gray' },
      ];

      for (const c of cases) {
        const m = new CiteManager(10);
        m.add(makeItem({
          id: `tag-${c.type}`,
          type: c.type,
          source: `source-${c.type}`,
          label: `label-${c.type}`,
        }));
        const tag = m.formatForUI()[0];
        expect(tag.icon, `icon for ${c.type}`).toBe(c.expectedIcon);
        expect(tag.color, `color for ${c.type}`).toBe(c.expectedColor);
      }
    });

    it('长文本标签截断显示，fullLabel 携带完整文本', () => {
      // 构造长度 > 30（LABEL_MAX_LENGTH）的标签文本
      const longLabel = '这是一个非常非常非常非常非常非常非常非常非常非常非常非常长的标签文本';
      expect(longLabel.length).toBeGreaterThan(30);
      manager.add(makeItem({ id: 'l1', type: 'text', label: longLabel }));

      const tag = manager.formatForUI()[0];
      expect(tag.label.length).toBeLessThan(longLabel.length);
      expect(tag.label.endsWith('…')).toBe(true);
      expect(tag.fullLabel).toBe(longLabel);
    });

    it('短文本标签不截断，fullLabel 为 undefined', () => {
      manager.add(makeItem({ id: 's1', label: '短标签' }));

      const tag = manager.formatForUI()[0];
      expect(tag.label).toBe('短标签');
      expect(tag.fullLabel).toBeUndefined();
    });

    it('blocked 状态在 tag 中正确反映', () => {
      manager.add(makeItem({
        id: 'b1',
        type: 'file',
        source: '.env',
        label: '.env',
        blocked: true,
        blockedReason: '敏感文件',
      }));

      const tag = manager.formatForUI()[0];
      expect(tag.blocked).toBe(true);
    });

    it('status 在 tag 中正确反映（message 引用过期）', () => {
      manager.add(makeItem({
        id: 'o1',
        type: 'message',
        source: 'node-1',
        label: '已过期消息',
        status: 'outdated',
        targetVersion: 1,
      }));

      const tag = manager.formatForUI()[0];
      expect(tag.status).toBe('outdated');
    });
  });

  // ------------------------------------------------------------
  // 7. toJSON：结构化列表
  // ------------------------------------------------------------
  describe('toJSON', () => {
    it('返回 CiteItem[]，与 list 内容一致', () => {
      manager.add(makeItem({ id: 'j1', type: 'file', source: 'a.ts', label: 'a' }));
      manager.add(makeItem({ id: 'j2', type: 'skill', source: 'my-skill', label: 'skill' }));

      const json = manager.toJSON();
      expect(json).toHaveLength(2);
      expect(json[0].id).toBe('j1');
      expect(json[1].id).toBe('j2');
      expect(json[0].type).toBe('file');
      expect(json[1].type).toBe('skill');
    });

    it('返回深拷贝，修改返回值不影响内部状态', () => {
      manager.add(makeItem({ id: 'j1', source: 'a.ts', label: 'original' }));

      const json = manager.toJSON();
      json[0].label = 'tampered';
      json.push(makeItem({ id: 'injected', source: 'evil' }));

      // 内部状态未受影响
      const list = manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].label).toBe('original');
    });
  });

  // ------------------------------------------------------------
  // 8. 工厂函数与辅助函数
  // ------------------------------------------------------------
  describe('createCiteItem / generateCiteId / getTagStyle / getStatusBadge', () => {
    it('createCiteItem 自动填充 id 与 createdAt', () => {
      const item = createCiteItem({
        type: 'file',
        source: 'a.ts',
        label: 'a.ts',
        origin: 'drag',
      });
      expect(item.id).toMatch(/^cite-/);
      expect(item.createdAt).toBeGreaterThan(0);
      expect(item.origin).toBe('drag');
    });

    it('createCiteItem 允许显式指定 id / createdAt', () => {
      const item = createCiteItem({
        id: 'custom-id',
        createdAt: 12345,
        type: 'text',
        source: 'inline',
        label: 'l',
        origin: 'user-select',
      });
      expect(item.id).toBe('custom-id');
      expect(item.createdAt).toBe(12345);
    });

    it('generateCiteId 返回唯一字符串', () => {
      const id1 = generateCiteId();
      const id2 = generateCiteId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^cite-/);
    });

    it('getTagStyle 返回对应类型的图标与颜色', () => {
      const skillStyle = getTagStyle('skill');
      expect(skillStyle.icon).toBe('⚡');
      expect(skillStyle.color).toBe('green');

      const toolStyle = getTagStyle('tool');
      expect(toolStyle.icon).toBe('🔧');
      expect(toolStyle.color).toBe('orange');
    });

    it('getStatusBadge 返回各状态的中文徽章文本', () => {
      expect(getStatusBadge('ok')).toBe('');
      expect(getStatusBadge('outdated')).toBe('已过期');
      expect(getStatusBadge('unreachable')).toBe('分支不可见');
      expect(getStatusBadge('deleted')).toBe('已删除');
    });
  });
});
