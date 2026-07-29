// scripts/audit-system-prompt.ts
// Phase 96+ B2：系统提示词精简审计
//
// 运行方式：pnpm audit:prompt
// 退出码：0 = 通过，1 = 有 error（如总 token 超阈值）
//
// 功能：
//   1. 加载 main.system 模板（不实例化 PromptManager，避免依赖项目运行时）
//   2. 替换所有 {{var}} 为典型样例值
//   3. 用 tiktoken 估算总 token
//   4. 按 XML 标签分段（<identity> / <core_principles> / <tool_protocol> ...）
//   5. 输出分段占比 + 瘦身候选（>200 tokens 的段）
//   6. 与 Claude Code 2800 tokens 基准对比
//
// 不引入新依赖：tiktoken 已是项目 devDependency

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encoding_for_model } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 配置
// ============================================================

/** Claude Code 系统提示词基准 token 数 */
const CLAUDE_CODE_BASELINE = 2800;
/** 单段瘦身候选阈值（tokens） */
const SEGMENT_SLIM_THRESHOLD = 200;
/** 总 token 警告阈值（超过则退出码 1） */
const TOTAL_TOKEN_ERROR_THRESHOLD = 4000;

/** 典型样例值（用于替换 {{var}}） */
const SAMPLE_VALUES: Record<string, string> = {
  routeDecision: 'tier=complex, model=claude-sonnet-4-5, provider=anthropic',
  conciseThinking: '',
  availableTools: 'file_read, file_edit, file_write, shell_exec, git_op, code_search, glob, spawn_agent, web_search, ask_user (共 22 个工具)',
  autonomyMode: 'semi',
  language: '中文',
  cwd: 'C:/Users/demo/projects/my-app',
  taskShape: 'multi-step-impl',
  projectRules: '<project_rules>\n- 测试用 vitest\n- 提交前先 pnpm typecheck\n- 不要直接修改 generated/ 目录\n</project_rules>',
  projectMemory: '',
  entityState: '',
  conversationContext: '',
  blackboard: '',
};

// ============================================================
// 工具函数
// ============================================================

/** 从 manager.ts 源码中提取 main.system 模板内容 */
function extractMainSystemTemplate(): string {
  const managerPath = path.join(projectRoot, 'src/prompts/manager.ts');
  const source = fs.readFileSync(managerPath, 'utf-8');

  // 用正则匹配 'main.system' 模板的 content 字段
  // 模板定义为 `content: \`...\`` 形式（反引号字符串）
  const mainSystemStart = source.indexOf("'main.system':");
  if (mainSystemStart === -1) {
    throw new Error("无法在 manager.ts 中找到 'main.system' 模板定义");
  }

  // 从 main.system 开始向后找 content: ` 反引号字符串
  const contentStart = source.indexOf('content: `', mainSystemStart);
  if (contentStart === -1) {
    throw new Error("无法找到 main.system 的 content 字段");
  }
  const templateStart = contentStart + 'content: `'.length;

  // 找到配对的闭合反引号（忽略转义）
  let i = templateStart;
  let template = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === '`') {
      template += '`';
      i += 2;
      continue;
    }
    if (ch === '`') {
      break;
    }
    template += ch;
    i++;
  }
  if (i >= source.length) {
    throw new Error("main.system 模板反引号未闭合");
  }
  return template;
}

/** 替换 {{var}} 占位符为样例值 */
function replaceVariables(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
    const value = SAMPLE_VALUES[varName];
    if (value === undefined) {
      // 未提供样例值的变量，用占位符标记
      return `[未填充:${varName}]`;
    }
    return value;
  });
}

/** 按 XML 标签分段 */
interface Segment {
  name: string;
  content: string;
  tokens: number;
}

function segmentByXmlTags(content: string): Segment[] {
  const segments: Segment[] = [];
  // 匹配 <tag>...</tag>（含属性）
  const tagPattern = /<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let hasTopLevelContent = false;

  while ((match = tagPattern.exec(content)) !== null) {
    // 标签之前的内容（顶级文本）
    if (match.index > lastIndex) {
      const between = content.slice(lastIndex, match.index).trim();
      if (between) {
        segments.push({
          name: '(top-level)',
          content: between,
          tokens: 0,
        });
        hasTopLevelContent = true;
      }
    }
    segments.push({
      name: match[1],
      content: match[2].trim(),
      tokens: 0,
    });
    lastIndex = tagPattern.lastIndex;
  }

  // 末尾顶级文本
  if (lastIndex < content.length) {
    const tail = content.slice(lastIndex).trim();
    if (tail) {
      segments.push({
        name: '(top-level-tail)',
        content: tail,
        tokens: 0,
      });
      hasTopLevelContent = true;
    }
  }

  // 如果没有任何 XML 标签，整段作为一个 segment
  if (segments.length === 0) {
    segments.push({
      name: '(whole)',
      content: content,
      tokens: 0,
    });
  }
  return segments;
}

