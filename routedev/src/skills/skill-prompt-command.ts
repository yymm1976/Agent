// src/skills/skill-prompt-command.ts
// P0-8：Skill 即 Prompt Command
//
// 借鉴 Claude Code `src/skills/bundledSkills.ts`：
//   - skill 实现 type: 'prompt' 的 Command
//   - 调用 skill = 把 getPromptForCommand 返回的 text block 注入对话
//   - 副作用统一由 Bash/Edit/Agent 工具承担
//   - skill 与工具系统完全解耦（skill 自身不直接执行 IO，只产生 prompt 文本）
//
// 设计要点：
//   1. SkillPromptCommand 是个纯函数包装器：ParsedSkill + 参数 → prompt 字符串
//   2. 参数替换支持 $ARGUMENTS / $0 / $1 / $foo（按 arguments 顺序映射命名参数）
//   3. 不引入副作用，调用方负责把返回的 prompt 注入对话上下文
//   4. 与 CommandRegistry.registerLazy 集成：每个 skill 注册为 lazy 命令
//
// 注意：
//   - 此模块不直接调用 LLM，仅做 prompt 文本生成
//   - allowedTools 白名单由调用方在 ToolRegistry 层面执行（此处仅在 prompt 中声明）
//   - paths 自动激活由调用方根据上下文文件路径匹配后决定是否触发

import type { ParsedSkill, SkillArgumentDef } from './skill-md-parser.js';

/** Prompt 命令返回结果 */
export interface SkillPromptResult {
  /** 生成的 prompt 文本（注入到对话中） */
  prompt: string;
  /** 此 skill 声明的工具白名单（调用方据此过滤 ToolRegistry） */
  allowedTools?: string[];
  /** 此 skill 声明的触发条件描述（调用方可记录用于审计） */
  whenToUse?: string;
}

/** 参数解析结果（位置参数 + 命名参数） */
export interface ParsedSkillArgs {
  /** $ARGUMENTS：原始参数字符串 */
  raw: string;
  /** $0 / $1 / $2 ...：位置参数（按空白拆分） */
  positional: string[];
  /** $foo：命名参数（按 arguments 声明顺序映射） */
  named: Record<string, string>;
}

/**
 * 解析 skill 调用参数
 *
 * 借鉴 Claude Code `src/utils/argumentSubstitution.ts`：
 *   - 位置参数按空白拆分（shell-quote 简化版，不支持嵌套引号）
 *   - 命名参数按 arguments 声明顺序从位置参数消耗
 *   - 多余的位置参数保留在 $ARGUMENTS 中
 *
 * @example
 * parseSkillArgs('foo bar baz', [{ name: 'a' }, { name: 'b' }])
 * // → { raw: 'foo bar baz', positional: ['foo', 'bar', 'baz'], named: { a: 'foo', b: 'bar' } }
 */
export function parseSkillArgs(
  raw: string,
  argDefs: SkillArgumentDef[] | undefined,
): ParsedSkillArgs {
  const trimmed = (raw ?? '').trim();
  // 简化的 shell 拆分：按连续空白拆分（不支持引号嵌套，覆盖 90% 简单场景）
  const positional = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const named: Record<string, string> = {};

  if (argDefs && argDefs.length > 0) {
    for (let i = 0; i < argDefs.length && i < positional.length; i++) {
      named[argDefs[i].name] = positional[i];
    }
    // 应用 default 值（未传但声明了 default 的参数）
    for (const def of argDefs) {
      if (named[def.name] === undefined && def.default !== undefined) {
        named[def.name] = def.default;
      }
    }
  }

  return { raw, positional, named };
}

/**
 * 在 prompt 模板中替换参数占位符
 *
 * 支持的占位符（对齐 Claude Code）：
 *   - $ARGUMENTS：原始参数字符串
 *   - $0 / $1 / $2 ...：位置参数
 *   - $foo：命名参数（按 arguments 声明）
 *   - $$：转义为单个 $ 字符
 *
 * @example
 * substituteArgs('Hello $name, args: $ARGUMENTS', { raw: 'a b', positional: ['a','b'], named: { name: 'a' } })
 * // → 'Hello a, args: a b'
 */
export function substituteArgs(template: string, args: ParsedSkillArgs): string {
  if (!template.includes('$')) return template;

  // 先转义 $$ → \x00（避免后续替换干扰）
  let result = template.replace(/\$\$/g, '\x00');

  // $ARGUMENTS（必须在 $0/$1 之前替换，避免 $0 被误匹配）
  result = result.replace(/\$ARGUMENTS\b/g, args.raw);

  // 命名参数 $foo（按 argDefs 顺序尝试替换）
  // 用 \w+ 匹配参数名，再查 named 表
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(args.named, name)) {
      return args.named[name];
    }
    // 未声明的命名参数保持原样（不替换，便于调试）
    return match;
  });

  // 位置参数 $0 / $1 / $2 ...
  result = result.replace(/\$(\d+)/g, (match, idx: string) => {
    const i = parseInt(idx, 10);
    if (i < args.positional.length) return args.positional[i];
    return match; // 越界保持原样
  });

  // 恢复 $$
  result = result.replace(/\x00/g, '$');

  return result;
}

/**
 * P0-8：把 ParsedSkill 包装为 Prompt Command
 *
 * 调用此函数后返回 prompt 文本，调用方负责：
 *   1. 把 prompt 注入对话（作为 user 消息或 system 消息追加）
 *   2. 按 allowedTools 过滤 ToolRegistry（白名单执行）
 *   3. 记录 whenToUse 用于审计
 *
 * @param skill 已解析的 Skill
 * @param rawArgs 原始参数字符串（用户输入 /skill-name args... 中的 args 部分）
 * @returns prompt 文本 + 元数据
 */
export function getPromptForSkill(
  skill: ParsedSkill,
  rawArgs: string,
): SkillPromptResult {
  const argDefs = skill.metadata.arguments;
  const parsed = parseSkillArgs(rawArgs, argDefs);
  const prompt = substituteArgs(skill.content, parsed);

  return {
    prompt,
    allowedTools: skill.metadata.allowedTools,
    whenToUse: skill.metadata.whenToUse,
  };
}

/**
 * P0-8：构造 skill 命令名（注册到 CommandRegistry 时使用）
 *
 * 命令名规则：
 *   - skill name 已是 kebab-case（schema validator 保证）
 *   - 直接使用 metadata.name 作为命令名（如 /my-skill）
 *   - 不加前缀（保持 Claude Code 风格，与 /commit /init 等同等级）
 */
export function getSkillCommandName(skill: ParsedSkill): string {
  return skill.metadata.name;
}

/**
 * P0-8：生成 skill 的简短描述（用于 /help 列表）
 *
 * 格式：description [+ argument-hint]
 *
 * @example
 * '按 PR 模板写代码 <branch> <base>'
 */
export function getSkillCommandDescription(skill: ParsedSkill): string {
  const desc = skill.metadata.description || '(no description)';
  const hint = skill.metadata.argumentHint;
  return hint ? `${desc} ${hint}` : desc;
}
