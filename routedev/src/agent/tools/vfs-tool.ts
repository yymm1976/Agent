// src/agent/tools/vfs-tool.ts
// Phase 71 Task E1：4 个 VFS 工具（vfs_read / vfs_write / vfs_list / vfs_delete）
//
// 设计：
// - 每个工具实现 ITool 接口（与项目其他工具一致，如 NotesTool）
// - 构造函数注入 VirtualFS 实例（与 loop 共享同一实例）
// - 路径非法时返回 success=false 的 ToolResult（fail-open：不抛异常，错误信息透传给 LLM）
// - category: 'system'，requiresApproval: false（纯内存操作，无副作用）
//
// 严禁死代码：4 个工具均由 app-init.ts 注册到 ToolRegistry，被 LLM 调用消费。

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../../tools/types.js';
import type { VirtualFS } from '../context/virtual-fs.js';

/**
 * VFS 工具基类：共享 VirtualFS 实例引用
 */
abstract class BaseVfsTool implements ITool {
  abstract readonly definition: ToolDefinition;
  protected readonly vfs: VirtualFS;

  constructor(vfs: VirtualFS) {
    this.vfs = vfs;
  }

  abstract validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] };
  abstract execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * vfs_read：从 VFS 读取文件内容
 */
export class VfsReadTool extends BaseVfsTool {
  readonly definition: ToolDefinition = {
    name: 'vfs_read',
    description: '从进程内虚拟文件系统读取文件内容。路径使用 posix 风格（用 / 分隔），相对路径基于根 /。文件不存在或路径非法时返回错误。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'VFS 路径（posix 风格，相对路径基于 / 根）',
        },
      },
      required: ['path'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    const content = this.vfs.read(path);
    if (content === null) {
      return {
        success: false,
        output: '',
        error: `[vfs_read] 路径非法或文件不存在: ${path}`,
        durationMs: 0,
      };
    }
    return {
      success: true,
      output: content,
      durationMs: 0,
    };
  }
}

/**
 * vfs_write：写入文件到 VFS（覆盖式）
 */
export class VfsWriteTool extends BaseVfsTool {
  readonly definition: ToolDefinition = {
    name: 'vfs_write',
    description: '将内容写入进程内虚拟文件系统（覆盖式）。路径使用 posix 风格，相对路径基于根 /。用于维护 todo、scratchpad、notes 等工作内存状态。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'VFS 路径（posix 风格，相对路径基于 / 根）',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容',
        },
      },
      required: ['path', 'content'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }
    if (args.content === undefined || typeof args.content !== 'string') {
      errors.push('缺少必需参数: content');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    const content = args.content as string;

    // 路径合法性预检（VFS.write 静默忽略非法路径，工具层需主动检测并返回错误）
    if (this.vfs.normalizePath(path) === null) {
      return {
        success: false,
        output: '',
        error: `[vfs_write] 路径非法（疑似 .. 越权或空串）: ${path}`,
        durationMs: 0,
      };
    }

    this.vfs.write(path, content);
    return {
      success: true,
      output: `已写入 VFS: ${path} (${content.length} 字节)`,
      durationMs: 0,
    };
  }
}

/**
 * vfs_list：列出 VFS 目录直接子节点
 */
export class VfsListTool extends BaseVfsTool {
  readonly definition: ToolDefinition = {
    name: 'vfs_list',
    description: '列出进程内虚拟文件系统中指定目录的直接子节点（不递归）。目录子项以 / 结尾。返回 JSON 数组字符串。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'VFS 目录路径（posix 风格，相对路径基于 / 根，根目录传 /）',
        },
      },
      required: ['dir'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.dir || typeof args.dir !== 'string') {
      errors.push('缺少必需参数: dir');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dir = args.dir as string;

    if (this.vfs.normalizePath(dir) === null) {
      return {
        success: false,
        output: '',
        error: `[vfs_list] 路径非法（疑似 .. 越权或空串）: ${dir}`,
        durationMs: 0,
      };
    }

    const entries = this.vfs.list(dir);
    return {
      success: true,
      output: JSON.stringify(entries),
      durationMs: 0,
      metadata: { count: entries.length },
    };
  }
}

/**
 * vfs_delete：删除 VFS 文件或目录（递归）
 */
export class VfsDeleteTool extends BaseVfsTool {
  readonly definition: ToolDefinition = {
    name: 'vfs_delete',
    description: '删除进程内虚拟文件系统中的文件或目录（目录递归删除）。路径使用 posix 风格，相对路径基于根 /。删除根 / 被禁止。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'VFS 路径（posix 风格，相对路径基于 / 根）',
        },
      },
      required: ['path'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;

    const normalized = this.vfs.normalizePath(path);
    if (normalized === null) {
      return {
        success: false,
        output: '',
        error: `[vfs_delete] 路径非法（疑似 .. 越权或空串）: ${path}`,
        durationMs: 0,
      };
    }
    if (normalized === '/') {
      return {
        success: false,
        output: '',
        error: '[vfs_delete] 禁止删除根目录 /',
        durationMs: 0,
      };
    }
    if (!this.vfs.exists(path)) {
      return {
        success: false,
        output: '',
        error: `[vfs_delete] 路径不存在: ${path}`,
        durationMs: 0,
      };
    }

    this.vfs.delete(path);
    return {
      success: true,
      output: `已删除 VFS 路径: ${path}`,
      durationMs: 0,
    };
  }
}