/** 用 tiktoken 估算 token 数 */
function countTokens(text: string, encoding: Tiktoken): number {
  return encoding.encode(text).length;
}

// ============================================================
// 主流程
// ============================================================

function main(): void {
  console.log('='.repeat(60));
  console.log('RouteDev 系统提示词精简审计');
  console.log('='.repeat(60));

  // 1. 提取模板
  let rawTemplate: string;
  try {
    rawTemplate = extractMainSystemTemplate();
  } catch (e) {
    console.error(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`\n[1] 已加载 main.system 模板（${rawTemplate.length} 字符）`);

  // 2. 替换变量
  const filled = replaceVariables(rawTemplate);
  console.log(`[2] 已替换变量（${filled.length} 字符）`);

  // 3. tiktoken 估算
  // 用 gpt-4o 编码（通用估算基线）
  const encoding = encoding_for_model('gpt-4o');
  const totalTokens = countTokens(filled, encoding);
  console.log(`[3] 总 token 估算：${totalTokens}（tiktoken gpt-4o）`);

  // 4. 分段
  const segments = segmentByXmlTags(filled);
  for (const seg of segments) {
    seg.tokens = countTokens(seg.content, encoding);
  }

  // 5. 输出分段报告
  console.log(`\n[4] 分段 token 占比：`);
  console.log('-'.repeat(60));
  console.log(
    '段名'.padEnd(28) +
    'tokens'.padStart(8) +
    '占比'.padStart(10) +
    '状态'.padStart(10),
  );
  console.log('-'.repeat(60));

  let errorCount = 0;
  let warnCount = 0;
  for (const seg of segments) {
    const pct = totalTokens > 0 ? (seg.tokens / totalTokens) * 100 : 0;
    let status = 'OK';
    if (seg.tokens > SEGMENT_SLIM_THRESHOLD) {
      status = '瘦身候选';
      warnCount++;
    }
    console.log(
      seg.name.padEnd(28) +
      String(seg.tokens).padStart(8) +
      `${pct.toFixed(1)}%`.padStart(10) +
      status.padStart(10),
    );
  }
  console.log('-'.repeat(60));

  // 6. 与基准对比
  console.log(`\n[5] 基准对比：`);
  console.log(`  Claude Code 基准：${CLAUDE_CODE_BASELINE} tokens`);
  console.log(`  RouteDev 当前：${totalTokens} tokens`);
  const diff = totalTokens - CLAUDE_CODE_BASELINE;
  const diffPct = (diff / CLAUDE_CODE_BASELINE) * 100;
  if (diff > 0) {
    console.log(`  超出基准：+${diff} tokens (+${diffPct.toFixed(1)}%)`);
  } else {
    console.log(`  低于基准：${diff} tokens (${diffPct.toFixed(1)}%)`);
  }

  // 7. 瘦身建议
  console.log(`\n[6] 瘦身建议：`);
  const slimCandidates = segments.filter((s) => s.tokens > SEGMENT_SLIM_THRESHOLD);
  if (slimCandidates.length === 0) {
    console.log('  无瘦身候选段（所有段均 < 200 tokens）');
  } else {
    for (const seg of slimCandidates) {
      console.log(`  - <${seg.name}>: ${seg.tokens} tokens`);
      console.log(`    建议精简或拆分为按需 Skill 注入`);
    }
  }

  // 8. 总结与退出码
  console.log(`\n[7] 审计总结：`);
  console.log(`  段数：${segments.length}`);
  console.log(`  瘦身候选：${warnCount} 个`);
  console.log(`  总 token：${totalTokens}`);

  encoding.free();

  if (totalTokens > TOTAL_TOKEN_ERROR_THRESHOLD) {
    console.log(`\n[FAIL] 总 token ${totalTokens} 超过阈值 ${TOTAL_TOKEN_ERROR_THRESHOLD}，需要精简`);
    process.exit(1);
  }
  console.log(`\n[PASS] 总 token 在阈值内`);
  process.exit(0);
}

main();
