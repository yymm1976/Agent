// src/tools/builtin/file-edit.ts
// 文件编辑工具：精确字符串替换，避免全量重写
// P1-4：Codex/Claude Code 都有 str_replace/edit_file 工具，RouteDev 缺失
//
// 支持两种 action 模式：
//   1. replace（默认）：str_replace 精确替换文件中的字符串片段（oldString → newString）
//      - 子模式 a：oldString + newString 单条替换
//      - 子模式 b：edits 数组批量替换
//   2. edit_lines：按行号范围替换（startLine ~ endLine 闭区间 → newContent）
//      - 1-based 行号，endLine 超过总行数时自动截断到最后一行
//      - 对齐 Aider 的 line-range 编辑体验
//
// 安全特性：
//   - replace 模式：oldString 必须在文件中唯一匹配，否则拒绝（防止误改多处）
//   - 文件不存在时返回错误（不自动创建，创建用 file_write）
//   - 替换前备份原内容到 EditHistory 单例（/undo 可恢复，进程内存级不持久化）
//   - 可选确认流程：requireConfirmation=true 且 context.requestConfirmation 存在时，
//     先返回 diff 预览请求用户确认，用户拒绝则不写入（向后兼容：无回调直接应用）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkPathBoundary } from './search-utils.js';
// Phase 53 Task 7：配置保护守卫（阻止弱化安全/治理配置）
import { ConfigGuard } from './config-guard.js';
// 编辑历史单例：file-edit 写入前 push 原内容，/undo 命令弹栈恢复
import { editHistory } from './edit-history.js';

/** 单条替换编辑 */
interface EditEntry {
  oldString: string;
  newString: string;
}

/** 编辑动作模式 */
type EditAction = 'replace' | 'edit_lines';

/** P2-1：最大编辑文件大小（1MB），防止大文件 OOM */
const MAX_EDIT_FILE_BYTES = 1024 * 1024;

/** 生成简易 diff 预览（前后对照，标记 +/-） */
function generateDiffPreview(original: string, modified: string): string {
  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : null;
    const newLine = i < newLines.length ? newLines[i] : null;
    if (oldLine === newLine) {
      out.push(`  ${String(i + 1).padStart(5)}  ${oldLine}`);
    } else {
      if (oldLine !== null) out.push(`- ${String(i + 1).padStart(5)}  ${oldLine}`);
      if (newLine !== null) out.push(`+ ${String(i + 1).padStart(5)}  ${newLine}`);
    }
  }
  return out.join('\n');
}

export class FileEditTool implements ITool {
  // Phase 53 Task 7：配置保护守卫（可选，未注入时跳过检查）
  private configGuard?: ConfigGuard;
  // 可选确认流程开关：app-init.ts 读取 config.tools.fileEdit.requireConfirmation 后通过 setter 注入
  // 未注入时默认 false，向后兼容（直接应用编辑）
  private requireConfirmation = false;

  /** Phase 53 Task 7：注入配置保护守卫 */
  setConfigGuard(guard: ConfigGuard): void {
    this.configGuard = guard;
  }

  /** 注入确认流程开关（由 app-init.ts 从 config.tools.fileEdit.requireConfirmation 读取后调用） */
  setRequireConfirmation(value: boolean): void {
    this.requireConfirmation = value;
  }

