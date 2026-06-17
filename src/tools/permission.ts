// src/tools/permission.ts
// 权限检查器
// MVP 阶段：semi 模式下 confirm → 自动放行并记录日志
// Phase 9（自主模式）：confirm → 弹出交互式确认对话框

import type { IPermissionChecker, PermissionLevel, PermissionRule } from './types.js';
import { logger } from '../utils/logger.js';

export class PermissionChecker implements IPermissionChecker {
  private rules: PermissionRule[] = [];
  /** MVP 模式：confirm 级别是否自动放行 */
  private autoApproveConfirm: boolean;

  constructor(autoApproveConfirm: boolean = true) {
    this.autoApproveConfirm = autoApproveConfirm;
  }

  checkPermission(toolName: string, _args: Record<string, unknown>): PermissionLevel {
    const level = this.getPermissionLevel(toolName);

    switch (level) {
      case 'auto':
        return 'auto';

      case 'deny':
        logger.warn('Tool execution denied by permission rule', { toolName });
        return 'deny';

      case 'confirm':
        if (this.autoApproveConfirm) {
          logger.debug('Tool auto-approved (confirm → auto)', { toolName });
          return 'auto'; // MVP 自动放行
        }
        return 'confirm';
    }
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

  private getPermissionLevel(toolName: string): PermissionLevel {
    for (const rule of this.rules) {
      if (this.matchPattern(toolName, rule.toolPattern)) {
        return rule.level;
      }
    }
    return 'auto';
  }

  private matchPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(toolName);
  }
}
