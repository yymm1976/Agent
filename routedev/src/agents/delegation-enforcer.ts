// src/agents/delegation-enforcer.ts
// 越权行为拦截：工具白名单 + 写文件边界 + 步数/Token 预算
// Task 3：在子 Agent 工具调用前后强制执行契约

import type { DelegationContract } from './delegation-contract.js';

interface EnforcementResult {
  allowed: boolean;
  reason?: string;
}

/** 写操作工具集合 */
const WRITE_TOOLS = new Set(['file_write', 'file_edit', 'delete_file']);

/** 常见文件路径参数名 */
const PATH_ARG_KEYS = ['path', 'filePath', 'file_path', 'file'];

export class DelegationEnforcer {
  private contract: DelegationContract;
  private stepCount: number = 0;
  private tokenUsed: number = 0;

  constructor(contract: DelegationContract) {
    this.contract = contract;
  }

  /** 工具调用前检查 */
  beforeToolCall(toolName: string, args: Record<string, unknown>): EnforcementResult {
    // 1. 检查 forbiddenTools（优先，明确禁止的立即拒绝）
    const forbidden = this.contract.grant.forbiddenTools;
    if (forbidden && forbidden.includes(toolName)) {
      return { allowed: false, reason: `工具 ${toolName} 被明确禁止` };
    }
    // 2. 检查工具是否在 allowedTools 中
    if (!this.contract.grant.allowedTools.includes(toolName)) {
      return { allowed: false, reason: `工具 ${toolName} 不在允许列表中` };
    }
    // 3. 写操作：检查目标文件是否在 writeFiles 中
    if (DelegationEnforcer.isWriteOperation(toolName)) {
      const writeFiles = this.contract.grant.writeFiles ?? [];
      if (writeFiles.length === 0) {
        return { allowed: false, reason: '契约未授权任何可写文件' };
      }
      const targetPath = this.extractPath(args);
      if (!targetPath) {
        return { allowed: false, reason: `写操作 ${toolName} 缺少文件路径参数` };
      }
      if (!this.isPathAllowed(targetPath, writeFiles)) {
        return { allowed: false, reason: `文件 ${targetPath} 不在可写文件列表中` };
      }
    }
    return { allowed: true };
  }

  /** 步骤计数 */
  incrementStep(): EnforcementResult {
    this.stepCount++;
    if (this.stepCount > this.contract.grant.maxSteps) {
      return { allowed: false, reason: `已超过最大步数 ${this.contract.grant.maxSteps}` };
    }
    return { allowed: true };
  }

  /** Token 计数 */
  addTokens(count: number): EnforcementResult {
    this.tokenUsed += count;
    if (this.tokenUsed > this.contract.grant.maxTokens) {
      return { allowed: false, reason: `已超过 Token 预算 ${this.contract.grant.maxTokens}` };
    }
    if (this.tokenUsed > this.contract.grant.maxTokens * 0.9) {
      return { allowed: true, reason: `⚠️ Token 预算即将耗尽 (${this.tokenUsed}/${this.contract.grant.maxTokens})` };
    }
    return { allowed: true };
  }

  getStepCount(): number {
    return this.stepCount;
  }

  getTokenUsed(): number {
    return this.tokenUsed;
  }

  /** 判断是否是写操作 */
  static isWriteOperation(toolName: string): boolean {
    return WRITE_TOOLS.has(toolName);
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  private extractPath(args: Record<string, unknown>): string | null {
    for (const key of PATH_ARG_KEYS) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  private isPathAllowed(targetPath: string, writeFiles: string[]): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const t = norm(targetPath);
    for (const f of writeFiles) {
      if (norm(f) === t) return true;
    }
    return false;
  }
}
