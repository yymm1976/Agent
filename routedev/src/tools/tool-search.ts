// src/tools/tool-search.ts
// B-01B：tool_search 工具与回合级工具提升（TurnToolBoost）
//
// 语义：
//   - tool_search 只搜索"已注册但默认未暴露"的 deferred 工具元数据（web/browser/repo map/...），
//     不执行任何工具、不绕过权限；denied 工具搜索不到。
//   - 执行时清空旧提升，把命中候选写入共享 TurnToolBoost；适配器在 getToolDefinitions
//     中把被提升的 deferred 工具临时纳入 schema（loop 每轮重新取定义后，下一轮即可调用）。
//   - 工具被实际调用成功后从 boost 收回（消费即收回），避免低频工具常驻暴露。
//   - 确定性评分（名称/描述/分类的词元匹配），不实现向量检索。

import type { IToolRegistry, ITool } from './types.js';
import { buildTool } from './types.js';

/** 回合级工具提升（共享可变引用：adapter 读取、tool_search 写入） */
export class TurnToolBoost {
  /** 当前被提升（临时可见）的 deferred 工具名 */
  readonly names = new Set<string>();

  clear(): void {
    this.names.clear();
  }

  /** 提升一组工具；返回实际新增数 */
  add(names: string[]): number {
    let added = 0;
    for (const name of names) {
      if (!this.names.has(name)) {
        this.names.add(name);
        added += 1;
      }
    }
    return added;
  }
}

export interface ToolSearchCandidate {
  name: string;
  /** 单句用途（描述截断） */
  purpose: string;
  /** 参数摘要（必填字段 + 顶层属性名） */
  parameters: string;
}

export interface ToolSearchToolOptions {
  registry: IToolRegistry;
  boost: TurnToolBoost;
  /** 权限拒绝的工具（deny 工具搜索不到） */
  deniedTools?: ReadonlySet<string>;
  /** 候选上限，默认 5 */
  maxResults?: number;
}

/** 词元化：小写 + 非字母数字/非中文字符切分 */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

/** 连续 CJK 字符的二元组（让中文 query 能命中描述中的子串） */
function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  const chars = [...text.toLowerCase()];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    if (/[\u4e00-\u9fff]/.test(chars[i]) && /[\u4e00-\u9fff]/.test(chars[i + 1])) {
      out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/** 确定性评分：query 与工具名/描述/分类的匹配度 */
export function scoreTool(
  name: string,
  description: string,
  category: string,
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  const tokens = tokenize(q);
  let score = 0;
  if (n === q) score += 100;
  else if (n.includes(q) || q.includes(n)) score += 30;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (n.includes(token)) score += 10;
    if (d.includes(token)) score += 3;
    if (category.includes(token)) score += 1;
  }
  for (const bigram of cjkBigrams(q)) {
    if (d.includes(bigram) || n.includes(bigram)) score += 2;
  }
  return score;
}

/** 候选摘要：必填参数 + 顶层属性名 */
function summarizeParameters(parameters: Record<string, unknown>): string {
  const props = (parameters.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const names = Object.keys(props);
  if (names.length === 0) return '无参数';
  return required.length > 0
    ? `必填: ${required.join(', ')}；可选: ${names.filter((x) => !required.includes(x)).join(', ')}`
    : `参数: ${names.join(', ')}`;
}

export function searchDeferredTools(
  registry: IToolRegistry,
  query: string,
  options: { deniedTools?: ReadonlySet<string>; maxResults?: number } = {},
): ToolSearchCandidate[] {
  const maxResults = options.maxResults ?? 5;
  const denied = options.deniedTools ?? new Set<string>();
  const scored: Array<{ tool: { definition: { name: string; description: string; category: string; parameters: Record<string, unknown>; exposure?: string } }; score: number }> = [];
  for (const tool of registry.list()) {
    const def = tool.definition;
    // 只搜 deferred 候选；deny 工具搜索不到
    if (def.exposure !== 'deferred') continue;
    if (denied.has(def.name)) continue;
    const score = scoreTool(def.name, def.description, def.category, query);
    if (score > 0) {
      scored.push({ tool: tool as never, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(({ tool }) => ({
    name: tool.definition.name,
    purpose: tool.definition.description.replace(/\s+/g, ' ').trim().slice(0, 120),
    parameters: summarizeParameters(tool.definition.parameters),
  }));
}

/** tool_search 工具：搜索 deferred 工具并把命中候选提升为当前回合可见 */
export function createToolSearchTool(options: ToolSearchToolOptions): ITool {
  const { registry, boost, deniedTools, maxResults } = options;
  return buildTool({
    name: 'tool_search',
    description:
      '搜索当前未暴露的低频工具（如 Web 搜索、浏览器、仓库地图、代码图谱、笔记等）。当你需要这些能力但工具列表中看不到它们时，用一句话描述你要做什么，本工具会返回最多 5 个候选工具名；在后续步骤中直接调用返回的工具名即可（仅本回合临时可见）。不要用它执行任何操作，它只返回工具元数据。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '你需要的工具能力描述，如"搜索网页"、"抓取网页内容"、"浏览器操作"',
        },
      },
      required: ['query'],
    },
    requiresApproval: false,
    category: 'search',
    async execute(args, _context) {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) {
        return { success: true, output: '请输入 query（你要搜索的工具能力描述）。', durationMs: 0 };
      }
      const candidates = searchDeferredTools(registry, query, { deniedTools, maxResults });
      // 清空旧提升，写入本轮候选（"仅当前回合暴露"的近似：下次搜索前有效，调用后即收回）
      boost.clear();
      if (candidates.length > 0) {
        boost.add(candidates.map((c) => c.name));
      }
      if (candidates.length === 0) {
        return {
          success: true,
          output: '没有找到匹配的未暴露工具。可用工具已全部在工具列表中；如需 Web/浏览器等能力请确认其已启用。',
          durationMs: 0,
        };
      }
      return {
        success: true,
        output:
          `找到 ${candidates.length} 个候选工具（已临时启用，直接调用工具名即可）：\n` +
          candidates
            .map((c) => `- ${c.name}: ${c.purpose}（${c.parameters}）`)
            .join('\n'),
        durationMs: 0,
      };
    },
  });
}
