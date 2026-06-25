// src/tools/builtin/git-op.ts
// Git 操作工具
// 权限：confirm（写操作）/ auto（读操作），实际由 PermissionEngine 规则控制
// Phase 0c 修复后：权限统一由 PermissionEngine 中间件决策（原 PermissionChecker 已删除）
// P2-14：增加 blame 操作，支持查看文件每行的最后修改者

import simpleGit, { type SimpleGit } from 'simple-git';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class GitOpTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git_op',
    description: '当用户需要执行 Git 操作（如查看状态、提交、推送、拉取、查看 diff 或 blame）时，使用此工具。支持 status/log/diff/add/commit/push/pull/blame/prune。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'blame', 'prune'],
          description: 'Git 操作类型',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '操作参数（blame 时 args[0] 为文件路径）',
        },
      },
      required: ['operation'],
    },
    requiresApproval: true,
    category: 'git',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const validOps = ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'blame', 'prune'];
    if (!args.operation || typeof args.operation !== 'string') {
      errors.push('缺少必需参数: operation');
    } else if (!validOps.includes(args.operation)) {
      errors.push(`无效的 operation: ${args.operation}`);
    }
    if (args.args !== undefined && !Array.isArray(args.args)) {
      errors.push('args 必须是字符串数组');
    }
    // blame 操作需要文件路径
    if (args.operation === 'blame') {
      const opArgs = (args.args as string[]) ?? [];
      if (opArgs.length === 0 || !opArgs[0]) {
        errors.push('blame 操作需要文件路径（args[0]）');
      }
    }
    // C10 修复：add 操作必须指定具体文件，不允许 git add -A / git add .
    if (args.operation === 'add') {
      const opArgs = (args.args as string[]) ?? [];
      if (opArgs.length === 0) {
        errors.push('add 操作必须指定具体文件路径（args），不允许添加全部文件以避免覆盖用户已暂存的文件');
      }
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const operation = args.operation as string;
    const opArgs = (args.args as string[]) ?? [];

    try {
      const git: SimpleGit = simpleGit(context.workingDirectory);
      let output = '';

      switch (operation) {
        case 'status': {
          const status = await git.status();
          output = JSON.stringify(status, null, 2);
          break;
        }
        case 'log': {
          const log = await git.log(opArgs.length > 0 ? opArgs : ['-10']);
          output = log.all.map(c => `${c.hash.slice(0, 7)} ${c.date} ${c.message}`).join('\n');
          break;
        }
        case 'diff': {
          output = await git.diff(opArgs);
          break;
        }
        case 'add': {
          // C10 修复：只添加 Agent 指定的具体文件，不使用 git add -A / git add .
          // 避免把用户已暂存的其他文件也一起提交
          if (opArgs.length === 0) {
            return {
              success: false,
              output: '',
              error: 'add 操作必须指定具体文件路径，不允许添加全部文件',
              durationMs: 0,
            };
          }
          await git.add(opArgs);
          output = `已添加文件: ${opArgs.join(', ')}`;
          break;
        }
        case 'commit': {
          const message = opArgs[0];
          if (!message) {
            return {
              success: false,
              output: '',
              error: 'commit 操作需要提供提交信息',
              durationMs: 0,
            };
          }
          const result = await git.commit(message, opArgs.slice(1));
          output = `提交成功: ${result.commit}`;
          break;
        }
        case 'push': {
          const pushResult = await git.push(opArgs);
          output = `推送成功: ${pushResult.repo}-${pushResult.ref?.local ?? 'unknown'}`;
          break;
        }
        case 'pull': {
          const pullResult = await git.pull();
          output = `拉取成功: ${JSON.stringify(pullResult.summary, null, 2)}`;
          break;
        }
        case 'blame': {
          // P2-14：git blame 查看文件每行的最后修改者
          // P2-2 修复：校验文件路径，使用 -- 分隔符防止参数注入
          const filePath = opArgs[0];
          // 路径边界校验：防止读取项目外文件
          const { checkPathBoundary } = await import('./search-utils.js');
          const resolvedFilePath = path.resolve(context.workingDirectory, filePath);
          const boundaryError = checkPathBoundary(resolvedFilePath, context);
          if (boundaryError) {
            return { success: false, output: '', error: `路径越界: ${filePath} 不在允许的目录范围内`, durationMs: 0 };
          }
          const startLine = opArgs[1]; // 可选起始行
          const endLine = opArgs[2];   // 可选结束行
          const blameArgs = ['blame', '--line-porcelain'];
          if (startLine && endLine) {
            blameArgs.push('-L', `${startLine},${endLine}`);
          }
          // P2-2：使用 -- 分隔符防止参数注入（如 --; rm -rf /）
          blameArgs.push('--', filePath);
          const blameResult = await git.raw(blameArgs);
          // 解析 --line-porcelain 格式，提取关键信息
          output = this.parseBlame(blameResult);
          break;
        }
        case 'prune': {
          // I29 修复：prune 前先执行 git gc --prune=now 清理旧 commit
          // 原 git prune 只清理松散对象但不删除旧 commit，git 历史持续膨胀
          const gcResult = await git.raw(['gc', '--prune=now']);
          output = `已执行 git gc --prune=now 清理旧 commit 和松散对象${gcResult ? '\n' + gcResult : ''}`;
          break;
        }
        default:
          return {
            success: false,
            output: '',
            error: `不支持的 Git 操作: ${operation}`,
            durationMs: 0,
          };
      }

      return {
        success: true,
        output,
        durationMs: 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `Git 操作失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /**
   * 解析 git blame --line-porcelain 输出
   * 格式：每行记录以 <hash> <orig-line> <final-line> 开头，后续是 metadata 键值对，最后是 \t<content>
   */
  private parseBlame(blameOutput: string): string {
    const lines = blameOutput.split('\n');
    const result: string[] = [];
    let currentHash = '';
    let currentAuthor = '';
    let currentTime = '';
    let currentLine = '';
    let contentLine = '';

    for (const line of lines) {
      // 行内容以 tab 开头
      if (line.startsWith('\t')) {
        contentLine = line.slice(1);
        result.push(`${currentLine.padStart(5)} | ${currentHash.slice(0, 8)} | ${currentAuthor} | ${contentLine}`);
        // 重置
        currentHash = '';
        currentAuthor = '';
        currentTime = '';
        continue;
      }

      // 解析 header 行：hash orig-line final-line
      const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)/);
      if (headerMatch) {
        currentHash = headerMatch[1];
        currentLine = headerMatch[3]; // final-line
        continue;
      }

      // 解析 metadata
      if (line.startsWith('author ')) {
        currentAuthor = line.slice(7);
      } else if (line.startsWith('author-time ')) {
        const timestamp = parseInt(line.slice(12), 10);
        currentTime = new Date(timestamp * 1000).toISOString().slice(0, 10);
      }
    }

    // 限制输出行数（防止过大）
    const maxLines = 200;
    if (result.length > maxLines) {
      return result.slice(0, maxLines).join('\n') + `\n\n[... blame 结果已截断，共 ${result.length} 行，已显示前 ${maxLines} 行]`;
    }

    return result.join('\n') || 'blame 结果为空';
  }
}