  readonly definition: ToolDefinition = {
    name: 'file_edit',
    description:
      '当用户需要精确修改文件中的某段字符串、避免全量重写时，使用此工具（action=replace，默认）。'
      + '要求 oldString 在文件中唯一匹配，支持批量替换。'
      + '当用户需要按行号范围替换某一段内容时，使用 action=edit_lines（参数：startLine/endLine/newContent，1-based 闭区间）。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        action: {
          type: 'string',
          enum: ['replace', 'edit_lines'],
          description:
            '编辑模式：replace（默认，字符串精确替换）/ edit_lines（按行号范围替换）。',
        },
        oldString: {
          type: 'string',
          description: 'replace 模式：要替换的旧字符串（必须在文件中唯一匹配）',
        },
        newString: {
          type: 'string',
          description: 'replace 模式：替换后的新字符串',
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string' },
              newString: { type: 'string' },
            },
            required: ['oldString', 'newString'],
          },
          description: 'replace 模式：批量替换列表（与 oldString/newString 二选一）',
        },
        startLine: {
          type: 'number',
          description: 'edit_lines 模式：起始行号（1-based，闭区间）',
        },
        endLine: {
          type: 'number',
          description: 'edit_lines 模式：结束行号（1-based，闭区间，超过文件总行数时自动截断到最后一行）',
        },
        newContent: {
          type: 'string',
          description: 'edit_lines 模式：替换后的新内容',
        },
      },
      required: ['path'],
    },
    requiresApproval: true,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }

    const action = (args.action as EditAction | undefined) ?? 'replace';

    if (action === 'edit_lines') {
      // edit_lines 模式：要求 startLine / endLine / newContent
      const startLine = args.startLine as unknown;
      const endLine = args.endLine as unknown;
      const newContent = args.newContent as unknown;

      if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
        errors.push('edit_lines 模式要求 startLine 为正整数（1-based）');
      }
      if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
        errors.push('edit_lines 模式要求 endLine 为正整数（1-based）');
      }
      if (
        typeof startLine === 'number' && typeof endLine === 'number'
        && startLine > endLine
      ) {
        errors.push('startLine 不能大于 endLine');
      }
      if (typeof newContent !== 'string') {
        errors.push('edit_lines 模式要求 newContent 为字符串');
      }
      // edit_lines 模式不允许同时传 oldString/newString/edits
      if (args.oldString !== undefined || args.newString !== undefined || args.edits !== undefined) {
        errors.push('edit_lines 模式不能同时使用 oldString/newString/edits');
      }
      return { valid: errors.length === 0, errors };
    }

    // 默认 replace 模式
    if (args.action !== undefined && action !== 'replace') {
      errors.push(`未知的 action: ${String(args.action)}（支持: replace | edit_lines）`);
    }

    const hasSingle = typeof args.oldString === 'string' && typeof args.newString === 'string';
    const hasBatch = Array.isArray(args.edits);

    if (!hasSingle && !hasBatch) {
      errors.push('必须提供 oldString+newString 或 edits 数组');
    }
    if (hasSingle && hasBatch) {
      errors.push('oldString+newString 和 edits 不能同时使用');
    }

    if (hasBatch) {
      const edits = args.edits as unknown[];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] as Record<string, unknown>;
        if (typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
          errors.push(`edits[${i}] 必须包含 oldString 和 newString 字符串`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);

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

    const action = (args.action as EditAction | undefined) ?? 'replace';

    try {
      // P2-1：读取前检查文件大小，防止大文件 OOM
      const preStats = await fs.stat(filePath);
      if (preStats.size > MAX_EDIT_FILE_BYTES) {
        return {
          success: false,
          output: '',
          error: `文件过大: ${preStats.size} 字节（上限 ${MAX_EDIT_FILE_BYTES} 字节）。file_edit 仅支持编辑 1MB 以内的文件。`,
          durationMs: 0,
          metadata: { fileSize: preStats.size, maxBytes: MAX_EDIT_FILE_BYTES },
        };
      }

      // 读取原文件内容
      const original = await fs.readFile(filePath, 'utf-8');

      // 按 action 分支计算 modified
      let modified: string;
      let appliedSummary: { count: number; mode: EditAction; detail: Record<string, unknown> };

      if (action === 'edit_lines') {
        const result = this.applyEditLines(original, args);
        if (!result.ok) {
          return {
            success: false,
            output: '',
            error: result.error,
            durationMs: 0,
          };
        }
        modified = result.modified;
        const startLine = args.startLine as number;
        const endLine = args.endLine as number;
        appliedSummary = {
          count: 1,
          mode: 'edit_lines',
          detail: { startLine, endLine, actualEndLine: result.actualEndLine },
        };
      } else {
        const result = this.applyReplace(original, args);
        if (!result.ok) {
          return {
            success: false,
            output: '',
            error: result.error,
            durationMs: 0,
            metadata: result.metadata,
          };
        }
        modified = result.modified;
        appliedSummary = {
          count: result.appliedEdits.length,
          mode: 'replace',
          detail: { appliedEdits: result.appliedEdits },
        };
      }

      // Phase 53 Task 7：配置保护守卫（受 guard 注入控制，检查修改后的内容是否弱化安全/治理配置）
      if (this.configGuard) {
        const guardResult = this.configGuard.checkModification(filePath, modified, original);
        if (!guardResult.allowed) {
          return {
            success: false,
            output: '',
            error: guardResult.reason ?? '配置保护守卫阻止了此操作',
            durationMs: 0,
          };
        }
      }

      // 内容未变化
      if (modified === original) {
        return {
          success: true,
          output: '文件内容未变化（newContent 与原内容相同 / oldString 和 newString 相同）',
          durationMs: 0,
          metadata: { filePath, editsApplied: 0, action },
        };
      }

      // 可选确认流程：requireConfirmation=true 且 context 提供 requestConfirmation 时
      // 先返回 diff 预览请求用户确认；用户拒绝则不写入（向后兼容：无回调直接应用）
      if (this.requireConfirmation && typeof context.requestConfirmation === 'function') {
        const diff = generateDiffPreview(original, modified);
        const reason = [
          `即将编辑文件: ${args.path}`,
          `模式: ${action}`,
          '',
          '----- diff 预览 -----',
          diff,
          '--------------------',
        ].join('\n');
        const confirmed = await context.requestConfirmation(reason);
        if (!confirmed) {
          return {
            success: false,
            output: '',
            error: '用户取消了编辑操作',
            durationMs: 0,
            metadata: { filePath, action, cancelled: true },
          };
        }
      }

      // 写入前将原内容推入 EditHistory（/undo 可恢复）
      // 注：确认通过后再 push，避免用户取消后栈中残留无效条目
      editHistory.push(filePath, original);

      // 写回文件
      await fs.writeFile(filePath, modified, 'utf-8');

      const stats = await fs.stat(filePath);
      const lines = modified.split('\n').length;

      // 返回 diff 预览（始终返回，便于调用方展示）
      const diffPreview = generateDiffPreview(original, modified);

      const outputMessage = action === 'edit_lines'
        ? `文件编辑成功: ${args.path} (edit_lines 行 ${appliedSummary.detail.startLine}-${appliedSummary.detail.actualEndLine}, ${lines} 行, ${stats.size} 字节)`
        : `文件编辑成功: ${args.path} (应用 ${appliedSummary.count} 处替换, ${lines} 行, ${stats.size} 字节)`;

      return {
        success: true,
        output: outputMessage,
        durationMs: 0,
        metadata: {
          filePath,
          action,
          editsApplied: appliedSummary.count,
          appliedEdits: appliedSummary.detail.appliedEdits,
          startLine: appliedSummary.detail.startLine,
          endLine: appliedSummary.detail.endLine,
          actualEndLine: appliedSummary.detail.actualEndLine,
          bytes: stats.size,
          lines,
          diffPreview,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 文件不存在的特殊提示
      if (msg.includes('ENOENT')) {
        return {
          success: false,
          output: '',
          error: `文件不存在: ${args.path}。如需创建新文件，请使用 file_write 工具。`,
          durationMs: 0,
        };
      }
      return {
        success: false,
        output: '',
        error: `编辑文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /**
   * edit_lines 模式：将 startLine ~ endLine（1-based 闭区间）替换为 newContent
   * endLine 超过文件总行数时自动截断到最后一行
   *
   * 行号语义：用户视角的"行"（文件 'A\nB\nC\n' 视为 3 行：A/B/C，尾换行不算行）
   * 尾换行保留：若原文件以 \n 结尾，结果也以 \n 结尾（除非结果为空）
   */
  private applyEditLines(
    original: string,
    args: Record<string, unknown>,
  ): { ok: true; modified: string; actualEndLine: number } | { ok: false; error: string } {
    const startLine = args.startLine as number;
    const endLine = args.endLine as number;
    const newContent = args.newContent as string;

    // 判断原文件是否以 \n 结尾（用于结果尾换行保留）
    const hasTrailingNewline = original.endsWith('\n');
    // 按行切分，移除尾部空字符串（'A\nB\nC\n'.split('\n') === ['A','B','C','']）
    // 这样 totalLines 对齐"用户视角的行数"
    const rawLines = original.split('\n');
    const lines = hasTrailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines;
    const totalLines = lines.length;

    // 截断 endLine 到最后一行
    const actualEndLine = Math.min(endLine, totalLines);

    // 校验已由 validateArgs 完成，这里防御性再判一次
    if (startLine < 1 || startLine > totalLines) {
      return { ok: false, error: `startLine ${startLine} 越界（文件共 ${totalLines} 行）` };
    }
    if (actualEndLine < startLine) {
      return { ok: false, error: `endLine ${endLine} 截断后 ${actualEndLine} 小于 startLine ${startLine}` };
    }

    // 切片：保留 [0, startLine-1) + newContent + [actualEndLine, end)
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(actualEndLine);

    // 拼接：用 \n 连接 before、newContent（若非空）、after
    //   - newContent 为空 = 删除指定行范围
    //   - newContent 非空 = 替换为 newContent（用户可传多行内容）
    const parts = newContent === ''
      ? [...before, ...after]
      : [...before, newContent, ...after];
    let modified = parts.join('\n');

    // 保留原文件尾换行行为：原文件以 \n 结尾且结果非空时，补一个尾 \n
    if (hasTrailingNewline && modified.length > 0 && !modified.endsWith('\n')) {
      modified += '\n';
    }

    return { ok: true, modified, actualEndLine };
  }

  /**
   * replace 模式：逐条应用 oldString → newString 替换（保留原唯一性校验语义）
   */
  private applyReplace(
    original: string,
    args: Record<string, unknown>,
  ): {
    ok: true;
    modified: string;
    appliedEdits: Array<{ oldString: string; replaced: boolean }>;
  } | {
    ok: false;
    error: string;
    metadata?: Record<string, unknown>;
  } {
    // 解析替换列表
    let edits: EditEntry[];
    if (Array.isArray(args.edits)) {
      edits = args.edits as EditEntry[];
    } else {
      edits = [{
        oldString: args.oldString as string,
        newString: args.newString as string,
      }];
    }

    let modified = original;
    const appliedEdits: Array<{ oldString: string; replaced: boolean }> = [];

    for (const edit of edits) {
      const { oldString, newString } = edit;

      // 空字符串不允许作为 oldString
      if (oldString.length === 0) {
        return { ok: false, error: 'oldString 不能为空字符串' };
      }

      // 修复：唯一性校验基于 original 内容，避免前序替换影响后续校验
      const matchCount = original.split(oldString).length - 1;

      if (matchCount === 0) {
        return {
          ok: false,
          error: `oldString 在文件中未找到匹配。请检查 oldString 是否正确（注意空白字符和缩进）。`,
          metadata: { failedEdit: oldString.slice(0, 80) },
        };
      }

      if (matchCount > 1) {
        return {
          ok: false,
          error: `oldString 在文件中有 ${matchCount} 处匹配，必须唯一。请提供更多上下文使匹配唯一。`,
          metadata: { matchCount, failedEdit: oldString.slice(0, 80) },
        };
      }

      // 唯一匹配，执行替换（替换仍作用于 modified）
      // 注意：前序 edit 可能已消耗此 oldString，需检查是否仍存在于 modified
      if (!modified.includes(oldString)) {
        appliedEdits.push({ oldString: oldString.slice(0, 60), replaced: false });
      } else {
        modified = modified.replace(oldString, newString);
        appliedEdits.push({ oldString: oldString.slice(0, 60), replaced: true });
      }
    }

    return { ok: true, modified, appliedEdits };
  }
}
