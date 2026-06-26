// tests/import/claude-plugin-importer.test.ts
// Claude Plugin 导入器单元测试
//
// 覆盖：
//   1. 解析 .claude-plugin/plugin.json 元数据
//   2. skills/*/SKILL.md 转换为 ImportedSkill
//   3. commands/*.md 转换为 ImportedSkill（legacy command）
//   4. agents/*.md 转换为 ImportedAgentProfile
//   5. .mcp.json 缺失时不报错（MCP 部分为空）
//   6. 输出目录 .routedev/imported/claude/<plugin-name>/ 被创建
//   7. 包含 hooks 的社区来源 plugin 标记 sandboxTrial: true（陷阱 #129）
//   8. commands 中工具调用翻译（陷阱 #132：未映射工具 warning）
//   9. plugin.json 缺失时用目录名回退
//  10. autoEnable=true 时 hooks 不进沙箱

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudePluginImporter } from '../../src/import/claude-plugin-importer.js';
import type { ImportedSkill } from '../../src/import/claude-plugin-importer.js';

// ============================================================
// 工具函数
// ============================================================

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures', 'claude-plugin', 'test-plugin');

/** 创建临时项目根目录并把 fixture 拷进去 */
async function makeTempProjectWithPlugin(): Promise<{
  projectRoot: string;
  pluginPath: string;
}> {
  const projectRoot = path.join(
    os.tmpdir(),
    `routedev-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(projectRoot, { recursive: true });

  // 把 fixture 中的 test-plugin 整个复制到 projectRoot/test-plugin
  const pluginPath = path.join(projectRoot, 'test-plugin');
  await copyDir(FIXTURE_ROOT, pluginPath);

  return { projectRoot, pluginPath };
}

/** 递归复制目录 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 递归删除目录 */
async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================
// ClaudePluginImporter 测试
// ============================================================

describe('ClaudePluginImporter', () => {
  let projectRoot: string;
  let pluginPath: string;
  let importer: ClaudePluginImporter;

  beforeEach(() => {
    importer = new ClaudePluginImporter();
  });

  afterEach(async () => {
    if (projectRoot) {
      await rmrf(projectRoot);
      projectRoot = '' as string;
      pluginPath = '' as string;
    }
  });

  // ------------------------------------------------------------
  // 1. 解析 plugin.json 元数据
  // ------------------------------------------------------------
  it('应正确解析 .claude-plugin/plugin.json 元数据', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    expect(result.metadata.name).toBe('test-plugin');
    expect(result.metadata.description).toBe('Test Claude Code plugin for Phase 48 Task 2');
    expect(result.metadata.version).toBe('1.2.3');
    expect(result.metadata.author).toBe('tester');
    expect(result.metadata.homepage).toBe('https://example.com/test-plugin');
    expect(result.metadata.license).toBe('MIT');
  });

  // ------------------------------------------------------------
  // 2. skills/*/SKILL.md 转换为 ImportedSkill
  // ------------------------------------------------------------
  it('应把 skills/*/SKILL.md 转换为 ImportedSkill', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const skillFromSkillsDir = result.skills.find((s) => !s.sourceCommand);
    expect(skillFromSkillsDir).toBeDefined();
    expect(skillFromSkillsDir!.name).toBe('example-skill');
    expect(skillFromSkillsDir!.description).toBe('当需要演示 Claude plugin 导入流程时使用此示例 skill');
    expect(skillFromSkillsDir!.version).toBe('1.0.0');
    expect(skillFromSkillsDir!.author).toBe('tester');
    expect(skillFromSkillsDir!.tags).toEqual(['example', 'demo']);
    expect(skillFromSkillsDir!.origin).toBe('claude-plugin');
    expect(skillFromSkillsDir!.pluginName).toBe('test-plugin');
    expect(skillFromSkillsDir!.autoEnable).toBe(false);
    expect(skillFromSkillsDir!.sourcePath).toContain('skills');
    expect(skillFromSkillsDir!.sourcePath).toContain('SKILL.md');
    expect(skillFromSkillsDir!.content).toContain('示例 Skill');
  });

  // ------------------------------------------------------------
  // 3. commands/*.md 转换为 ImportedSkill（legacy command）
  // ------------------------------------------------------------
  it('应把 commands/*.md 转换为 ImportedSkill 并标注 sourceCommand', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const cmdSkill = result.skills.find((s) => s.sourceCommand === 'lint');
    expect(cmdSkill).toBeDefined();
    expect(cmdSkill!.name).toBe('lint');
    expect(cmdSkill!.sourceCommand).toBe('lint');
    expect(cmdSkill!.pluginName).toBe('test-plugin');
    expect(cmdSkill!.origin).toBe('claude-plugin');
    expect(cmdSkill!.content).toContain('lint');
  });

  // ------------------------------------------------------------
  // 4. agents/*.md 转换为 ImportedAgentProfile
  // ------------------------------------------------------------
  it('应把 agents/*.md 转换为 ImportedAgentProfile', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    expect(agent.name).toBe('reviewer');
    expect(agent.pluginName).toBe('test-plugin');
    expect(agent.sourcePath).toContain('agents');
    expect(agent.sourcePath).toContain('reviewer.md');
    expect(agent.content).toContain('代码审查员');
  });

  // ------------------------------------------------------------
  // 5. .mcp.json 缺失时不报错
  // ------------------------------------------------------------
  it('.mcp.json 缺失时 MCP 部分为空，不报错', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    expect(result.mcp.servers).toEqual([]);
    // .mcp.json 缺失不应当作 warning（缺失是正常情况）
    // 仅当桥接不可用或解析失败时才 warning
  });

  // ------------------------------------------------------------
  // 6. 输出目录 .routedev/imported/claude/<plugin-name>/ 被创建
  // ------------------------------------------------------------
  it('应在项目根下创建 .routedev/imported/claude/<plugin-name>/ 输出目录', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const expectedDir = path.join(projectRoot, '.routedev', 'imported', 'claude', 'test-plugin');
    expect(result.outputDir).toBe(expectedDir);
    expect(fsSync.existsSync(expectedDir)).toBe(true);
    expect(fsSync.existsSync(path.join(expectedDir, 'manifest.json'))).toBe(true);
    expect(fsSync.existsSync(path.join(expectedDir, 'skills'))).toBe(true);
    expect(fsSync.existsSync(path.join(expectedDir, 'commands'))).toBe(true);
    expect(fsSync.existsSync(path.join(expectedDir, 'agents'))).toBe(true);
  });

  it('manifest.json 包含 metadata 与各部分清单', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const manifestPath = path.join(result.outputDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest.metadata.name).toBe('test-plugin');
    expect(manifest.metadata.version).toBe('1.2.3');
    expect(Array.isArray(manifest.skills)).toBe(true);
    expect(manifest.skills.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.agents)).toBe(true);
    expect(manifest.agents.length).toBe(1);
    expect(Array.isArray(manifest.hooks)).toBe(true);
    expect(manifest.hooks.length).toBe(2);
  });

  // ------------------------------------------------------------
  // 7. 社区来源 hooks 标记 sandboxTrial: true（陷阱 #129）
  // ------------------------------------------------------------
  it('社区来源 plugin 的 hooks 应标记 sandboxTrial: true（autoEnable=false，陷阱 #129）', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    expect(result.hooks).toHaveLength(2);
    expect(result.hooks.every((h) => h.sandboxTrial === true)).toBe(true);

    const hookNames = result.hooks.map((h) => h.name).sort();
    expect(hookNames).toEqual(['post-merge-lint', 'pre-commit-test']);
  });

  it('autoEnable=true 时 hooks 不进沙箱（sandboxTrial: false）', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: true });

    expect(result.hooks.length).toBeGreaterThan(0);
    expect(result.hooks.every((h) => h.sandboxTrial === false)).toBe(true);
  });

  // ------------------------------------------------------------
  // 8. commands 中工具调用翻译（陷阱 #132：未映射工具 warning）
  // ------------------------------------------------------------
  it('commands 中提到的未映射工具应生成 warning（陷阱 #132）', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    // lint.md 中提到了 UnknownTool，应生成 warning
    const unmappedWarning = result.warnings.find((w) => w.includes('UnknownTool'));
    expect(unmappedWarning).toBeDefined();
    expect(unmappedWarning).toContain('陷阱 #132');
  });

  it('commands 中已映射工具应翻译并追加到 content（注释形式）', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const cmdSkill = result.skills.find((s) => s.sourceCommand === 'lint');
    expect(cmdSkill).toBeDefined();
    // Read → read_file, Bash → execute_command 应在 content 末尾以注释标注
    expect(cmdSkill!.content).toContain('RouteDev 工具映射');
    expect(cmdSkill!.content).toContain('read_file');
    expect(cmdSkill!.content).toContain('execute_command');
  });

  // ------------------------------------------------------------
  // 9. plugin.json 缺失时用目录名回退
  // ------------------------------------------------------------
  it('plugin.json 缺失时应使用目录名作为 plugin name 并记入 errors + warning', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    // 删除 plugin.json
    const metaFile = path.join(pluginPath, '.claude-plugin', 'plugin.json');
    await fs.rm(metaFile, { force: true });

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    // 目录名是 test-plugin
    expect(result.metadata.name).toBe('test-plugin');
    expect(result.metadata.version).toBe('0.0.0');
    expect(result.metadata.author).toBe('unknown');

    // 应有 warning 提示 plugin.json 缺失
    const missingWarn = result.warnings.find((w) => w.includes('plugin.json'));
    expect(missingWarn).toBeDefined();

    // 应有 error 记录
    const metaError = result.errors.find((e) => e.path.includes('plugin.json'));
    expect(metaError).toBeDefined();
  });

  // ------------------------------------------------------------
  // 10. pluginPath 不存在时抛错
  // ------------------------------------------------------------
  it('pluginPath 不存在时应抛错', async () => {
    await expect(
      importer.importFromPath('/nonexistent/path/xyz', { autoEnable: false }),
    ).rejects.toThrow(/does not exist/);
  });

  // ------------------------------------------------------------
  // 11. 输出目录中的 skills/commands/agents 子目录文件正确
  // ------------------------------------------------------------
  it('输出目录中应包含 skills/ 与 commands/ 与 agents/ 子目录文件', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    // skills/example-skill.md
    const skillFile = path.join(result.outputDir, 'skills', 'example-skill.md');
    expect(fsSync.existsSync(skillFile)).toBe(true);

    // commands/lint.md
    const cmdFile = path.join(result.outputDir, 'commands', 'lint.md');
    expect(fsSync.existsSync(cmdFile)).toBe(true);

    // agents/reviewer.md
    const agentFile = path.join(result.outputDir, 'agents', 'reviewer.md');
    expect(fsSync.existsSync(agentFile)).toBe(true);
  });

  // ------------------------------------------------------------
  // 12. 自定义 outputRoot 选项
  // ------------------------------------------------------------
  it('支持通过 outputRoot 自定义输出根目录', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const customOutputRoot = path.join(projectRoot, 'custom-output');
    const result = await importer.importFromPath(pluginPath, {
      autoEnable: false,
      outputRoot: customOutputRoot,
    });

    const expectedDir = path.join(customOutputRoot, '.routedev', 'imported', 'claude', 'test-plugin');
    expect(result.outputDir).toBe(expectedDir);
    expect(fsSync.existsSync(expectedDir)).toBe(true);
  });

  // ------------------------------------------------------------
  // 13. 静态常量可访问
  // ------------------------------------------------------------
  it('暴露 PLUGIN_META_DIR / SKILLS_DIR 等常量', () => {
    expect(ClaudePluginImporter.PLUGIN_META_DIR).toBe('.claude-plugin');
    expect(ClaudePluginImporter.PLUGIN_META_FILE).toBe('plugin.json');
    expect(ClaudePluginImporter.MCP_CONFIG_FILE).toBe('.mcp.json');
    expect(ClaudePluginImporter.SKILLS_DIR).toBe('skills');
    expect(ClaudePluginImporter.COMMANDS_DIR).toBe('commands');
    expect(ClaudePluginImporter.AGENTS_DIR).toBe('agents');
  });

  // ------------------------------------------------------------
  // 14. 验证 ImportedSkill 类型字段完整性（编译时+运行时）
  // ------------------------------------------------------------
  it('ImportedSkill 包含全部必要字段（含 sourceCommand 与 pluginName）', async () => {
    ({ projectRoot, pluginPath } = await makeTempProjectWithPlugin());

    const result = await importer.importFromPath(pluginPath, { autoEnable: false });

    const skill: ImportedSkill = result.skills[0]!;
    // 类型字段断言（编译时检查 + 运行时存在性）
    expect(typeof skill.name).toBe('string');
    expect(typeof skill.description).toBe('string');
    expect(typeof skill.version).toBe('string');
    expect(typeof skill.author).toBe('string');
    expect(Array.isArray(skill.tags)).toBe(true);
    expect(typeof skill.content).toBe('string');
    expect(typeof skill.sourcePath).toBe('string');
    expect(skill.origin).toBe('claude-plugin');
    expect(typeof skill.autoEnable).toBe('boolean');
    expect(typeof skill.pluginName).toBe('string');
    // sourceCommand 在 commands/ 转换的 Skill 中有值，skills/ 的为 undefined
    expect(skill.sourceCommand === undefined || typeof skill.sourceCommand === 'string').toBe(true);
  });
});
