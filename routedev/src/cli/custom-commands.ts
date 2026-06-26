// src/cli/custom-commands.ts
// 自定义 Slash 命令加载器
// 从 .routedev/commands/ 目录加载 Markdown 文件，解析 frontmatter + 模板变量
// Phase 47 Task 7
//
// 约束：
//   - 仅使用 Node 内置 fs / child_process，不引入新依赖
//   - 模板变量替换一次性（不递归），避免陷阱 #139
//   - 目录不存在时 fail-open 返回空数组

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CommandDefinition, CommandHandlerResult } from './command-registry.js';
import { logger } from '../utils/logger.js';

/** frontmatter 解析结果 */
interface ParsedFrontmatter {
  description: string;
  arguments?: string[];
}

/**
 * 从 Markdown 内容解析 frontmatter 和正文
 * 支持简单 YAML 子集：description / arguments 字段
 */
export function parseMarkdown(content: string): { frontmatter: ParsedFrontmatter; body: string } {
  const frontmatter: ParsedFrontmatter = { description: '' };
  let body = content;

  // 检测 frontmatter 起始标记（--- 包裹的头部）
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const fmContent = fmMatch[1];
    body = fmMatch[2];

    // 逐行解析 frontmatter（简单 YAML 子集，不引入 yaml 依赖）
    for (const line of fmContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (key === 'description') {
        frontmatter.description = value;
      } else if (key === 'arguments') {
        // 支持两种格式：[scope1, scope2] 或 scope
        const arrMatch = value.match(/^\[(.*)\]$/);
        if (arrMatch) {
          frontmatter.arguments = arrMatch[1]
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        } else if (value) {
          frontmatter.arguments = [value];
        }
      }
    }
  }

  return { frontmatter, body: body.trim() };
}

/** 执行 git 命令并返回输出（失败时返回空字符串，fail-open） */
function runGitCommand(args: string[], cwd: string): string {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0) {
      return result.stdout.trim();
    }
    return '';
  } catch {
    return '';
  }
}

/** 渲染上下文：提供模板变量值 */
interface RenderContext {
  /** 工作目录（用于执行 git 命令） */
  cwd: string;
  /** 当前编辑器文件路径（如有） */
  currentFile?: string;
}

/**
 * 渲染模板：先替换位置参数 $1/$2/...，再替换 {{变量}}
 *
 * 重要（陷阱 #139）：替换后的内容不再参与后续替换（一次性替换，不递归）
 *
 * 实现策略（占位符法）：
 *   1. 先将原始模板中的 {{变量}} 替换为唯一占位符（同时记录实际值）
 *   2. 再替换位置参数 $1/$2/...（替换值中即使包含 {{...}} 也不会被后续扫描）
 *   3. 最后将占位符替换为实际变量值
 *
 * 这样确保：
 *   - $1 替换值中的 {{git_diff}} 不会被展开
 *   - {{git_diff}} 替换值中的 $1 不会被展开
 */
export function renderTemplate(template: string, args: string[], ctx: RenderContext): string {
  // 准备变量值
  const variables = new Map<string, string>();
  variables.set('git_diff', runGitCommand(['diff'], ctx.cwd));
  variables.set('git_status', runGitCommand(['status', '--short'], ctx.cwd));
  variables.set('git_branch', runGitCommand(['branch', '--show-current'], ctx.cwd));
  variables.set('current_file', ctx.currentFile ?? '');

  // 步骤 1：将原始模板中的 {{变量}} 替换为唯一占位符（记录实际值）
  // 未知变量保持原样（不替换）
  const placeholders: string[] = [];
  const step1 = template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const placeholder = `\x00PH${placeholders.length}\x00`;
    placeholders.push(variables.has(name) ? variables.get(name)! : match);
    return placeholder;
  });

  // 步骤 2：替换位置参数 $1, $2, ...
  // 替换后的内容（可能包含 {{...}}）不会被后续替换
  const step2 = step1.replace(/\$(\d+)/g, (match, num) => {
    const idx = parseInt(num, 10) - 1;
    return idx >= 0 && idx < args.length ? args[idx] : '';
  });

  // 步骤 3：将占位符替换为实际变量值
  // 使用 split/join 替换所有出现的占位符（虽然每个占位符唯一，仍用 split/join 确保正确性）
  let step3 = step2;
  for (let i = 0; i < placeholders.length; i++) {
    step3 = step3.split(`\x00PH${i}\x00`).join(placeholders[i]);
  }

  return step3;
}

/**
 * 加载自定义命令
 * 从指定目录加载所有 .md 文件，解析 frontmatter + 模板，返回 CommandDefinition 数组
 *
 * 行为：
 *   - 目录不存在时返回空数组（fail-open）
 *   - 目录读取失败时返回空数组并 logger.warn
 *   - 单个文件解析失败时跳过该文件并 logger.warn
 *   - 命令名取自文件名（不含 .md 扩展名）
 *
 * @param commandsDir 命令目录路径（如 .routedev/commands）
 * @returns 自定义命令定义数组
 */
export function loadCustomCommands(commandsDir: string): CommandDefinition[] {
  const commands: CommandDefinition[] = [];

  // fail-open：目录不存在时返回空数组
  if (!fs.existsSync(commandsDir)) {
    return commands;
  }

  let files: string[];
  try {
    files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
  } catch (err) {
    logger.warn('Failed to read custom commands directory', { dir: commandsDir, error: String(err) });
    return commands;
  }

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    const commandName = path.basename(file, '.md');

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logger.warn('Failed to read custom command file', { file: filePath, error: String(err) });
      continue;
    }

    const { frontmatter, body } = parseMarkdown(content);
    if (!body) {
      logger.warn('Custom command has empty body, skipped', { file: filePath });
      continue;
    }

    const template = body;
    const description = frontmatter.description || `自定义命令 /${commandName}`;
    const argNames = frontmatter.arguments ?? [];

    // 创建命令定义
    const def: CommandDefinition = {
      name: commandName,
      description,
      usage: argNames.length > 0
        ? `/${commandName} ${argNames.map(a => `<${a}>`).join(' ')}`
        : `/${commandName}`,
      handler: async (args: string, handlerCtx): Promise<CommandHandlerResult> => {
        // 解析位置参数（按空白分割）
        const positionalArgs = args.trim().length > 0
          ? args.trim().split(/\s+/)
          : [];
        // 渲染模板（一次性替换，不递归）
        const rendered = renderTemplate(template, positionalArgs, { cwd: handlerCtx.cwd });
        // 将渲染后的 prompt 作为用户输入发送给 Agent（passthrough 由 App.tsx 转发到 ChatRunner）
        return { type: 'passthrough', input: rendered };
      },
    };

    commands.push(def);
  }

  return commands;
}
