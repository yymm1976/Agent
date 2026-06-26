// tests/import/tool-name-mapper.test.ts
// 工具名映射器单元测试
//
// 覆盖：
//   1. 已知 Claude Code 工具名能正确映射
//   2. 未知工具名返回 null
//   3. mapToolNames 正确分类 mapped/unmapped（陷阱 #132）
//   4. mapToolNames 去重
//   5. validateSkillTools 对未映射工具生成 warning
//   6. validateSkillTools 已映射工具进入 valid
//   7. reverseMapToolName 反查
//   8. 空输入与非法输入边界
//   9. getToolNameMap 返回副本不可影响内部

import { describe, it, expect } from 'vitest';
import {
  mapToolName,
  mapToolNames,
  validateSkillTools,
  reverseMapToolName,
  getToolNameMap,
} from '../../src/import/tool-name-mapper.js';

// ============================================================
// mapToolName 单名映射
// ============================================================

describe('mapToolName：单名映射', () => {
  it('已知的 Claude Code 工具名能正确映射到 RouteDev 工具名', () => {
    expect(mapToolName('Read')).toBe('read_file');
    expect(mapToolName('Glob')).toBe('list_directory');
    expect(mapToolName('Grep')).toBe('search_code');
    expect(mapToolName('Write')).toBe('file_write');
    expect(mapToolName('Edit')).toBe('file_edit');
    expect(mapToolName('Bash')).toBe('execute_command');
    expect(mapToolName('WebFetch')).toBe('web_fetch');
    expect(mapToolName('WebSearch')).toBe('web_search');
  });

  it('未知工具名返回 null（陷阱 #132：不静默失败）', () => {
    expect(mapToolName('UnknownTool')).toBeNull();
    expect(mapToolName('read_file')).toBeNull(); // 大小写敏感
    expect(mapToolName('read')).toBeNull();
  });

  it('空字符串与非字符串返回 null', () => {
    expect(mapToolName('')).toBeNull();
    // @ts-expect-error 测试非法输入鲁棒性
    expect(mapToolName(null)).toBeNull();
    // @ts-expect-error 测试非法输入鲁棒性
    expect(mapToolName(undefined)).toBeNull();
  });
});

// ============================================================
// mapToolNames 批量映射
// ============================================================

describe('mapToolNames：批量映射', () => {
  it('正确分类 mapped 与 unmapped（陷阱 #132）', () => {
    const result = mapToolNames(['Read', 'Write', 'UnknownTool', 'Bash']);
    expect(result.mapped).toEqual(['read_file', 'file_write', 'execute_command']);
    expect(result.unmapped).toEqual(['UnknownTool']);
  });

  it('全部已知工具时 unmapped 为空', () => {
    const result = mapToolNames(['Read', 'Glob', 'Grep']);
    expect(result.mapped).toEqual(['read_file', 'list_directory', 'search_code']);
    expect(result.unmapped).toEqual([]);
  });

  it('全部未知工具时 mapped 为空', () => {
    const result = mapToolNames(['Foo', 'Bar']);
    expect(result.mapped).toEqual([]);
    expect(result.unmapped).toEqual(['Foo', 'Bar']);
  });

  it('去重：同一工具名多次出现只保留一次', () => {
    const result = mapToolNames(['Read', 'Read', 'Read', 'Write']);
    expect(result.mapped).toEqual(['read_file', 'file_write']);
    expect(result.unmapped).toEqual([]);
  });

  it('空数组与非数组输入返回空结果', () => {
    expect(mapToolNames([])).toEqual({ mapped: [], unmapped: [] });
    // @ts-expect-error 测试非数组输入
    expect(mapToolNames(null)).toEqual({ mapped: [], unmapped: [] });
    // @ts-expect-error 测试非数组输入
    expect(mapToolNames(undefined)).toEqual({ mapped: [], unmapped: [] });
  });

  it('过滤空字符串与非字符串元素', () => {
    const result = mapToolNames(['Read', '', 'Write', null, undefined, 'Bash']);
    expect(result.mapped).toEqual(['read_file', 'file_write', 'execute_command']);
    expect(result.unmapped).toEqual([]);
  });
});

// ============================================================
// validateSkillTools Skill 工具校验
// ============================================================

describe('validateSkillTools：Skill 工具校验', () => {
  it('已映射工具进入 valid，无 warning', () => {
    const result = validateSkillTools(['Read', 'Write', 'Bash']);
    expect(result.valid).toEqual(['read_file', 'file_write', 'execute_command']);
    expect(result.invalid).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('未映射工具进入 invalid 并生成 warning（陷阱 #132）', () => {
    const result = validateSkillTools(['Read', 'UnknownTool', 'Bash']);
    expect(result.valid).toEqual(['read_file', 'execute_command']);
    expect(result.invalid).toEqual(['UnknownTool']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('UnknownTool');
    expect(result.warnings[0]).toContain('陷阱 #132');
  });

  it('多个未映射工具生成多条 warning', () => {
    const result = validateSkillTools(['Foo', 'Bar', 'Baz']);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual(['Foo', 'Bar', 'Baz']);
    expect(result.warnings).toHaveLength(3);
  });

  it('去重：重复工具名只生成一条 warning', () => {
    const result = validateSkillTools(['UnknownTool', 'UnknownTool', 'UnknownTool']);
    expect(result.invalid).toEqual(['UnknownTool']);
    expect(result.warnings).toHaveLength(1);
  });

  it('空数组与非数组输入返回空结果', () => {
    expect(validateSkillTools([])).toEqual({
      valid: [],
      invalid: [],
      warnings: [],
    });
    // @ts-expect-error 测试非数组输入
    expect(validateSkillTools(null)).toEqual({
      valid: [],
      invalid: [],
      warnings: [],
    });
  });
});

// ============================================================
// reverseMapToolName 反向映射
// ============================================================

describe('reverseMapToolName：反向映射', () => {
  it('RouteDev 工具名反查到 Claude Code 工具名', () => {
    expect(reverseMapToolName('read_file')).toBe('Read');
    expect(reverseMapToolName('list_directory')).toBe('Glob');
    expect(reverseMapToolName('execute_command')).toBe('Bash');
  });

  it('未知 RouteDev 工具名返回 null', () => {
    expect(reverseMapToolName('unknown_tool')).toBeNull();
    expect(reverseMapToolName('')).toBeNull();
  });
});

// ============================================================
// getToolNameMap 映射表副本
// ============================================================

describe('getToolNameMap：映射表副本', () => {
  it('返回包含全部 8 个映射的副本', () => {
    const map = getToolNameMap();
    expect(map.Read).toBe('read_file');
    expect(map.Glob).toBe('list_directory');
    expect(map.Grep).toBe('search_code');
    expect(map.Write).toBe('file_write');
    expect(map.Edit).toBe('file_edit');
    expect(map.Bash).toBe('execute_command');
    expect(map.WebFetch).toBe('web_fetch');
    expect(map.WebSearch).toBe('web_search');
    expect(Object.keys(map)).toHaveLength(8);
  });

  it('返回的是副本，修改不影响内部状态', () => {
    const map1 = getToolNameMap();
    map1.Read = 'tampered';
    map1.NewEntry = 'new';

    const map2 = getToolNameMap();
    expect(map2.Read).toBe('read_file'); // 未被篡改
    expect(map2).not.toHaveProperty('NewEntry');
  });
});
