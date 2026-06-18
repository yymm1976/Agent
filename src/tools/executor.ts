// src/tools/executor.ts
// 工具执行器：权限检查 → 安全检查 → 执行 → 记录日志
// 实现 IToolExecutor 接口

import type {
  ITool,
  IToolExecutor,
  IToolRegistry,
  IPermissionChecker,
  ISecurityChecker,
  ToolResult,
  ToolExecutionContext,
} from './types.js';
import { logger } from '../utils/logger.js';

export class ToolExecutor implements IToolExecutor {
  private registry: IToolRegistry;
  private permissionChecker?: IPermissionChecker;
  private securityChecker?: ISecurityChecker;

  constructor(registry: IToolRegistry) {
    this.registry = registry;
  }

  setPermissionChecker(checker: IPermissionChecker): void {
    this.permissionChecker = checker;
  }

  setSecurityChecker(checker: ISecurityChecker): void {
    this.securityChecker = checker;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // 1. 查找工具
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `工具 "${toolName}" 未注册`,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. 参数验证
    const validation = tool.validateArgs(args);
    if (!validation.valid) {
      return {
        success: false,
        output: '',
        error: `参数验证失败: ${validation.errors.join(', ')}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. 权限检查
    if (this.permissionChecker) {
      const level = this.permissionChecker.checkPermission(toolName, args);
      if (level === 'deny') {
        logger.warn('Tool execution denied by permission', { toolName });
        return {
          success: false,
          output: '',
          error: '权限被拒绝: 工具被规则禁止',
          durationMs: Date.now() - startTime,
        };
      }
      if (level === 'confirm') {
        // Phase 6-7 MVP：confirm 级别自动放行并记录
        logger.debug('Tool auto-approved (confirm level)', { toolName });
      }
    }

    // 4. 安全检查（对文件操作类工具检查路径）
    if (this.securityChecker && this.isFileOperation(toolName, args)) {
      const filePath = (args.path as string) ?? (args.filePath as string);
      if (filePath) {
        const secResult = this.securityChecker.checkFilePath(filePath, context);
        if (!secResult.allowed) {
          logger.warn('Tool execution denied by security', {
            toolName,
            filePath,
            reason: secResult.reason,
          });
          return {
            success: false,
            output: '',
            error: `安全检查失败: ${secResult.reason}`,
            durationMs: Date.now() - startTime,
          };
        }
      }
    }

    // 5. 执行工具
    try {
      logger.debug('Executing tool', { toolName, args });
      const result = await tool.execute(args, context);
      const duration = Date.now() - startTime;

      logger.debug('Tool executed', {
        toolName,
        success: result.success,
        durationMs: duration,
      });

      return { ...result, durationMs: duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      logger.error('Tool execution error', { toolName, error: errorMsg });

      return {
        success: false,
        output: '',
        error: `工具执行异常: ${errorMsg}`,
        durationMs: duration,
      };
    }
  }

  /** 判断是否为文件操作类工具 */
  private isFileOperation(toolName: string, args: Record<string, unknown>): boolean {
    return toolName.startsWith('file_') && ('path' in args || 'filePath' in args);
  }
}
