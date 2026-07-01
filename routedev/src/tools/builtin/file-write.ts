// src/tools/builtin/file-write.ts
// 写入或创建文件
// 权限：confirm（需确认，但 Phase 6 暂自动放行）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkPathBoundary } from './search-utils.js';
// Phase 53 Task 7：配置保护守卫（阻止弱化安全/治理配置）
import { ConfigGuard } from './config-guard.js';

export class FileWriteTool implements ITool {
  // Phase 53 Task 7：配置保护守卫（可选，未注入时跳过检查）
  private configGuard?: ConfigGuard;

  /** Phase 53 Task 7：注入配置保护守卫 */
  setConfigGuard(guard: ConfigGuard): void {
    this.configGuard = guard;
  }

  readonly definition: ToolDefinition = {
    name: 'file_write',
    description: '当用户需要创建新文件或覆盖写入文件内容时，使用此工具。支持追加模式，写入前会校验路径安全性。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        content: {
          type: 'string',
          description: '要写入的内容',
        },
        append: {
          type: 'boolean',
          description: '是否追加模式（默认 false，覆盖写入）',
        },
      },
      required: ['path', 'content'],
    },
    requiresApproval: true,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }
    if (args.content === undefined || typeof args.content !== 'string') {
      errors.push('缺少必需参数: content');
    }
    if (args.append !== undefined && typeof args.append !== 'boolean') {
      errors.push('append 必须是布尔值');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);
    const content = args.content as string;
    const append = (args.append as boolean) ?? false;

    // C1 修复：内部路径边界校验（防御性深度防御）
    const boundaryError = checkPathBoundary(filePath, context);
    if (boundaryError) {
      return {
        success: false,
        output: '',
        error: boundaryError,
        durationMs: 0,
      };
    }

    // Phase 53 Task 7：配置保护守卫（受 guard 注入控制，检查写入内容是否弱化安全/治理配置）
    if (this.configGuard) {
      const guardResult = this.configGuard.checkModification(filePath, content);
      if (!guardResult.allowed) {
        return {
          success: false,
          output: '',
          error: guardResult.reason ?? '配置保护守卫阻止了此操作',
          durationMs: 0,
        };
      }
    }

    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      if (append) {
        await fs.appendFile(filePath, content, 'utf-8');
      } else {
        await fs.writeFile(filePath, content, 'utf-8');
      }

      const stats = await fs.stat(filePath);
      const lines = content.split('\n').length;

      return {
        success: true,
        output: `文件${append ? '追加' : '写入'}成功: ${args.path} (${lines} 行, ${stats.size} 字节)`,
        durationMs: 0,
        metadata: { filePath, lines, bytes: stats.size, append },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `写入文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
