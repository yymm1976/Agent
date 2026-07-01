// scripts/lint-descriptions.ts
// Phase 47 Task 2：Tool/Skill description 规范 lint 检查
// 运行方式：pnpm tsx scripts/lint-descriptions.ts
// 退出码：0 = 全部通过，1 = 有 error
//
// 检查规则：
//   1. MIN_LENGTH：description 长度 >= 20 字符
//   2. NO_TRIGGER：必须包含触发关键词（当/需要/时/使用/when/need/use）
//   3. NO_VERB：建议包含动作动词（warning，不阻断）
//
// 扫描范围：
//   - src/tools/builtin/*.ts 中的 description 字段
//   - 任意 SKILL.md 文件 frontmatter 中的 description 字段
//
// 约束：不引入新依赖，使用 Node 内置 fs 模块

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM 下获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 类型定义
// ============================================================

/** 问题严重级别 */
export type Severity = 'error' | 'warning';

/** lint 规则名 */
export type RuleName = 'MIN_LENGTH' | 'NO_TRIGGER' | 'NO_VERB';

/** 单条 lint 问题 */
export interface LintIssue {
  /** 来源文件相对路径 */
  file: string;
  /** 工具/Skill 名称 */
  name: string;
  /** 规则名 */
  rule: RuleName;
  /** 严重级别 */
  severity: Severity;
  /** 问题描述 */
  message: string;
  /** 当前 description 内容 */
  description: string;
}

/** lint 报告 */
export interface LintReport {
  /** 所有问题 */
  issues: LintIssue[];
  /** 扫描的工具/Skill 总数 */
  total: number;
  /** error 数 */
  errors: number;
  /** warning 数 */
  warnings: number;
  /** 是否通过（无 error） */
  passed: boolean;
}

// ============================================================
// 常量
// ============================================================

/** 最小 description 长度 */
const MIN_DESCRIPTION_LENGTH = 20;

/** 触发关键词（中文 + 英文） */
const TRIGGER_KEYWORDS = ['当', '需要', '时', '使用', 'when', 'need', 'use'];

/** 动作动词（用于 NO_VERB 检查，warning 级别） */
const ACTION_VERBS = [
  '查看', '创建', '搜索', '执行', '抓取', '管理', '记录', '读取', '写入',
  '编辑', '修改', '删除', '列出', '生成', '提问', '等待', '并行', '隔离',
  '了解', '定位', '扫描', '提取', '追踪', '确认', '选择', '调用',
  'view', 'create', 'search', 'execute', 'fetch', 'manage', 'record',
  'read', 'write', 'edit', 'modify', 'delete', 'list', 'generate',
  'scan', 'extract', 'track', 'confirm', 'select', 'call',
];

// ============================================================
// 工具函数
// ============================================================

