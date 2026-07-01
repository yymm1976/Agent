// src/agents/context-packer.ts
// 上下文筛选与打包：按角色权重选择来源，在 token 预算内组装上下文包
// Task 2：子 Agent 上下文打包器

export type AgentRole = 'researcher' | 'executor' | 'reviewer' | 'custom';

interface RelevantSymbol {
  id: string;
  name: string;
  type: string;
  filePath: string;
  signature?: string;
  rankScore?: number;
}

export interface ContextSources {
  codeMap?: {
    relevantSymbols?: RelevantSymbol[];
    relevantFiles?: string[];
    impactGraph?: { nodes: string[]; edges: Array<{ source: string; target: string }> };
  };
  taskBoundary: {
    designDoc: string;
    readFiles: string[];
    writeFiles: string[];
    goal: string;
    constraints: string[];
  };
  memory?: {
    projectLessons?: string[];
    historicalPitfalls?: string[];
    codingStandards?: string[];
  };
  facts?: Map<string, string>;
  parentReasoning?: string;
}

interface ContextSection {
  title: string;
  content: string;
  estimatedTokens: number;
  priority: number; // 1=最高
}

interface PassedFragment {
  /** 来源（section.title） */
  source: string;
  /** 内容摘要（section.content 前 80 字符） */
  summary: string;
  /** 权重（section.priority，1=最高） */
  weight: number;
}

interface ContextPackage {
  role: AgentRole;
  taskId: string;
  tokenBudget: number;
  sections: ContextSection[];
  metadata: {
    totalFiles: number;
    totalSymbols: number;
    estimatedTokens: number;
    truncated: boolean;
    sourceSnapshot: string;
  };
  // ===== Phase 54 Task 2 新增字段（用于选择性传递可视化） =====
  /** 传递的片段摘要列表（从 sections 映射，供协作剧场面板展示） */
  passedFragments: PassedFragment[];
  /** 被过滤的片段数（候选数 - 入选数） */
  filteredOutCount: number;
  /** 被过滤内容摘要（被截断或超预算的 section 标题列表） */
  filteredOutSummary: string;
}

// 角色权重表：决定各来源在上下文包中的优先级
export const ROLE_WEIGHTS: Record<
  AgentRole,
  { codeMap: number; taskBoundary: number; memory: number; facts: number; parentReasoning: number }
> = {
  researcher: { codeMap: 0.9, taskBoundary: 0.5, memory: 0.2, facts: 0.2, parentReasoning: 0.1 },
  executor: { codeMap: 0.8, taskBoundary: 1.0, memory: 0.6, facts: 0.5, parentReasoning: 0.2 },
  reviewer: { codeMap: 0.5, taskBoundary: 0.9, memory: 0.5, facts: 0.3, parentReasoning: 0.6 },
  custom: { codeMap: 0.5, taskBoundary: 0.5, memory: 0.5, facts: 0.5, parentReasoning: 0.5 },
};

type SourceKey = 'codeMap' | 'taskBoundary' | 'memory' | 'facts' | 'parentReasoning';

export class ContextPacker {
  /**
   * 打包上下文：
   * 1. 根据角色确定各来源权重
   * 2. 按权重从高到低处理各来源
   * 3. 代码地图符号按 rankScore 降序排列
   * 4. 在预算内选择内容，超过预算时截断并记录 truncated=true
   */
  async pack(options: {
    role: AgentRole;
    taskId: string;
    sources: ContextSources;
    budgetTokens: number;
  }): Promise<ContextPackage> {
    const { role, taskId, sources, budgetTokens } = options;
    const weights = ROLE_WEIGHTS[role];

    // 构建候选 section（按权重降序，已过滤空 section）
    const candidates = this.buildCandidates(sources, weights);

    const sections: ContextSection[] = [];
    let usedTokens = 0;
    let truncated = false;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const priority = i + 1; // 1=最高

      if (usedTokens + candidate.estimatedTokens <= budgetTokens) {
        sections.push({ ...candidate, priority });
        usedTokens += candidate.estimatedTokens;
      } else {
        const remaining = budgetTokens - usedTokens;
        if (remaining > 0) {
          // 截断当前 section 以填满剩余预算
          const truncatedContent = this.truncateText(candidate.content, remaining);
          const truncatedTokens = this.estimateTokens(truncatedContent);
          sections.push({
            title: candidate.title,
            content: truncatedContent,
            estimatedTokens: truncatedTokens,
            priority,
          });
          usedTokens += truncatedTokens;
        }
        truncated = true;
        break;
      }
    }

