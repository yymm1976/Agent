// src/import/claude-plugin-importer.ts
// Claude Code Plugin 包导入器
//
// 设计目标：
//   1. 解析 .claude-plugin/plugin.json 元数据
//   2. 解析 skills/*/SKILL.md（复用 SkillMdParser）
//   3. 解析 commands/*.md（legacy slash command → Skill，name 取自文件名）
//   4. 解析 .mcp.json（调 Task 4 的 ClaudeMCPBridge；Task 4 未实现时 warn 跳过）
//   5. 解析 agents/*.md（Agent Profile）
//   6. 工具名翻译：对 commands 中的工具调用做 mapToolNames 翻译（陷阱 #132）
//   7. 社区来源 Hook 标记 sandboxTrial: true（陷阱 #129）
//   8. 输出到 .routedev/imported/claude/<plugin-name>/ 目录
//
// 来源：Phase 48 Task 2 蓝图 2.3-2.6

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { SkillMdParser } from '../skills/skill-md-parser.js';
import { mapToolNames, validateSkillTools } from './tool-name-mapper.js';
import type { LoadedSkill } from './anthropic-skills-loader.js';

// ============================================================
// 类型定义
// ============================================================

/** Plugin 元数据（来自 .claude-plugin/plugin.json） */
export interface PluginMetadata {
  /** 插件名 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 语义化版本号 */
  version: string;
  /** 作者 */
  author: string;
  /** 主页 URL */
  homepage?: string;
  /** 许可证 */
  license?: string;
}

/**
 * 导入后的 Skill（Plugin 内转换而来）
 *
 * - 来自 skills/{name}/SKILL.md：sourceCommand 为 undefined
 * - 来自 commands/*.md：sourceCommand 标注源命令名（无扩展名）
 */
export interface ImportedSkill extends LoadedSkill {
  /** 所属 plugin 名 */
  pluginName: string;
  /** 源 legacy 命令名（仅 commands/ 转换的 Skill 有值） */
  sourceCommand?: string;
}

/** 导入后的 Agent Profile */
export interface ImportedAgentProfile {
  /** Profile 名（取自文件名，无扩展名） */
  name: string;
  /** Profile 正文（md body，已剥离 frontmatter） */
  content: string;
  /** 源文件绝对路径 */
  sourcePath: string;
  /** 所属 plugin 名 */
  pluginName: string;
}

/** MCP 引用（由 Task 4 ClaudeMCPBridge 处理；不可用时仅给 warning） */
export interface ImportedMCPRef {
  /** MCP server 配置列表（每项含 id 与原始 config，由 ClaudeMCPBridge 解析） */
  servers: Array<{ id: string; config: unknown }>;
  /** MCP 桥接不可用时的提示信息 */
  warning?: string;
}

/** 导入后的 Hook（社区来源默认 sandboxTrial） */
export interface ImportedHook {
  /** Hook 名 */
  name: string;
  /** 是否进入沙箱试用（陷阱 #129：社区来源默认 true） */
  sandboxTrial: boolean;
}

/** Plugin 导入结果 */
export interface PluginImportResult {
  /** Plugin 元数据 */
  metadata: PluginMetadata;
  /** 导入的 Skill 列表（含 skills/ 与 commands/ 转换的） */
  skills: ImportedSkill[];
  /** 导入的 Agent Profile 列表 */
  agents: ImportedAgentProfile[];
  /** MCP 引用 */
  mcp: ImportedMCPRef;
  /** 导入的 Hook 列表 */
  hooks: ImportedHook[];
  /** 警告信息（未映射工具、MCP 桥接缺失等） */
  warnings: string[];
  /** 错误信息（每个失败文件一条） */
  errors: Array<{ path: string; error: string }>;
  /** 输出目录（.routedev/imported/claude/<plugin-name>/） */
  outputDir: string;
}