/** 递归遍历目录，返回所有文件绝对路径（排除 node_modules / dist / .git） */
function walkFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walkFiles(fullPath, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/** 从 .ts 工具文件中提取 description 字段内容 */
export function extractToolDescription(filePath: string): { name: string; description: string } | null {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 匹配 name: 'xxx' 或 name: "xxx"
  const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // 匹配 description: 'xxx' 或 description: "xxx"（单行）
  // 也匹配 description:\n      'xxx'（多行，web-search.ts 风格）
  const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
  if (!descMatch) return null;
  const description = descMatch[1];

  return { name, description };
}

/** 从 SKILL.md 文件 frontmatter 中提取 description 字段 */
export function extractSkillDescription(filePath: string): { name: string; description: string } | null {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 匹配 YAML frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];

  // 提取 name 字段
  const nameMatch = frontmatter.match(/^name:\s*(.+?)\s*$/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

  // 提取 description 字段（支持单行和多行 YAML）
  const descMatch = frontmatter.match(/^description:\s*(.+?)\s*$/m);
  if (!descMatch) return null;
  const description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

  return { name, description };
}

/** 收集所有内置工具文件路径 */
export function collectBuiltinToolFiles(): string[] {
  const builtinDir = path.join(projectRoot, 'src', 'tools', 'builtin');
  if (!fs.existsSync(builtinDir)) return [];
  return walkFiles(builtinDir)
    .filter((f) => f.endsWith('.ts'))
    // 排除辅助文件（非工具实现）
    // Phase 53 Task 7：config-guard.ts 是守卫类（被 file-edit/file-write 调用），非独立工具
    .filter((f) => !f.endsWith('search-utils.ts') && !f.endsWith('todo-store.ts') && !f.endsWith('config-guard.ts'));
}

/** 收集所有 SKILL.md 文件路径 */
export function collectSkillFiles(): string[] {
  // 扫描项目根目录下所有 SKILL.md（排除 node_modules / dist / .git）
  const allFiles = walkFiles(projectRoot);
  return allFiles.filter((f) => path.basename(f) === 'SKILL.md');
}

// ============================================================
// 规则检查
// ============================================================

/** 检查单个 description，返回所有问题 */
export function checkDescription(
  name: string,
  description: string,
  file: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const relFile = path.relative(projectRoot, file);

  // 规则 1：MIN_LENGTH
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    issues.push({
      file: relFile,
      name,
      rule: 'MIN_LENGTH',
      severity: 'error',
      message: `description 长度 ${description.length} < ${MIN_DESCRIPTION_LENGTH}，过短无法承载触发场景`,
      description,
    });
  }

  // 规则 2：NO_TRIGGER
  const hasTrigger = TRIGGER_KEYWORDS.some((kw) => description.toLowerCase().includes(kw.toLowerCase()));
  if (!hasTrigger) {
    issues.push({
      file: relFile,
      name,
      rule: 'NO_TRIGGER',
      severity: 'error',
      message: `description 缺少触发关键词（${TRIGGER_KEYWORDS.join('/')}）`,
      description,
    });
  }

  // 规则 3：NO_VERB（warning）
  const hasVerb = ACTION_VERBS.some((v) => description.toLowerCase().includes(v.toLowerCase()));
  if (!hasVerb) {
    issues.push({
      file: relFile,
      name,
      rule: 'NO_VERB',
      severity: 'warning',
      message: `description 建议包含动作动词`,
      description,
    });
  }

  return issues;
}

// ============================================================
// 主入口
// ============================================================

/** 运行 lint，返回报告 */
export function runLint(): LintReport {
  const issues: LintIssue[] = [];
  let total = 0;

  // 扫描内置工具
  const toolFiles = collectBuiltinToolFiles();
  for (const file of toolFiles) {
    const extracted = extractToolDescription(file);
    if (!extracted) continue;
    total++;
    issues.push(...checkDescription(extracted.name, extracted.description, file));
  }

  // 扫描 SKILL.md
  const skillFiles = collectSkillFiles();
  for (const file of skillFiles) {
    const extracted = extractSkillDescription(file);
    if (!extracted) continue;
    total++;
    issues.push(...checkDescription(extracted.name, extracted.description, file));
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return {
    issues,
    total,
    errors,
    warnings,
    passed: errors === 0,
  };
}

/** 格式化报告为可读字符串 */
export function formatReport(report: LintReport): string {
  const lines: string[] = ['Description Lint 报告：'];
  lines.push(`  扫描 ${report.total} 个工具/Skill，发现 ${report.errors} 个 error，${report.warnings} 个 warning`);
  lines.push('');

  if (report.issues.length === 0) {
    lines.push('  ✅ 全部通过');
    return lines.join('\n');
  }

  // 按文件分组
  const byFile = new Map<string, LintIssue[]>();
  for (const issue of report.issues) {
    if (!byFile.has(issue.file)) byFile.set(issue.file, []);
    byFile.get(issue.file)!.push(issue);
  }

  for (const [file, fileIssues] of byFile) {
    lines.push(`  ${file}:`);
    for (const issue of fileIssues) {
      const mark = issue.severity === 'error' ? '❌' : '⚠️';
      lines.push(`    ${mark} [${issue.name}] ${issue.rule}: ${issue.message}`);
    }
  }

  lines.push('');
  lines.push(report.passed ? '  ✅ 通过（无 error）' : '  ❌ 失败（有 error）');
  return lines.join('\n');
}

// 仅在直接执行时运行
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const report = runLint();
  const output = formatReport(report);
  console.log(output);
  process.exit(report.passed ? 0 : 1);
}
