// src/config/codegraph-manager.ts
// Phase 39 Task 1：CodeGraph 增强引擎管理器
// 双轨制：内置轻量引擎（repo-map.ts）+ CodeGraph MCP 外接（@colbymchenry/codegraph）
// 本模块负责 CodeGraph MCP 的可用性检测、安装、工具定义

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { walkDir } from '../tools/builtin/search-utils.js';

/** CodeGraph 配置 */
export interface CodeGraphConfig {
  /** 是否启用 CodeGraph 增强引擎 */
  enabled: boolean;
  /** 工作区路径 */
  workspace: string;
  /** 是否自动索引 */
  autoIndex: boolean;
}

/** CodeGraph 安装结果 */
export interface CodeGraphInstallResult {
  success: boolean;
  message: string;
}

/** CodeGraph 工具定义 */
export interface CodeGraphToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/** 代码文件扩展名（用于统计） */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.vue', '.svelte',
]);

/**
 * CodeGraph 增强引擎管理器
 * 静态方法类，负责：
 *   1. 检测工作区是否已安装 CodeGraph（.codegraph/ 目录 + SQLite 文件）
 *   2. 统计工作区代码文件数量
 *   3. 安装 CodeGraph（spawn npx @colbymchenry/codegraph）
 *   4. 返回 CodeGraph MCP 工具定义
 */
export class CodeGraphManager {
  /** .codegraph 目录名 */
  static readonly CODEGRAPH_DIR = '.codegraph';
  /** SQLite 文件扩展名 */
  static readonly SQLITE_EXT = '.sqlite';
  /** 安装命令超时（毫秒） */
  static readonly INSTALL_TIMEOUT_MS = 120_000;

  /**
   * 检测工作区是否已安装 CodeGraph
   * 判据：${workspace}/.codegraph/ 目录存在且包含 SQLite 文件
   */
  static isAvailable(workspace: string): boolean {
    try {
      const codegraphDir = path.join(workspace, CodeGraphManager.CODEGRAPH_DIR);
      if (!fs.existsSync(codegraphDir)) return false;
      const stat = fs.statSync(codegraphDir);
      if (!stat.isDirectory()) return false;
      // 检查目录下是否有 SQLite 文件
      const entries = fs.readdirSync(codegraphDir);
      return entries.some(name => name.endsWith(CodeGraphManager.SQLITE_EXT));
    } catch {
      return false;
    }
  }

  /**
   * 递归统计工作区代码文件数量
   * 排除 node_modules / .git / dist 等目录
   */
  static async countCodeFiles(workspace: string): Promise<number> {
    try {
      const files = await walkDir(workspace, 10_000);
      let count = 0;
      for (const filePath of files) {
        const ext = path.extname(filePath);
        if (CODE_EXTENSIONS.has(ext)) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * 安装 CodeGraph 到工作区
   * 通过 spawn 调用 npx @colbymchenry/codegraph
   */
  static install(workspace: string): Promise<CodeGraphInstallResult> {
    return new Promise(resolve => {
      try {
        const child = spawn(
          'npx',
          ['@colbymchenry/codegraph', 'init'],
          {
            cwd: workspace,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
          },
        );

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', data => {
          stdout += data.toString();
        });
        child.stderr?.on('data', data => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve({
            success: false,
            message: `安装超时（${CodeGraphManager.INSTALL_TIMEOUT_MS / 1000}s）`,
          });
        }, CodeGraphManager.INSTALL_TIMEOUT_MS);

        child.on('close', code => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({
              success: true,
              message: 'CodeGraph 安装成功',
            });
          } else {
            resolve({
              success: false,
              message: `安装失败（exit code ${code}）${stderr ? ': ' + stderr.trim() : ''}`,
            });
          }
        });

        child.on('error', err => {
          clearTimeout(timer);
          resolve({
            success: false,
            message: `安装失败: ${err.message}`,
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ success: false, message: `安装失败: ${msg}` });
      }
    });
  }

  /**
   * 返回 CodeGraph MCP 的 8 个工具定义
   * 这些工具在 CodeGraph 启用后通过 MCP 协议注册到 ToolRegistry
   */
  static getToolDefinitions(): CodeGraphToolDefinition[] {
    return [
      {
        name: 'codegraph_search',
        description: '在代码图中搜索符号、定义或引用。支持按名称、类型、模式过滤。',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索查询（符号名或正则）' },
            type: {
              type: 'string',
              enum: ['function', 'class', 'method', 'variable', 'interface', 'all'],
              description: '符号类型过滤（默认 all）',
            },
            limit: { type: 'number', description: '最大返回数（默认 50）' },
          },
          required: ['query'],
        },
      },
      {
        name: 'codegraph_context',
        description: '获取指定符号的完整上下文：定义、引用、调用关系、类型信息。',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '符号名称' },
            file: { type: 'string', description: '文件路径（可选，消歧义）' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'codegraph_callers',
        description: '查找指定函数/方法的所有调用者（谁调用了它）。',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '函数/方法名称' },
            file: { type: 'string', description: '文件路径（可选）' },
            depth: { type: 'number', description: '递归深度（默认 1）' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'codegraph_callees',
        description: '查找指定函数/方法调用的所有函数（它调用了谁）。',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '函数/方法名称' },
            file: { type: 'string', description: '文件路径（可选）' },
            depth: { type: 'number', description: '递归深度（默认 1）' },
          },
          required: ['symbol'],
        },
      },
      {
        name: 'codegraph_impact',
        description: '分析变更影响：指定文件或符号变更后，哪些文件/符号会受到影响。',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '变更文件路径' },
            symbol: { type: 'string', description: '变更符号（可选）' },
            maxDepth: { type: 'number', description: '最大影响深度（默认 3）' },
          },
          required: ['file'],
        },
      },
      {
        name: 'codegraph_node',
        description: '获取代码图中指定节点的详细信息（类型、位置、文档、修饰符）。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '节点 ID' },
            name: { type: 'string', description: '节点名称（备选）' },
          },
        },
      },
      {
        name: 'codegraph_files',
        description: '列出代码图中已索引的所有文件，支持按路径/扩展名过滤。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '路径 glob 过滤（可选）' },
            extension: { type: 'string', description: '扩展名过滤（如 .ts）' },
          },
        },
      },
      {
        name: 'codegraph_status',
        description: '获取 CodeGraph 索引状态：已索引文件数、符号数、最后更新时间、数据库大小。',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }
}
