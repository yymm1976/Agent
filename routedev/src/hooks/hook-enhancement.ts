// src/hooks/hook-enhancement.ts
// Phase 40 Task 9：Hook 增强（安全审查子集）
//
// 当前保留：
//   - 安全审查增强：检测危险命令、base64 编码、管道链（analyzeCommand 等静态方法）
//
// 已删除的死代码：
//   - 试用模式（startTrial/checkTrialStatus/promoteToEnabled/disableForAnomaly/recordTrigger/shouldExecuteBlock）
//   - Hook Group（createGroup/executeGroup/detectCircularDependency）
//   - 函数型 Hook 注册（registerFunctionHook/executeFunctionHook）
//   原因：上述 API 在全代码库零外部调用，仅安全审查方法被 app-init.ts 消费。
//
// /goal 生命周期新事件：
//   post-plan / pre-step-execution / post-step-execution
//   pre-adopt / on-goal-complete / on-goal-failed / on-goal-paused

import { logger } from '../utils/logger.js';

// ============================================================
// 函数型 Hook 接口
// ============================================================

/** Hook 执行上下文（受限 API） */
interface HookContext {
  event: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  filePath?: string;
  goalId?: string;
  stepId?: string;
  /** 受限 API：解析 AST */
  parseAst?: (filePath: string) => Promise<unknown>;
  /** 受限 API：读文件 */
  readFile?: (filePath: string) => Promise<string>;
  /** 受限 API：读状态 */
  getState?: (key: string) => unknown;
}

/** Hook 执行结果 */
interface HookResult {
  action: 'continue' | 'block' | 'warn' | 'abort';
  message?: string;
  data?: Record<string, unknown>;
}

/** 函数型 Hook 签名 */
type FunctionHook = (ctx: HookContext) => Promise<HookResult>;

// ============================================================
// 安全审查：危险命令关键词
// ============================================================

/** 危险命令模式 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; risk: string }> = [
  { pattern: /\brm\s+-rf?\s+[/~]/i, risk: '递归删除根目录或家目录' },
  { pattern: /\brm\s+-rf?\b/i, risk: '递归删除文件' },
  { pattern: /git\s+push\s+(--force|-f)\b/i, risk: '强制推送覆盖远程历史' },
  { pattern: /git\s+reset\s+--hard\b/i, risk: '硬重置丢弃工作区改动' },
  { pattern: /\bchmod\s+777\b/i, risk: '设置全权限' },
  { pattern: /\bcurl\b.*\|\s*sh/i, risk: '下载并执行脚本' },
  { pattern: /\bwget\b.*\|\s*sh/i, risk: '下载并执行脚本' },
  { pattern: /\bdd\s+if=/i, risk: '磁盘级写入' },
  { pattern: /\bmkfs\b/i, risk: '格式化文件系统' },
  { pattern: /:\(\)\s*\{.+:|:&\s*\}\s*;/i, risk: 'fork 炸弹' },
  { pattern: /\bshutdown\b/i, risk: '关机命令' },
  { pattern: /\breboot\b/i, risk: '重启命令' },
];

// ============================================================
// HookEnhancementManager（仅保留静态安全审查方法）
// ============================================================

export class HookEnhancementManager {
  // ============================================================
  // 安全审查增强
  // ============================================================

  /**
   * 分析命令安全性
   *
   * @returns safe=true 表示无危险，risks 列出命中的危险模式
   */
  static analyzeCommand(command: string): { safe: boolean; risks: string[] } {
    const risks: string[] = [];
    for (const { pattern, risk } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        risks.push(risk);
      }
    }
    // 额外检测 base64 编码命令
    if (HookEnhancementManager.detectBase64Command(command)) {
      risks.push('检测到 base64 编码命令（可能隐藏真实意图）');
    }
    // 检测管道链（可能用于命令注入）
    if (HookEnhancementManager.detectPipeChain(command)) {
      // 管道链本身不一定是危险，但若同时含 base64 则已在上面标记
      // 此处仅在管道链超过 3 段时标记为可疑
      const pipeCount = (command.match(/\|/g) ?? []).length;
      if (pipeCount >= 3) {
        risks.push(`管道链过长（${pipeCount} 段），可能存在命令注入风险`);
      }
    }
    return { safe: risks.length === 0, risks };
  }

  /**
   * 检测 base64 编码命令
   *
   * 启发式：
   *   - 含 `base64 -d` 或 `base64 --decode`
   *   - 含 `echo <长base64串> | ... sh`
   *   - 含 `eval(atob(...))`
   */
  static detectBase64Command(command: string): boolean {
    // 显式 base64 解码
    if (/base64\s+(?:-d|--decode)/i.test(command)) return true;
    // echo <base64> | sh 模式
    if (/echo\s+[A-Za-z0-9+/=]{20,}\s*\|/i.test(command)) return true;
    // eval(atob(...))
    if (/eval\s*\(\s*atob\s*\(/i.test(command)) return true;
    // base64 -D (macOS)
    if (/base64\s+-D\b/i.test(command)) return true;
    return false;
  }

  /**
   * 检测管道链
   */
  static detectPipeChain(command: string): boolean {
    // 统计管道符数量（排除 || 逻辑或）
    const pipeMatches = command.match(/(?<!\|)\|(?!\|)/g);
    return pipeMatches !== null && pipeMatches.length >= 1;
  }
}
