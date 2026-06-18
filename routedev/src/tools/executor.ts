// src/tools/executor.ts
// 工具执行器：安全检查 → 执行 → 记录日志
// 实现 IToolExecutor 接口
//
// Phase 0c 修复：权限检查已迁移到 PermissionEngine（通过 AgentMiddlewarePipeline.onActing 中间件）
// 本类不再做权限检查，仅保留安全检查（路径/命令黑名单等）

import type {
  ITool,
  IToolExecutor,
  IToolRegistry,
  ISecurityChecker,
  ToolResult,
  ToolResponse,
  ToolExecutionContext,
} from './types.js';
import { logger } from '../utils/logger.js';

export class ToolExecutor implements IToolExecutor {
  private registry: IToolRegistry;
  private securityChecker?: ISecurityChecker;

  constructor(registry: IToolRegistry) {
    this.registry = registry;
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

    // 3. 安全检查（对文件操作类工具检查路径）
    // 注：权限检查已迁移到 PermissionEngine 中间件，本类不再处理
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

    // 4. 执行工具
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

  /**
   * 安全执行工具（永不抛出异常，失败通过 isError 标记）
   * 包装 execute 方法，将 ToolResult 转换为 ToolResponse
   */
  async executeSafe(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResponse> {
    try {
      const result = await this.execute(toolName, args, context);
      if (result.success) {
        return {
          content: result.output,
          isError: false,
          metadata: result.metadata,
        };
      }
      // execute 内部已捕获异常并以 success:false 返回
      const message = result.error || result.output || `工具 ${toolName} 执行失败`;
      logger.error(`Tool ${toolName} failed: ${message}`);
      return {
        content: `[工具执行失败: ${toolName}] ${message}`,
        isError: true,
        metadata: result.metadata,
      };
    } catch (error) {
      // 防御性兜底：execute 本身理论上不会抛出，但仍捕获以防未知异常
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Tool ${toolName} threw unexpectedly: ${message}`);
      return {
        content: `[工具执行失败: ${toolName}] ${message}`,
        isError: true,
      };
    }
  }
}
