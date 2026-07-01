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

    try {
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

      // 3. 安全检查
      // 注：权限检查已迁移到 PermissionEngine 中间件，本类不再处理
      // P1-1 修复：list_directory 也需要路径校验（防止路径逃逸）
      // P0-1 修复：web_fetch 需要网络校验（SSRF 防护）
      // C3 修复：透传 requiresConfirmation，未配置回调时安全默认拒绝
      if (this.securityChecker) {
      // 文件操作类工具：检查路径
      if (this.isFileOperation(toolName, args)) {
        const filePath = (args.path as string) ?? (args.filePath as string);
        if (filePath) {
          // 判断是否为写入操作：file_write/file_edit 为写入，其余为读取
          // 影响 Permission Profile 的 read/write 规则判定
          const isWrite = toolName === 'file_write' || toolName === 'file_edit';
          const secResult = this.securityChecker.checkFilePath(filePath, context, isWrite);
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
          // C3 修复：敏感文件 requiresConfirmation 透传
          if (secResult.requiresConfirmation) {
            const confirmed = await this.requestConfirmation(context, secResult.reason ?? '敏感文件操作需确认');
            if (!confirmed) {
              return {
                success: false,
                output: '',
                error: `用户拒绝确认: ${secResult.reason ?? '敏感文件操作'}`,
                durationMs: Date.now() - startTime,
              };
            }
          }
        }
      }

      // 网络操作类工具：检查 URL（SSRF 防护）
      if (this.isNetworkOperation(toolName, args)) {
        const url = args.url as string;
        if (url) {
          // C2 修复：await checkNetworkRequest，确保安全检查实际执行
          const secResult = await this.securityChecker.checkNetworkRequest(url);
          if (!secResult.allowed) {
            logger.warn('Tool execution denied by security (SSRF)', {
              toolName,
              url,
              reason: secResult.reason,
            });
            return {
              success: false,
              output: '',
              error: `安全检查失败: ${secResult.reason}`,
              durationMs: Date.now() - startTime,
            };
          }
          // C3 修复：网络请求 requiresConfirmation 透传
          if (secResult.requiresConfirmation) {
            const confirmed = await this.requestConfirmation(context, secResult.reason ?? '网络请求需确认');
            if (!confirmed) {
              return {
                success: false,
                output: '',
                error: `用户拒绝确认: ${secResult.reason ?? '网络请求'}`,
                durationMs: Date.now() - startTime,
              };
            }
          }
        }
      }

      // Shell 命令类工具：检查命令安全性（7层Bash安全）
      if (toolName === 'shell_exec' && args.command) {
        const secResult = this.securityChecker.checkCommand(args.command as string, context);
        if (!secResult.allowed) {
          logger.warn('Tool execution denied by security (Bash)', {
            toolName,
            reason: secResult.reason,
          });
          return {
            success: false,
            output: '',
            error: `安全检查失败: ${secResult.reason}`,
            durationMs: Date.now() - startTime,
          };
        }
        // C3 修复：含管道/命令替换的命令 requiresConfirmation 透传
        if (secResult.requiresConfirmation) {
          const confirmed = await this.requestConfirmation(context, secResult.reason ?? 'Shell 命令需确认');
          if (!confirmed) {
            return {
              success: false,
              output: '',
              error: `用户拒绝确认: ${secResult.reason ?? 'Shell 命令'}`,
              durationMs: Date.now() - startTime,
            };
          }
        }
      }
      }

      // 4. 执行工具
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

  /** 判断是否为文件操作类工具（P1-1：增加 list_directory） */
  private isFileOperation(toolName: string, args: Record<string, unknown>): boolean {
    // file_* 工具 + list_directory 都需要路径校验
    return (toolName.startsWith('file_') || toolName === 'list_directory')
      && ('path' in args || 'filePath' in args);
  }

  /** 判断是否为网络操作类工具（P0-1：SSRF 防护） */
  private isNetworkOperation(toolName: string, args: Record<string, unknown>): boolean {
    return (toolName === 'web_fetch' || toolName === 'web_search') && 'url' in args;
  }

  /**
   * C3 修复：请求用户确认
   * 若 context.requestConfirmation 未提供，安全默认返回 false（拒绝执行）
   */
  private async requestConfirmation(
    context: ToolExecutionContext,
    reason: string,
  ): Promise<boolean> {
    if (!context.requestConfirmation) {
      // 未配置确认回调：安全默认拒绝
      logger.warn('Tool requires confirmation but no callback configured, denying', { reason });
      return false;
    }
    try {
      return await context.requestConfirmation(reason);
    } catch (e) {
      logger.error('Confirmation callback threw, denying', { reason, error: String(e) });
      return false;
    }
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
