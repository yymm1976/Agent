// src/tools/permission.ts
// 权限检查器
// Phase 9：支持自主度模式（auto/semi/manual）与 autoApprovePatterns
//   - auto 模式：confirm 级别自动放行
//   - semi/manual 模式：confirm 级别返回 'confirm'（需外部回调确认）
//   - autoApprovePatterns 中的工具在任何模式下都返回 'auto'
//   - deny 规则在所有模式下都返回 'deny'

import type { IPermissionChecker, PermissionLevel, PermissionRule } from './types.js';
import type { AutonomyMode } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export class PermissionChecker implements IPermissionChecker {
  private rules: PermissionRule[] = [];
  private mode: AutonomyMode;
  private autoApprovePatterns: string[];

  constructor(mode: AutonomyMode = 'semi', autoApprovePatterns: string[] = []) {
    this.mode = mode;
    this.autoApprovePatterns = autoApprovePatterns;
  }

  /** 设置当前自主度模式（运行时切换） */
  setAutonomyMode(mode: AutonomyMode): void {
    logger.debug('Autonomy mode changed', { from: this.mode, to: mode });
    this.mode = mode;
  }

  /** 设置自动批准 pattern */
  setAutoApprovePatterns(patterns: string[]): void {
    this.autoApprovePatterns = patterns;
  }

  /** 获取当前模式 */
  getMode(): AutonomyMode {
    return this.mode;
  }

  checkPermission(toolName: string, _args: Record<string, unknown>): PermissionLevel {
    // 1. autoApprovePatterns 优先
    if (this.matchesAnyPattern(toolName, this.autoApprovePatterns)) {
      return 'auto';
    }

    // 2. 计算规则命中的级别
    const level = this.getRuleLevel(toolName);

    if (level === 'deny') {
      logger.warn('Tool execution denied by permission rule', { toolName });
      return 'deny';
    }

    if (level === 'auto') {
      return 'auto';
    }

    // 3. confirm 级别 → 按自主度模式决定
    if (level === 'confirm') {
      if (this.mode === 'auto') {
        logger.debug('Tool auto-approved (auto mode)', { toolName });
        return 'auto';
      }
      // semi / manual → 返回 confirm 等待外部确认
      return 'confirm';
    }

    return 'auto';
  }

  addRule(rule: PermissionRule): void {
    this.rules = this.rules.filter(r => r.toolPattern !== rule.toolPattern);
    this.rules.push(rule);
    logger.debug('Permission rule added', {
      pattern: rule.toolPattern,
      level: rule.level,
    });
  }

  removeRule(toolPattern: string): void {
    this.rules = this.rules.filter(r => r.toolPattern !== toolPattern);
  }

  listRules(): PermissionRule[] {
    return [...this.rules];
  }

  private getRuleLevel(toolName: string): PermissionLevel {
    for (const rule of this.rules) {
      if (this.matchPattern(toolName, rule.toolPattern)) {
        return rule.level;
      }
    }
    return 'auto';
  }

  private matchesAnyPattern(toolName: string, patterns: string[]): boolean {
    return patterns.some(p => this.matchPattern(toolName, p));
  }

  private matchPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(toolName);
  }
}
