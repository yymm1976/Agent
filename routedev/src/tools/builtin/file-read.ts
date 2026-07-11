// src/tools/builtin/file-read.ts
// 读取文件内容
// 权限：auto（自动执行，无需确认）
// P1-9：增加文件大小限制，防止大文件撑爆上下文
//
// P0-1 改造（2026-07-05）：从 class FileReadTool implements ITool 迁移到 buildTool 工厂模式
//   - 使用 ToolDef 配置对象替代类继承
//   - 使用 validate（辨识联合 ValidationResult）替代 validateArgs，支持 errorCode
//   - 保留 ITool 兼容性（buildTool 内部适配为 validateArgs）
//   - 导出 fileReadTool 实例 + FileReadTool 兼容包装（向后兼容 app-init.ts 的 new FileReadTool()）

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTool, type ITool, type ToolDefinition, type ToolResult, type ToolExecutionContext, type ValidationResult } from '../types.js';
import { checkPathBoundary } from './search-utils.js';
// F-034：引入 resolveSecurePath 解析 symlink 真实路径（与 file-write.ts 一致）
import { resolveSecurePath } from '../security-enhanced.js';

/** 最大读取字节数（1MB），超过则拒绝读取 */
const MAX_READ_BYTES = 1024 * 1024;

/**
 * P0-1：使用 buildTool 工厂创建 file_read 工具
 *
 * 与原 class FileReadTool 等价，但采用配置对象形式：
 *   - validate 返回辨识联合，errorCode=2 表示参数值非法
 *   - execute 逻辑保持不变
 */
export const fileReadTool = buildTool({
  name: 'file_read',
  description: '当用户需要查看某个文件的内容、理解现有代码实现、或在修改前确认当前代码时，使用此工具。支持指定行号范围与文件大小限制（1MB），超过限制请用 startLine/endLine 分段读取。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于项目根目录）',
      },
      startLine: {
        type: 'number',
        description: '起始行号（可选，从 1 开始）',
      },
      endLine: {
        type: 'number',
        description: '结束行号（可选，包含该行）',
      },
    },
    required: ['path'],
  },
  requiresApproval: false,
  category: 'file',

  // P0-2：辨识联合校验，errorCode 用于归因
  validate(args: Record<string, unknown>): ValidationResult {
    if (!args.path || typeof args.path !== 'string') {
      return { result: false, message: '缺少必需参数: path', errorCode: 1 };
    }
    if (args.startLine !== undefined && typeof args.startLine !== 'number') {
      return { result: false, message: 'startLine 必须是数字', errorCode: 1 };
    }
    if (args.endLine !== undefined && typeof args.endLine !== 'number') {
      return { result: false, message: 'endLine 必须是数字', errorCode: 1 };
    }
    return { result: true };
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);
    const startLine = (args.startLine as number) ?? 1;
    const endLine = args.endLine as number | undefined;

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

    // F-034：Symlink 真实路径解析，防止通过符号链接逃逸目录边界
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
    const realPath = secureResult.realPath;

    try {
      // P1-9：读取前检查文件大小，防止大文件撑爆上下文
      const stats = await fs.stat(realPath);
      if (stats.size > MAX_READ_BYTES) {
        return {
          success: false,
          output: '',
          error: `文件过大: ${stats.size} 字节（上限 ${MAX_READ_BYTES} 字节）。请使用 startLine/endLine 参数分段读取。`,
          durationMs: 0,
          metadata: { fileSize: stats.size, maxBytes: MAX_READ_BYTES },
        };
      }

      const content = await fs.readFile(realPath, 'utf-8');

      // 如果有行号范围，截取指定行
      if (startLine > 1 || endLine) {
        const lines = content.split('\n');
        const start = Math.max(0, startLine - 1);
        const end = endLine ? Math.min(lines.length, endLine) : lines.length;
        const sliced = lines.slice(start, end);

        const numbered = sliced.map((line, i) =>
          `${String(start + i + 1).padStart(4)} | ${line}`,
        ).join('\n');

        // Phase 72 Task C2：附加 mtimeMs / sizeBytes 作为乐观锁基线
        // file_edit 可在入参中传 expectedMtimeMs / expectedSizeBytes 进行乐观锁校验
        return {
          success: true,
          output: numbered,
          durationMs: 0,
          metadata: {
            totalLines: lines.length,
            shownLines: sliced.length,
            mtimeMs: stats.mtimeMs,
            sizeBytes: stats.size,
          },
        };
      }

      const lines = content.split('\n');
      const numbered = lines.map((line, i) =>
        `${String(i + 1).padStart(4)} | ${line}`,
      ).join('\n');

      // Phase 72 Task C2：附加 mtimeMs / sizeBytes 作为乐观锁基线
      return {
        success: true,
        output: numbered,
        durationMs: 0,
        metadata: {
          totalLines: lines.length,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `读取文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  },
});

// ============================================================
// 向后兼容包装：保留 FileReadTool 类导出，供 app-init.ts `new FileReadTool()` 使用
// ============================================================

/**
 * 兼容包装类：内部委托给 fileReadTool 实例
 *
 * 优先使用 `fileReadTool` 导出；此类的存在仅为不破坏现有 `new FileReadTool()` 调用。
 * 后续全面迁移到 buildTool 后可移除。
 */
export class FileReadTool implements ITool {
  readonly definition: ToolDefinition = fileReadTool.definition;
  validateArgs = fileReadTool.validateArgs.bind(fileReadTool);
  execute = fileReadTool.execute.bind(fileReadTool);
  // 透传可选的 backfillObservableInput（file_read 未实现，此处为 undefined）
  backfillObservableInput = fileReadTool.backfillObservableInput?.bind(fileReadTool);
}
