// src/agent/goal-prompt-builder.ts
// Phase 40 Task 8：/goal 生命周期进化 —— 五段式规范
//
// 五段式规范（FivePartGoalSpec）将用户模糊的目标描述结构化为：
//   goal        —— 目标（一句话说清要做什么）
//   scope       —— 范围（改哪些文件/模块，不改哪些）
//   constraints —— 约束（技术栈、性能、兼容性等硬性限制）
//   doneWhen    —— 完成标准（怎么算做完，可验证）
//   stopIf      —— 停止条件（遇到什么情况立即停下）
//   tokenBudget —— Token 预算（软停止线 = 90%）
//
// 设计取舍：
//   - build() 模拟 LLM 调用，实际用规则模板（避免测试依赖网络）
//   - isAmbiguous() 用纯规则判定，零成本、确定性
//   - serialize/parse 用 Markdown 往返，便于人工审阅与版本对比

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 五段式目标规范 */
export interface FivePartGoalSpec {
  /** 目标（一句话） */
  goal: string;
  /** 范围（改哪些、不改哪些） */
  scope: string;
  /** 约束列表（硬性限制） */
  constraints: string[];
  /** 完成标准（可验证的验收条件） */
  doneWhen: string[];
  /** 停止条件（遇到即停） */
  stopIf: string[];
  /** Token 预算 */
  tokenBudget: number;
}

// ============================================================
// 规则关键词
// ============================================================

/** 动词白名单：含这些动词视为有明确动作 */
const ACTION_VERBS = ['实现', '修复', '添加', '重构', '优化', '删除', '查看', '新增', '修改', '编写', '运行'];

/** 模糊量词/指代词：含这些视为模糊 */
const AMBIGUOUS_WORDS = ['一些', '大概', '差不多', '之类的', '某些', '若干', '适当', '相关', '等等'];

/** 简单命令白名单：这些短命令即使短也不算模糊 */
const SIMPLE_COMMANDS = ['查看 git 状态', '列出文件', '查看状态', 'git status', 'ls', '查看日志'];

/** 默认 Token 预算 */
const DEFAULT_TOKEN_BUDGET = 50000;

// ============================================================
// GoalPromptBuilder
// ============================================================

export class GoalPromptBuilder {
  /**
   * 从用户描述生成五段式规范（模拟 LLM 调用，实际用规则模板）
   *
   * @param userInput 用户原始目标描述
   * @param clarifications 澄清回答（可选，key=维度名，value=回答）
   */
  async build(
    userInput: string,
    clarifications?: Record<string, string>,
  ): Promise<FivePartGoalSpec> {
    // 模拟 LLM 思考延迟（保留接口语义，实际不 sleep 以加快测试）
    logger.debug('GoalPromptBuilder.build', {
      inputLength: userInput.length,
      hasClarifications: !!clarifications,
    });

    // 合并澄清回答到目标文本
    const enrichedGoal = clarifications && Object.keys(clarifications).length > 0
      ? GoalPromptBuilder.enrichGoal(userInput, clarifications)
      : userInput;

    // 规则模板：从输入中提取约束、完成标准、停止条件
    const constraints = GoalPromptBuilder.extractConstraints(userInput, clarifications);
    const doneWhen = GoalPromptBuilder.extractDoneWhen(userInput, clarifications);
    const stopIf = GoalPromptBuilder.extractStopIf(userInput);
    const scope = GoalPromptBuilder.extractScope(userInput, clarifications);

    return {
      goal: enrichedGoal,
      scope,
      constraints,
      doneWhen,
      stopIf,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
    };
  }

  /**
   * 判断目标是否模糊（需要澄清）
   *
   * 规则：
   *   1. 输入长度 < 10 字符 → 模糊
   *   2. 不含动词（实现/修复/添加/重构/优化/删除/查看） → 模糊
   *   3. 含模糊词（"一些"、"大概"、"差不多"、"之类的"） → 模糊
   *   4. 简单命令（"查看 git 状态"、"列出文件"） → 不模糊
   */
  static isAmbiguous(userInput: string): boolean {
    if (!userInput || userInput.trim().length === 0) {
      return true;
    }

    const trimmed = userInput.trim();

    // 简单命令白名单优先（即使短也不算模糊）
    for (const cmd of SIMPLE_COMMANDS) {
      if (trimmed.toLowerCase().includes(cmd.toLowerCase())) {
        return false;
      }
    }

    // 规则 1：长度过短
    if (trimmed.length < 10) {
      return true;
    }

    // 规则 3：含模糊词
    for (const word of AMBIGUOUS_WORDS) {
      if (trimmed.includes(word)) {
        return true;
      }
    }

    // 规则 2：不含动词
    const hasVerb = ACTION_VERBS.some((v) => trimmed.includes(v));
    if (!hasVerb) {
      return true;
    }

    return false;
  }