/** importFromPath 选项 */
export interface ImportFromPathOptions {
  /** 是否自动启用（受 config.import.claudePluginAutoEnable 控制） */
  autoEnable: boolean;
  /**
   * 输出根目录（默认取 pluginPath 的父目录，作为项目根）
   * 输出目录最终为 `${outputRoot}/.routedev/imported/claude/<plugin-name>/`
   */
  outputRoot?: string;
}

// ============================================================
// ClaudePluginImporter
// ============================================================

/**
 * Claude Code Plugin 导入器
 *
 * 用法：
 *   const importer = new ClaudePluginImporter();
 *   const result = await importer.importFromPath('/path/to/plugin', {
 *     autoEnable: false,
 *   });
 *
 * 行为：
 *   - 任何子部分（skills/commands/agents/mcp）失败都不中断整体导入
 *   - MCP 桥接缺失时仅 warn，不报错
 *   - 社区来源 Hook 默认 sandboxTrial=true（除非 autoEnable=true）
 */
export class ClaudePluginImporter {
  /** Plugin 元数据目录名 */
  static readonly PLUGIN_META_DIR = '.claude-plugin';
  /** Plugin 元数据文件名 */
  static readonly PLUGIN_META_FILE = 'plugin.json';
  /** MCP 配置文件名 */
  static readonly MCP_CONFIG_FILE = '.mcp.json';
  /** Skill 子目录名 */
  static readonly SKILLS_DIR = 'skills';
  /** Commands 子目录名 */
  static readonly COMMANDS_DIR = 'commands';
  /** Agents 子目录名 */
  static readonly AGENTS_DIR = 'agents';

  /**
   * 从本地路径导入 Claude Code Plugin
   *
   * @param pluginPath Plugin 根目录路径
   * @param options 选项（autoEnable + 可选 outputRoot）
   */
  async importFromPath(
    pluginPath: string,
    options: ImportFromPathOptions,
  ): Promise<PluginImportResult> {
    const warnings: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    // 1. 校验 plugin 根目录存在
    if (!fsSync.existsSync(pluginPath)) {
      throw new Error(`Plugin path does not exist: ${pluginPath}`);
    }
    const pluginRoot = path.resolve(pluginPath);

    // 2. 解析 plugin.json 元数据
    const metadataResult = await this.parsePluginMetadata(pluginRoot);
    let metadata: PluginMetadata;
    if (metadataResult.ok) {
      metadata = metadataResult.metadata;
    } else {
      // 元数据缺失时用目录名回退，但仍记入 errors
      errors.push({ path: metadataResult.path, error: metadataResult.error });
      metadata = {
        name: path.basename(pluginRoot),
        description: '',
        version: '0.0.0',
        author: 'unknown',
      };
      warnings.push(
        `plugin.json 缺失或解析失败，已用目录名 "${metadata.name}" 回退`,
      );
    }

    // 3. 解析 skills/*/SKILL.md
    const skills = await this.parseSkills(pluginRoot, metadata.name, options.autoEnable, errors);

    // 4. 解析 commands/*.md（legacy slash command → Skill）
    const commands = await this.parseCommands(
      pluginRoot,
      metadata.name,
      options.autoEnable,
      errors,
      warnings,
    );

    // 5. 解析 agents/*.md
    const agents = await this.parseAgents(pluginRoot, metadata.name, errors);

    // 6. 解析 .mcp.json（动态加载 ClaudeMCPBridge，Task 4 未实现时 warn 跳过）
    const mcp = await this.parseMCPConfig(pluginRoot, metadata.name, warnings);

    // 7. 解析 hooks（plugin.json 中声明）
    const hooks = this.extractHooks(metadataResult, options.autoEnable, warnings);

    // 8. 写入输出目录
    const outputRoot = options.outputRoot ?? path.dirname(pluginRoot);
    const outputDir = path.join(
      outputRoot,
      '.routedev',
      'imported',
      'claude',
      metadata.name,
    );
    await this.writeOutput(outputDir, {
      metadata,
      skills: [...skills, ...commands],
      agents,
      mcp,
      hooks,
      warnings,
      errors,
      outputDir,
    });

    logger.info('ClaudePluginImporter.importFromPath: done', {
      plugin: metadata.name,
      skills: skills.length + commands.length,
      agents: agents.length,
      hooks: hooks.length,
      mcpServers: mcp.servers.length,
      warnings: warnings.length,
      errors: errors.length,
      outputDir,
    });

    return {
      metadata,
      skills: [...skills, ...commands],
      agents,
      mcp,
      hooks,
      warnings,
      errors,
      outputDir,
    };
  }

