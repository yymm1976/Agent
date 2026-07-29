// src/tools/builtin/file-write.ts
// 写入或创建文件
// 权限：confirm（需确认，但 Phase 6 暂自动放行）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkPathBoundary } from './search-utils.js';
// F-005 修复：引入 resolveSecurePath 解析 symlink 真实路径
import { resolveSecurePath } from '../security-enhanced.js';
// Phase 53 Task 7：配置保护守卫（阻止弱化安全/治理配置）
import { ConfigGuard } from './config-guard.js';
// Phase 96 P1-3：BOM 检测与保留，覆盖写入时保留原文件 BOM 状态
import { readWithBomInfo, writeWithBomInfo, stripBom } from './bom-utils.js';

// V3-022 修复：写入内容大小上限（10MB），防止超大文件写入导致资源耗尽
const MAX_WRITE_SIZE = 10 * 1024 * 1024;

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

    // V3-022 修复：写入内容大小校验（在路径校验前快速失败）
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf-8') > MAX_WRITE_SIZE) {
      return {
        success: false,
        output: '',
        error: `写入内容过大 (max ${MAX_WRITE_SIZE} bytes)`,
        durationMs: 0,
      };
    }

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

    // F-005 修复：Symlink 真实路径解析，防止通过符号链接逃逸目录边界
    // checkPathBoundary 仅做字符串比较，resolveSecurePath 用 realpathSync 解析中间目录 symlink
    const allowedDirs = context.allowedDirectories ?? [context.workingDirectory];
    const secureResult = resolveSecurePath(filePath, allowedDirs);
    if (!secureResult.allowed) {
      return {
        success: false,
        output: '',
        error: secureResult.reason ?? '路径校验失败',
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
        // 追加模式：不主动处理 BOM（追加到已有文件末尾，BOM 状态由原文件决定）
        // 但需剥离开头可能的 BOM 字符（用户传入的 content 若以 BOM 开头会污染中段）
        const cleanContent = stripBom(content);
        await fs.appendFile(filePath, cleanContent, 'utf-8');
      } else {
        // 覆盖模式：保留原文件 BOM 状态（若原文件存在且带 BOM，写回时也带 BOM）
        // Phase 96 P1-3 修复：之前 fs.writeFile(path, content, 'utf-8') 永远不写 BOM，
        // 导致带 BOM 的文件被覆盖后 BOM 静默丢失
        let hadBom = false;
        try {
          const existing = await readWithBomInfo(filePath);
          hadBom = existing.hadBom;
        } catch {
          // 文件不存在（新建场景）—— 不主动加 BOM（保持 UTF-8 无 BOM 现代惯例）
        }
        // 若用户传入 content 以 BOM 开头，视为用户显式要求带 BOM
        const userExplicitBom = content.length > 0 && content.charCodeAt(0) === 0xfeff;
        const shouldWriteBom = hadBom || userExplicitBom;
        const cleanContent = stripBom(content);
        await writeWithBomInfo(filePath, cleanContent, shouldWriteBom);
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