  /**
   * 生成澄清问题，必须覆盖四个维度：
   *   1. 实现细节（用什么算法/库/模式）
   *   2. 必要决策（是否改接口、是否新增依赖）
   *   3. 完成标准（怎么算做完、验收测试）
   *   4. 范围边界（哪些不改、哪些不碰）
   */
  static generateClarificationQuestions(
    userInput: string,
  ): Array<{ dimension: string; question: string }> {
    return [
      {
        dimension: '实现细节',
        question: `针对"${userInput.slice(0, 30)}"，计划用什么算法/库/模式来实现？请说明技术选型。`,
      },
      {
        dimension: '必要决策',
        question: '是否需要修改现有接口或新增依赖？如果有，请列出。',
      },
      {
        dimension: '完成标准',
        question: '怎样算做完？请给出可验证的验收标准（如测试通过、类型检查无误）。',
      },
      {
        dimension: '范围边界',
        question: '哪些文件/模块不修改？哪些边界不触碰？',
      },
    ];
  }

  /**
   * 用用户回答增强 goal 文本
   *
   * @param original 原始目标描述
   * @param answers 用户回答（key=维度名，value=回答）
   */
  static enrichGoal(original: string, answers: Record<string, string>): string {
    const entries = Object.entries(answers).filter(([, v]) => v && v.trim().length > 0);
    if (entries.length === 0) {
      return original;
    }

    const supplement = entries
      .map(([dim, ans]) => `[${dim}] ${ans.trim()}`)
      .join('；');

    return `${original}（补充：${supplement}）`;
  }

  /**
   * 序列化为 Markdown
   */
  static serialize(spec: FivePartGoalSpec): string {
    const lines: string[] = [
      '# Goal Spec',
      '',
      `## Goal`,
      spec.goal,
      '',
      `## Scope`,
      spec.scope,
      '',
      `## Constraints`,
      ...spec.constraints.map((c) => `- ${c}`),
      '',
      `## DoneWhen`,
      ...spec.doneWhen.map((c) => `- ${c}`),
      '',
      `## StopIf`,
      ...spec.stopIf.map((c) => `- ${c}`),
      '',
      `## TokenBudget`,
      String(spec.tokenBudget),
      '',
    ];
    return lines.join('\n');
  }

  /**
   * 从 Markdown 解析
   */
  static parse(markdown: string): FivePartGoalSpec {
    const getSection = (name: string): string => {
      const regex = new RegExp(`## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
      const m = markdown.match(regex);
      return m ? m[1].trim() : '';
    };

    const getList = (name: string): string[] => {
      const raw = getSection(name);
      if (!raw) return [];
      return raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
        .filter((l) => l.length > 0);
    };

    const tokenBudgetRaw = getSection('TokenBudget');
    const tokenBudget = parseInt(tokenBudgetRaw, 10);
    const safeBudget = isNaN(tokenBudget) ? DEFAULT_TOKEN_BUDGET : tokenBudget;

    return {
      goal: getSection('Goal'),
      scope: getSection('Scope'),
      constraints: getList('Constraints'),
      doneWhen: getList('DoneWhen'),
      stopIf: getList('StopIf'),
      tokenBudget: safeBudget,
    };
  }

  // ============================================================
  // 内部辅助：规则模板提取
  // ============================================================

  /** 从输入中提取约束 */
  private static extractConstraints(
    userInput: string,
    clarifications?: Record<string, string>,
  ): string[] {
    const constraints: string[] = [];

    // 从澄清回答中提取"必要决策"维度
    if (clarifications?.['必要决策']) {
      constraints.push(clarifications['必要决策']);
    }
    // 从原文提取技术栈关键词
    const techStack = ['TypeScript', 'React', 'Electron', 'Node.js', 'pnpm'];
    for (const tech of techStack) {
      if (userInput.includes(tech)) {
        constraints.push(`基于 ${tech}`);
      }
    }
    // 默认约束
    if (constraints.length === 0) {
      constraints.push('不破坏现有测试');
    }
    return constraints;
  }

  /** 从输入中提取完成标准 */
  private static extractDoneWhen(
    userInput: string,
    clarifications?: Record<string, string>,
  ): string[] {
    const doneWhen: string[] = [];

    // 从澄清回答中提取"完成标准"维度
    if (clarifications?.['完成标准']) {
      doneWhen.push(clarifications['完成标准']);
    }
    // 从原文提取验证关键词
    if (userInput.includes('测试') || userInput.includes('test')) {
      doneWhen.push('所有测试通过');
    }
    if (userInput.includes('类型') || userInput.includes('type')) {
      doneWhen.push('类型检查无误');
    }
    // 默认完成标准
    if (doneWhen.length === 0) {
      doneWhen.push('类型检查通过');
      doneWhen.push('现有测试不回归');
    }
    return doneWhen;
  }

  /** 从输入中提取停止条件 */
  private static extractStopIf(userInput: string): string[] {
    const stopIf: string[] = [
      'Token 预算用尽（软停止线 90%）',
      '连续 3 次相同错误',
    ];
    if (userInput.includes('删除') || userInput.includes('rm ')) {
      stopIf.push('涉及删除操作时人工确认');
    }
    return stopIf;
  }

  /** 从输入中提取范围 */
  private static extractScope(
    userInput: string,
    clarifications?: Record<string, string>,
  ): string {
    if (clarifications?.['范围边界']) {
      return clarifications['范围边界'];
    }
    // 从原文提取文件路径线索
    const fileMatch = userInput.match(/[\w-]+\/[\w./-]+\.(?:ts|tsx|js|jsx)/);
    if (fileMatch) {
      return `主要修改 ${fileMatch[0]} 相关文件`;
    }
    return '范围待澄清（未在输入中识别到明确文件路径）';
  }
}