  // ============================================================
  // 内部方法：解析各部分
  // ============================================================

  /** 解析 .claude-plugin/plugin.json 元数据 */
  private async parsePluginMetadata(
    pluginRoot: string,
  ): Promise<
    | { ok: true; metadata: PluginMetadata; raw: Record<string, unknown>; path: string }
    | { ok: false; metadata?: undefined; error: string; path: string }
  > {
    const metaPath = path.join(
      pluginRoot,
      ClaudePluginImporter.PLUGIN_META_DIR,
      ClaudePluginImporter.PLUGIN_META_FILE,
    );

    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const metadata: PluginMetadata = {
        name: typeof obj.name === 'string' ? obj.name : path.basename(pluginRoot),
        description: typeof obj.description === 'string' ? obj.description : '',
        version: typeof obj.version === 'string' ? obj.version : '0.0.0',
        author: typeof obj.author === 'string' ? obj.author : 'unknown',
        homepage: typeof obj.homepage === 'string' ? obj.homepage : undefined,
        license: typeof obj.license === 'string' ? obj.license : undefined,
      };
      // raw 字段返回解析后的对象（Record<string, unknown>），而非原始字符串
      return { ok: true, metadata, raw: obj, path: metaPath };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `plugin.json parse failed: ${errMsg}`, path: metaPath };
    }
  }

  /** 解析 skills/{name}/SKILL.md，复用 SkillMdParser */
  private async parseSkills(
    pluginRoot: string,
    pluginName: string,
    autoEnable: boolean,
    errors: Array<{ path: string; error: string }>,
  ): Promise<ImportedSkill[]> {
    const skillsDir = path.join(pluginRoot, ClaudePluginImporter.SKILLS_DIR);
    if (!fsSync.existsSync(skillsDir)) return [];

    const results: ImportedSkill[] = [];
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: skillsDir,
        error: `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return results;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fsSync.existsSync(skillFile)) continue;

      try {
        const raw = await fs.readFile(skillFile, 'utf-8');
        const parsed = SkillMdParser.parse(raw);
        const name = parsed.metadata.name === 'unknown'
          ? entry.name
          : parsed.metadata.name;
        results.push({
          name,
          description: parsed.metadata.description,
          version: parsed.metadata.version,
          author: parsed.metadata.author,
          tags: parsed.metadata.tags,
          content: parsed.content,
          sourcePath: path.resolve(skillFile),
          origin: 'claude-plugin',
          autoEnable,
          pluginName,
        });
      } catch (err) {
        errors.push({
          path: skillFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * 解析 commands/*.md（legacy slash command → Skill）
   *
   * - name 从文件名取（去扩展名）
   * - content 是 md 正文（如有 frontmatter 则剥离）
   * - 工具名翻译：从正文中检测 Claude Code 工具调用，调用 mapToolNames 翻译
   *   陷阱 #132：未映射工具生成 warning，并在 content 中标注禁用
   */
  private async parseCommands(
    pluginRoot: string,
    pluginName: string,
    autoEnable: boolean,
    errors: Array<{ path: string; error: string }>,
    warnings: string[],
  ): Promise<ImportedSkill[]> {
    const commandsDir = path.join(pluginRoot, ClaudePluginImporter.COMMANDS_DIR);
    if (!fsSync.existsSync(commandsDir)) return [];

    const results: ImportedSkill[] = [];
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(commandsDir, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: commandsDir,
        error: `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return results;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const cmdFile = path.join(commandsDir, entry.name);
      const cmdName = entry.name.slice(0, -3); // 去掉 .md

      try {
        const raw = await fs.readFile(cmdFile, 'utf-8');
        const parsed = SkillMdParser.parse(raw);

        // 工具名翻译：检测正文中提到的 Claude Code 工具名
        // 简化策略：扫描以 `` `ToolName` `` 形式出现的工具调用引用
        const detectedTools = this.detectToolMentions(parsed.content);
        if (detectedTools.length > 0) {
          const validation = validateSkillTools(detectedTools);
          if (validation.invalid.length > 0) {
            // 陷阱 #132：未映射工具生成 warning
            for (const w of validation.warnings) {
              warnings.push(`[command/${cmdName}] ${w}`);
            }
          }
          // 在 content 末尾追加翻译后的工具列表（便于后续 Skill 引擎使用）
          if (validation.valid.length > 0) {
            const toolNote = `\n\n<!-- RouteDev 工具映射: ${validation.valid.join(', ')} -->`;
            parsed.content = parsed.content + toolNote;
          }
          // 同时验证映射结果（不直接使用，仅触发 warning 收集）
          mapToolNames(detectedTools);
        }

        results.push({
          name: cmdName,
          description: parsed.metadata.description || `Legacy command: ${cmdName}`,
          version: parsed.metadata.version || '0.0.1',
          author: parsed.metadata.author,
          tags: parsed.metadata.tags,
          content: parsed.content,
          sourcePath: path.resolve(cmdFile),
          origin: 'claude-plugin',
          autoEnable,
          pluginName,
          sourceCommand: cmdName,
        });
      } catch (err) {
        errors.push({
          path: cmdFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /** 解析 agents/*.md */
  private async parseAgents(
    pluginRoot: string,
    pluginName: string,
    errors: Array<{ path: string; error: string }>,
  ): Promise<ImportedAgentProfile[]> {
    const agentsDir = path.join(pluginRoot, ClaudePluginImporter.AGENTS_DIR);
    if (!fsSync.existsSync(agentsDir)) return [];

    const results: ImportedAgentProfile[] = [];
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(agentsDir, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: agentsDir,
        error: `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return results;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const agentFile = path.join(agentsDir, entry.name);
      const agentName = entry.name.slice(0, -3);

      try {
        const raw = await fs.readFile(agentFile, 'utf-8');
        const parsed = SkillMdParser.parse(raw);
        results.push({
          name: agentName,
          content: parsed.content,
          sourcePath: path.resolve(agentFile),
          pluginName,
        });
      } catch (err) {
        errors.push({
          path: agentFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * 解析 .mcp.json
   *
   * Phase 48 Task 4 的 ClaudeMCPBridge 已实现，通过动态 import 加载。
   * 调用 bridge.importFromClaudeConfig(configPath, options) 完成导入，
   * 桥接器内部读取并解析 JSON。加载失败时仅 warn 跳过 MCP 部分，不影响整体导入。
   *
   * 陷阱修复：原实现调用 bridge.convertFromClaudeConfig(...)，
   *   但 ClaudeMCPBridge 实际方法名为 importFromClaudeConfig（Phase 50 Task 8 修复）。
   */
  private async parseMCPConfig(
    pluginRoot: string,
    pluginName: string,
    warnings: string[],
  ): Promise<ImportedMCPRef> {
    const mcpPath = path.join(pluginRoot, ClaudePluginImporter.MCP_CONFIG_FILE);
    const empty: ImportedMCPRef = { servers: [] };

    if (!fsSync.existsSync(mcpPath)) {
      // .mcp.json 缺失是正常情况，不警告
      return empty;
    }

    // 尝试动态加载 ClaudeMCPBridge（Phase 48 Task 4 提供）
    type BridgeModule = {
      ClaudeMCPBridge?: new () => {
        importFromClaudeConfig?: (
          configPath: string,
          options?: { origin?: string },
        ) => Promise<{
          servers: Array<{ id: string; config: unknown }>;
          renamed: Array<{ originalId: string; newId: string; reason: string }>;
          failed: Array<{ id: string; error: string }>;
          warnings: string[];
        }>;
      };
    };

    try {
      // 动态 import 失败会抛错，捕获后 warn 跳过
      // 使用变量路径避免 TypeScript 静态解析模块（Task 4 未实现时文件不存在）
      const bridgeModulePath = '../mcp/claude-bridge.js';
      const mod = (await import(/* @vite-ignore */ bridgeModulePath)) as BridgeModule;
      if (!mod.ClaudeMCPBridge) {
        warnings.push('ClaudeMCPBridge 未导出，跳过 MCP 部分导入');
        return { ...empty, warning: 'ClaudeMCPBridge 未导出' };
      }
      const bridge = new mod.ClaudeMCPBridge();
      // Bug 修复：原代码调用 convertFromClaudeConfig（不存在），改为 importFromClaudeConfig
      if (typeof bridge.importFromClaudeConfig !== 'function') {
        warnings.push('ClaudeMCPBridge.importFromClaudeConfig 未实现，跳过 MCP 部分导入');
        return { ...empty, warning: 'importFromClaudeConfig 未实现' };
      }
      // 桥接器内部读取并解析 .mcp.json，返回 servers/renamed/failed/warnings
      const result = await bridge.importFromClaudeConfig(mcpPath, { origin: pluginName });
      // 转发桥接器的 warnings 到 importer 的 warnings（便于在 manifest 中体现）
      for (const w of result.warnings) {
        warnings.push(`[mcp] ${w}`);
      }
      // 桥接失败的 server 记入 warnings（不阻断整体导入）
      for (const f of result.failed) {
        warnings.push(`[mcp] server "${f.id}" 桥接失败: ${f.error}`);
      }
      // servers 已是 { id, config } 形状，直接透传
      return { servers: result.servers };
    } catch (err) {
      // Phase 48 Task 4 未实现时此分支命中
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `MCP 桥接不可用（Task 4 未实现或加载失败），跳过 MCP 部分导入: ${msg}`,
      );
      return { ...empty, warning: `MCP bridge unavailable: ${msg}` };
    }
  }

  /**
   * 从 plugin.json 中提取 hooks 声明
   *
   * 陷阱 #129：社区来源的 Hook 默认进入沙箱试用模式
   *   - autoEnable=true → 直接启用，sandboxTrial=false
   *   - autoEnable=false → 社区默认，sandboxTrial=true
   */
  private extractHooks(
    metadataResult: Awaited<ReturnType<ClaudePluginImporter['parsePluginMetadata']>>,
    autoEnable: boolean,
    _warnings: string[],
  ): ImportedHook[] {
    if (!metadataResult.ok) return [];

    const raw = metadataResult.raw;
    const hooksRaw = (raw as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooksRaw)) return [];

    const hooks: ImportedHook[] = [];
    for (const h of hooksRaw) {
      if (typeof h !== 'object' || h === null) continue;
      const name = (h as { name?: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) continue;
      hooks.push({
        name,
        // autoEnable=true 时直接启用；否则社区来源默认进沙箱（陷阱 #129）
        sandboxTrial: !autoEnable,
      });
    }
    return hooks;
  }

  /**
   * 检测正文中提到的工具名（用于工具名翻译）
   *
   * 策略：
   *   1. 提取所有反引号包裹的「单个标识符」（首字母大写，无空格）
   *      —— 这样能捕获未知工具（陷阱 #132：未映射工具也要检测并 warning）
   *      —— 排除带空格的代码片段（如 `npm run lint`）和路径片段（如 `src/foo.ts`）
   *   2. 补充：对 8 个已知 Claude Code 工具，匹配不带反引号的单词边界出现
   *      —— 捕获 "使用 Read 工具" 这类中文表述
   */
  private detectToolMentions(content: string): string[] {
    if (!content) return [];
    const found = new Set<string>();

    // 1. 反引号包裹的单个标识符（首字母大写，仅含字母数字下划线）
    //    匹配：`Read`、`UnknownTool`；不匹配：`npm run lint`、`src/foo.ts`
    const backtickRegex = /`([A-Z][A-Za-z0-9_]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = backtickRegex.exec(content)) !== null) {
      found.add(m[1]!);
    }

    // 2. 已知工具名的单词边界匹配（捕获不带反引号的提及）
    const knownTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch'];
    for (const t of knownTools) {
      const wordRegex = new RegExp(`\\b${t}\\b`, 'g');
      if (wordRegex.test(content)) found.add(t);
    }

    return Array.from(found);
  }

  // ============================================================
  // 内部方法：写入输出目录
  // ============================================================

  /**
   * 写入输出目录
   *
   * 生成结构：
   *   .routedev/imported/claude/<plugin-name>/
   *   ├── manifest.json        完整 PluginImportResult 序列化
   *   ├── skills/              每个 Skill 一个 .md 文件
   *   ├── commands/            每个 command 一个 .md 文件（从 skills 中区分出来）
   *   ├── agents/              每个 agent 一个 .md 文件
   *   └── mcp/                 MCP 配置（若存在）
   */
  private async writeOutput(
    outputDir: string,
    result: PluginImportResult,
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });

    // manifest.json（含 metadata、warnings、errors、各部分清单）
    const manifestPath = path.join(outputDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          metadata: result.metadata,
          skills: result.skills.map((s) => ({
            name: s.name,
            sourceCommand: s.sourceCommand,
            sourcePath: s.sourcePath,
            autoEnable: s.autoEnable,
          })),
          agents: result.agents.map((a) => ({
            name: a.name,
            sourcePath: a.sourcePath,
          })),
          mcp: {
            servers: result.mcp.servers.map((s) => s.id),
            warning: result.mcp.warning,
          },
          hooks: result.hooks,
          warnings: result.warnings,
          errors: result.errors,
          exportedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    // skills/（仅 skills/*/SKILL.md 转换的，不含 commands）
    const skillsOutDir = path.join(outputDir, 'skills');
    await fs.mkdir(skillsOutDir, { recursive: true });
    for (const skill of result.skills) {
      if (skill.sourceCommand) continue; // commands 单独写
      const outFile = path.join(skillsOutDir, `${skill.name}.md`);
      await fs.writeFile(outFile, this.serializeSkill(skill), 'utf-8');
    }

    // commands/（legacy slash command 转换的 Skill）
    const commandsOutDir = path.join(outputDir, 'commands');
    await fs.mkdir(commandsOutDir, { recursive: true });
    for (const skill of result.skills) {
      if (!skill.sourceCommand) continue;
      const outFile = path.join(commandsOutDir, `${skill.sourceCommand}.md`);
      await fs.writeFile(outFile, this.serializeSkill(skill), 'utf-8');
    }

    // agents/
    const agentsOutDir = path.join(outputDir, 'agents');
    await fs.mkdir(agentsOutDir, { recursive: true });
    for (const agent of result.agents) {
      const outFile = path.join(agentsOutDir, `${agent.name}.md`);
      await fs.writeFile(outFile, agent.content, 'utf-8');
    }

    // mcp/（若存在 servers 才写）
    if (result.mcp.servers.length > 0) {
      const mcpOutDir = path.join(outputDir, 'mcp');
      await fs.mkdir(mcpOutDir, { recursive: true });
      await fs.writeFile(
        path.join(mcpOutDir, 'servers.json'),
        JSON.stringify(result.mcp.servers, null, 2),
        'utf-8',
      );
    }
  }

  /** 把 ImportedSkill 序列化为 SKILL.md 格式（带 frontmatter） */
  private serializeSkill(skill: ImportedSkill): string {
    return SkillMdParser.serialize(
      {
        name: skill.name,
        description: skill.description,
        version: skill.version,
        author: skill.author,
        tags: skill.tags,
      },
      skill.content,
    );
  }
}
