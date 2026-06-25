// tests/integration/phase47-task2.test.ts
// Phase 47 Task 2 集成测试：Skill/Tool description 规范与自动审计
//
// 测试策略：
//   1. lint 脚本能正确提取工具的 description
//   2. 过短的 description 被标记为 MIN_LENGTH error
//   3. 缺少触发关键词的 description 被标记为 NO_TRIGGER error
//   4. 改写后的内置工具 description 全部通过 lint（无 error）
//   5. lint 脚本对合规 description 不报错
//   6. DESCRIPTION_GUIDE.md 存在且包含核心原则
//   7. SKILL.md frontmatter description 也能被提取
//   8. verify.ts 已集成 checkDescriptionLint 检查项

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractToolDescription,
  extractSkillDescription,
  checkDescription,
  runLint,
  collectBuiltinToolFiles,
  collectSkillFiles,
  formatReport,
  type LintReport,
} from '../../scripts/lint-descriptions.js';
import { checkDescriptionLint, runAllChecks } from '../../scripts/verify.js';

// ============================================================
// 工具函数
// ============================================================

const projectRoot = path.resolve(__dirname, '..', '..');

// ============================================================
// 1. lint 脚本能正确提取工具的 description
// ============================================================
describe('Phase 47 Task 2 - 提取工具 description', () => {
  it('能从 file-read.ts 提取 file_read 的 description', () => {
    const filePath = path.join(projectRoot, 'src', 'tools', 'builtin', 'file-read.ts');
    const extracted = extractToolDescription(filePath);

    expect(extracted).not.toBeNull();
    expect(extracted!.name).toBe('file_read');
    expect(extracted!.description.length).toBeGreaterThan(0);
    // 改写后应包含触发关键词
    expect(extracted!.description).toContain('当用户');
  });

  it('能从所有内置工具文件提取 description', () => {
    const files = collectBuiltinToolFiles();
    expect(files.length).toBeGreaterThanOrEqual(10); // 至少 10 个工具

    for (const file of files) {
      const extracted = extractToolDescription(file);
      expect(extracted, `无法从 ${path.basename(file)} 提取 description`).not.toBeNull();
      expect(extracted!.name.length).toBeGreaterThan(0);
      expect(extracted!.description.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// 2. 过短的 description 被标记为 MIN_LENGTH error
// ============================================================
describe('Phase 47 Task 2 - MIN_LENGTH 规则', () => {
  it('长度 < 20 字符的 description 触发 MIN_LENGTH error', () => {
    const issues = checkDescription('short_tool', '读取文件。', '/fake/path.ts');

    const minLenIssue = issues.find((i) => i.rule === 'MIN_LENGTH');
    expect(minLenIssue).toBeDefined();
    expect(minLenIssue!.severity).toBe('error');
    expect(minLenIssue!.message).toContain('20');
  });

  it('长度 >= 20 字符的 description 不触发 MIN_LENGTH', () => {
    const goodDesc = '当用户需要读取文件内容时，使用此工具。支持行号范围。';
    const issues = checkDescription('good_tool', goodDesc, '/fake/path.ts');

    const minLenIssue = issues.find((i) => i.rule === 'MIN_LENGTH');
    expect(minLenIssue).toBeUndefined();
  });
});

// ============================================================
// 3. 缺少触发关键词的 description 被标记为 NO_TRIGGER error
// ============================================================
describe('Phase 47 Task 2 - NO_TRIGGER 规则', () => {
  it('缺少触发关键词的 description 触发 NO_TRIGGER error', () => {
    // 长度足够但无触发关键词
    const noTriggerDesc = '这是一个工具，用于处理文件内容的读取和写入操作。';
    const issues = checkDescription('no_trigger_tool', noTriggerDesc, '/fake/path.ts');

    const noTrigIssue = issues.find((i) => i.rule === 'NO_TRIGGER');
    expect(noTrigIssue).toBeDefined();
    expect(noTrigIssue!.severity).toBe('error');
  });

  it('包含触发关键词的 description 不触发 NO_TRIGGER', () => {
    const goodDesc = '当用户需要读取文件时，使用此工具。';
    const issues = checkDescription('good_tool', goodDesc, '/fake/path.ts');

    const noTrigIssue = issues.find((i) => i.rule === 'NO_TRIGGER');
    expect(noTrigIssue).toBeUndefined();
  });

  it('英文触发关键词 when/need/use 也被识别', () => {
    const engDesc = 'Use this tool when you need to search code.';
    const issues = checkDescription('eng_tool', engDesc, '/fake/path.ts');

    const noTrigIssue = issues.find((i) => i.rule === 'NO_TRIGGER');
    expect(noTrigIssue).toBeUndefined();
  });
});

// ============================================================
// 4. 改写后的内置工具 description 全部通过 lint（无 error）
// ============================================================
describe('Phase 47 Task 2 - 内置工具 description 全部合规', () => {
  it('runLint 对内置工具不产生 error', () => {
    const report = runLint();

    // 过滤出工具相关的 error（排除 SKILL.md）
    const toolErrors = report.issues.filter(
      (i) => i.severity === 'error' && i.file.includes('src' + path.sep + 'tools'),
    );

    expect(toolErrors).toHaveLength(0);
  });

  it('所有内置工具 description 长度 >= 20', () => {
    const files = collectBuiltinToolFiles();

    for (const file of files) {
      const extracted = extractToolDescription(file);
      expect(extracted, `无法从 ${path.basename(file)} 提取 description`).not.toBeNull();
      expect(
        extracted!.description.length,
        `${extracted!.name} description 长度 ${extracted!.description.length} < 20`,
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it('所有内置工具 description 包含触发关键词', () => {
    const files = collectBuiltinToolFiles();

    for (const file of files) {
      const extracted = extractToolDescription(file);
      expect(extracted, `无法从 ${path.basename(file)} 提取 description`).not.toBeNull();

      const issues = checkDescription(extracted!.name, extracted!.description, file);
      const noTrigIssue = issues.find((i) => i.rule === 'NO_TRIGGER');
      expect(
        noTrigIssue,
        `${extracted!.name} description 缺少触发关键词: "${extracted!.description}"`,
      ).toBeUndefined();
    }
  });
});

// ============================================================
// 5. lint 脚本对合规 description 不报错
// ============================================================
describe('Phase 47 Task 2 - 合规 description 不报错', () => {
  it('完全合规的 description 不产生任何 error', () => {
    const goodDesc = '当用户需要查看文件内容时，使用此工具。支持指定行号范围。';
    const issues = checkDescription('perfect_tool', goodDesc, '/fake/path.ts');

    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('runLint 整体报告 passed=true（无 error）', () => {
    const report = runLint();
    expect(report.errors).toBe(0);
    expect(report.passed).toBe(true);
  });

  it('formatReport 输出包含通过标记', () => {
    const report: LintReport = {
      issues: [],
      total: 5,
      errors: 0,
      warnings: 0,
      passed: true,
    };
    const output = formatReport(report);
    expect(output).toContain('✅');
    expect(output).toContain('通过');
  });
});

// ============================================================
// 6. DESCRIPTION_GUIDE.md 存在且包含核心原则
// ============================================================
describe('Phase 47 Task 2 - DESCRIPTION_GUIDE.md 规范文档', () => {
  it('docs/DESCRIPTION_GUIDE.md 文件存在', () => {
    const guidePath = path.join(projectRoot, 'docs', 'DESCRIPTION_GUIDE.md');
    expect(fs.existsSync(guidePath)).toBe(true);
  });

  it('包含核心原则：description 是写给模型看的', () => {
    const guidePath = path.join(projectRoot, 'docs', 'DESCRIPTION_GUIDE.md');
    const content = fs.readFileSync(guidePath, 'utf-8');

    expect(content).toContain('写给模型看的');
    expect(content).toContain('80%');
  });

  it('包含句式模板', () => {
    const guidePath = path.join(projectRoot, 'docs', 'DESCRIPTION_GUIDE.md');
    const content = fs.readFileSync(guidePath, 'utf-8');

    expect(content).toContain('当用户');
    expect(content).toContain('使用此');
    expect(content).toContain('触发场景');
  });

  it('包含检查清单', () => {
    const guidePath = path.join(projectRoot, 'docs', 'DESCRIPTION_GUIDE.md');
    const content = fs.readFileSync(guidePath, 'utf-8');

    expect(content).toContain('检查清单');
    expect(content).toContain('20 字符');
    expect(content).toContain('触发关键词');
  });
});

// ============================================================
// 7. SKILL.md frontmatter description 也能被提取
// ============================================================
describe('Phase 47 Task 2 - SKILL.md description 提取', () => {
  let tmpDir: string;
  let tmpSkillPath: string;

  beforeEach(() => {
    // 创建临时 SKILL.md 文件用于测试
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-skill-'));
    tmpSkillPath = path.join(tmpDir, 'SKILL.md');
    const content = `---
name: test-skill
description: 当用户需要执行测试任务时，使用此 Skill。支持多种测试模式。
---

# Test Skill

这是一个测试 Skill。
`;
    fs.writeFileSync(tmpSkillPath, content, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collectSkillFiles 返回数组', () => {
    const files = collectSkillFiles();
    expect(Array.isArray(files)).toBe(true);
  });

  it('extractSkillDescription 对合法 frontmatter 正确提取', () => {
    const extracted = extractSkillDescription(tmpSkillPath);

    expect(extracted).not.toBeNull();
    expect(extracted!.name).toBe('test-skill');
    expect(extracted!.description).toContain('当用户');
    expect(extracted!.description.length).toBeGreaterThan(20);
  });

  it('extractSkillDescription 对无 frontmatter 的文件返回 null', () => {
    const noFmPath = path.join(tmpDir, 'no-frontmatter.md');
    fs.writeFileSync(noFmPath, '# No frontmatter\n\n内容', 'utf-8');

    const extracted = extractSkillDescription(noFmPath);
    expect(extracted).toBeNull();
  });
});

// ============================================================
// 8. verify.ts 已集成 checkDescriptionLint 检查项
// ============================================================
describe('Phase 47 Task 2 - verify.ts 集成 description lint', () => {
  it('checkDescriptionLint 函数已导出', () => {
    expect(typeof checkDescriptionLint).toBe('function');
  });

  it('checkDescriptionLint 返回 CheckResult 结构', async () => {
    const result = await checkDescriptionLint();

    expect(result).toHaveProperty('index');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('detail');
    expect(result.index).toBe(10);
    expect(result.name).toContain('description lint');
    // 过渡期始终 passed=true
    expect(result.passed).toBe(true);
  });

  it('runAllChecks 包含 description lint 检查项', async () => {
    const report = await runAllChecks({ skipTestSuite: true });
    const lintCheck = report.results.find((r) => r.index === 10);

    expect(lintCheck).toBeDefined();
    expect(lintCheck!.name).toContain('description lint');
  });
});