    // Phase 54 Task 2：填充选择性传递可视化字段
    // passedFragments：从入选 sections 映射（含被截断的 section，因其内容已传递）
    const passedFragments: PassedFragment[] = sections.map(s => ({
      source: s.title,
      summary: s.content.slice(0, 80),
      weight: s.priority,
    }));
    // filteredOutCount：候选数 - 入选数（被截断的 section 计入入选）
    const filteredOutCount = Math.max(0, candidates.length - sections.length);
    // filteredOutSummary：被过滤的 section 标题列表
    const filteredOutTitles = candidates
      .slice(sections.length)
      .map(c => c.title);
    const filteredOutSummary = filteredOutTitles.join(', ');

    return {
      role,
      taskId,
      tokenBudget: budgetTokens,
      sections,
      metadata: {
        totalFiles: this.countFiles(sources),
        totalSymbols: sources.codeMap?.relevantSymbols?.length ?? 0,
        estimatedTokens: usedTokens,
        truncated,
        sourceSnapshot: this.generateSnapshot(sources),
      },
      // Phase 54 Task 2 新增字段
      passedFragments,
      filteredOutCount,
      filteredOutSummary,
    };
  }

  /** token 估算（简单：1 token ≈ 4 字符） */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** 按 PageRank 排序符号并截断到预算内 */
  private rankAndTruncateSymbols(symbols: RelevantSymbol[] | undefined, budget: number): RelevantSymbol[] {
    if (!symbols || symbols.length === 0) return [];
    const sorted = [...symbols].sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
    const result: RelevantSymbol[] = [];
    let usedTokens = 0;
    for (const s of sorted) {
      const tokens = this.estimateTokens(this.formatSymbol(s));
      if (usedTokens + tokens > budget) break;
      result.push(s);
      usedTokens += tokens;
    }
    return result;
  }

  /** 生成一致性快照（同一来源始终产生同一快照） */
  private generateSnapshot(sources: ContextSources): string {
    return this.hash(this.stabilize(sources));
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /** 构建候选 section 列表，按权重降序排列，过滤空 section */
  private buildCandidates(
    sources: ContextSources,
    weights: Record<SourceKey, number>,
  ): ContextSection[] {
    const entries: Array<{ key: SourceKey; weight: number; section: ContextSection | null }> = [
      { key: 'codeMap', weight: weights.codeMap, section: this.buildCodeMapSection(sources) },
      { key: 'taskBoundary', weight: weights.taskBoundary, section: this.buildTaskBoundarySection(sources) },
      { key: 'memory', weight: weights.memory, section: this.buildMemorySection(sources) },
      { key: 'facts', weight: weights.facts, section: this.buildFactsSection(sources) },
      { key: 'parentReasoning', weight: weights.parentReasoning, section: this.buildParentReasoningSection(sources) },
    ];

    return entries
      .filter(e => e.section !== null)
      .sort((a, b) => b.weight - a.weight)
      .map(e => e.section as ContextSection);
  }

  private buildCodeMapSection(sources: ContextSources): ContextSection | null {
    const cm = sources.codeMap;
    if (!cm) return null;
    const lines: string[] = ['[代码地图]'];

    if (cm.relevantSymbols && cm.relevantSymbols.length > 0) {
      // 按 rankScore 降序排列符号
      const ranked = this.rankAndTruncateSymbols(cm.relevantSymbols, Number.MAX_SAFE_INTEGER);
      lines.push('相关符号（按 rankScore 降序）:');
      ranked.forEach((s, i) => {
        const rank = s.rankScore !== undefined ? ` rank=${s.rankScore.toFixed(3)}` : '';
        lines.push(`${i + 1}. ${s.name} (${s.type}) @ ${s.filePath}${rank}`);
        if (s.signature) lines.push(`   signature: ${s.signature}`);
      });
    }

    if (cm.relevantFiles && cm.relevantFiles.length > 0) {
      lines.push('相关文件:');
      cm.relevantFiles.forEach(f => lines.push(`  - ${f}`));
    }

    if (cm.impactGraph) {
      lines.push(`影响图: ${cm.impactGraph.nodes.length} 节点, ${cm.impactGraph.edges.length} 边`);
    }

    const content = lines.join('\n');
    if (content === '[代码地图]') return null;
    return { title: '代码地图', content, estimatedTokens: this.estimateTokens(content), priority: 0 };
  }

  private buildTaskBoundarySection(sources: ContextSources): ContextSection | null {
    const tb = sources.taskBoundary;
    if (!tb) return null;
    const hasContent =
      !!tb.goal ||
      !!tb.designDoc ||
      tb.readFiles.length > 0 ||
      tb.writeFiles.length > 0 ||
      tb.constraints.length > 0;
    if (!hasContent) return null;

    const lines: string[] = ['[任务边界]'];
    lines.push(`目标: ${tb.goal}`);
    lines.push(`设计文档: ${tb.designDoc}`);
    if (tb.readFiles.length > 0) {
      lines.push(`可读文件: ${tb.readFiles.join(', ')}`);
    }
    if (tb.writeFiles.length > 0) {
      lines.push(`可写文件: ${tb.writeFiles.join(', ')}`);
    }
    if (tb.constraints.length > 0) {
      lines.push('约束:');
      tb.constraints.forEach(c => lines.push(`  - ${c}`));
    }
    const content = lines.join('\n');
    return { title: '任务边界', content, estimatedTokens: this.estimateTokens(content), priority: 0 };
  }

  private buildMemorySection(sources: ContextSources): ContextSection | null {
    const m = sources.memory;
    if (!m) return null;
    const lines: string[] = ['[记忆]'];
    if (m.projectLessons?.length) {
      lines.push('项目经验:');
      m.projectLessons.forEach(l => lines.push(`  - ${l}`));
    }
    if (m.historicalPitfalls?.length) {
      lines.push('历史陷阱:');
      m.historicalPitfalls.forEach(p => lines.push(`  - ${p}`));
    }
    if (m.codingStandards?.length) {
      lines.push('编码规范:');
      m.codingStandards.forEach(s => lines.push(`  - ${s}`));
    }
    const content = lines.join('\n');
    if (content === '[记忆]') return null;
    return { title: '记忆', content, estimatedTokens: this.estimateTokens(content), priority: 0 };
  }

  private buildFactsSection(sources: ContextSources): ContextSection | null {
    const f = sources.facts;
    if (!f || f.size === 0) return null;
    const lines: string[] = ['[事实]'];
    const entries = Array.from(f.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, v] of entries) {
      lines.push(`  ${k} = ${v}`);
    }
    const content = lines.join('\n');
    return { title: '事实', content, estimatedTokens: this.estimateTokens(content), priority: 0 };
  }

  private buildParentReasoningSection(sources: ContextSources): ContextSection | null {
    const pr = sources.parentReasoning;
    if (!pr) return null;
    const content = `[父 Agent 推理]\n${pr}`;
    return { title: '父 Agent 推理', content, estimatedTokens: this.estimateTokens(content), priority: 0 };
  }

  private formatSymbol(s: RelevantSymbol): string {
    let line = `${s.name} (${s.type}) @ ${s.filePath}`;
    if (s.signature) line += ` :: ${s.signature}`;
    if (s.rankScore !== undefined) line += ` [rank=${s.rankScore}]`;
    return line;
  }

  private truncateText(text: string, budgetTokens: number): string {
    if (budgetTokens <= 0) return '';
    const maxChars = budgetTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
  }

  private countFiles(sources: ContextSources): number {
    const set = new Set<string>();
    sources.codeMap?.relevantFiles?.forEach(f => set.add(f));
    sources.taskBoundary?.readFiles?.forEach(f => set.add(f));
    sources.taskBoundary?.writeFiles?.forEach(f => set.add(f));
    return set.size;
  }

  /** 将 sources 序列化为确定性字符串（Map 转排序数组，数组排序） */
  private stabilize(sources: ContextSources): string {
    const obj = {
      codeMap: sources.codeMap
        ? {
            relevantSymbols: (sources.codeMap.relevantSymbols || []).map(s => ({
              id: s.id,
              name: s.name,
              type: s.type,
              filePath: s.filePath,
              signature: s.signature,
              rankScore: s.rankScore,
            })),
            relevantFiles: (sources.codeMap.relevantFiles || []).slice().sort(),
            impactGraph: sources.codeMap.impactGraph
              ? {
                  nodes: sources.codeMap.impactGraph.nodes.slice().sort(),
                  edges: sources.codeMap.impactGraph.edges
                    .map(e => `${e.source}->${e.target}`)
                    .sort(),
                }
              : undefined,
          }
        : undefined,
      taskBoundary: sources.taskBoundary,
      memory: sources.memory,
      facts: sources.facts
        ? Array.from(sources.facts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        : undefined,
      parentReasoning: sources.parentReasoning,
    };
    return JSON.stringify(obj);
  }

  /** djb2 哈希，输出 8 位十六进制 */
  private hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) + s.charCodeAt(i);
      h = h | 0; // 转 32 位有符号
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
