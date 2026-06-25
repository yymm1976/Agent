// src/cli/commands/tech-debt.ts
// /tech-debt 命令：记录、查看、解决技术债
// Phase 36 Task 3：配合 minimalist-coding Skill 的"技术债记录机制"
// 数据持久化到 .routedev/tech-debt.json

import type { CommandDefinition } from '../command-registry.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** 技术债条目 */
interface TechDebtEntry {
  /** 唯一 ID（自增整数转字符串） */
  id: string;
  /** 技术债描述 */
  description: string;
  /** 创建时间戳 */
  addedAt: number;
  /** 解决时间戳（未解决时为 undefined） */
  resolvedAt?: number;
  /** 可选上下文（如相关文件、原因） */
  context?: string;
}

/** 技术债存储文件名 */
const TECH_DEBT_FILE = 'tech-debt.json';

/**
 * 获取技术债文件路径
 * 存储在项目目录下的 .routedev/ 目录中
 */
function getTechDebtPath(cwd: string): string {
  return path.join(cwd, '.routedev', TECH_DEBT_FILE);
}

/**
 * 读取技术债列表
 * 文件不存在时返回空数组（不报错）
 */
async function readTechDebt(cwd: string): Promise<TechDebtEntry[]> {
  const filePath = getTechDebtPath(cwd);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as { entries: TechDebtEntry[] };
    return data.entries ?? [];
  } catch {
    // 文件不存在或解析失败，返回空数组
    return [];
  }
}

/**
 * 写入技术债列表
 * 自动创建 .routedev/ 目录
 */
async function writeTechDebt(cwd: string, entries: TechDebtEntry[]): Promise<void> {
  const filePath = getTechDebtPath(cwd);
  const dir = path.dirname(filePath);
  ensureDir(dir);
  await fs.writeFile(filePath, JSON.stringify({ entries }, null, 2), 'utf-8');
}

/**
 * 生成下一个技术债 ID
 * 取当前最大数字 ID + 1
 */
function nextId(entries: TechDebtEntry[]): string {
  const maxNum = entries.reduce((max, e) => {
    const num = parseInt(e.id, 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
  return String(maxNum + 1);
}

export const techDebtCommand: CommandDefinition = {
  name: 'tech-debt',
  aliases: ['td'],
  description: '管理技术债（记录延后的优化）',
  usage: '/tech-debt <add <描述> | list | resolve <id>>',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? '';
    const rest = parts.slice(1).join(' ');

    switch (sub) {
      case 'add': {
        if (!rest) {
          return { type: 'handled', messages: ['用法: /tech-debt add <技术债描述>'] };
        }
        const entries = await readTechDebt(ctx.cwd);
        const id = nextId(entries);
        const entry: TechDebtEntry = {
          id,
          description: rest,
          addedAt: Date.now(),
        };
        entries.push(entry);
        await writeTechDebt(ctx.cwd, entries);
        logger.info('Tech debt added', { id, description: rest });
        return {
          type: 'handled',
          messages: [`✓ 技术债 #${id} 已记录: ${rest}`],
        };
      }

      case 'list': {
        const entries = await readTechDebt(ctx.cwd);
        const unresolved = entries.filter(e => e.resolvedAt === undefined);
        if (unresolved.length === 0) {
          return { type: 'handled', messages: ['（无未解决的技术债）'] };
        }
        const lines = [
          `## 未解决技术债（${unresolved.length} 条）`,
          '',
          ...unresolved.map(e => {
            const date = new Date(e.addedAt).toLocaleDateString('zh-CN');
            return `- **#${e.id}** [${date}] ${e.description}`;
          }),
          '',
          '使用 /tech-debt resolve <id> 标记为已解决',
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'resolve': {
        const id = rest.trim();
        if (!id) {
          return { type: 'handled', messages: ['用法: /tech-debt resolve <id>'] };
        }
        const entries = await readTechDebt(ctx.cwd);
        const entry = entries.find(e => e.id === id);
        if (!entry) {
          return { type: 'handled', messages: [`❌ 未找到技术债 #${id}`] };
        }
        if (entry.resolvedAt !== undefined) {
          return { type: 'handled', messages: [`技术债 #${id} 已解决（无需重复操作）`] };
        }
        entry.resolvedAt = Date.now();
        await writeTechDebt(ctx.cwd, entries);
        logger.info('Tech debt resolved', { id });
        return {
          type: 'handled',
          messages: [`✓ 技术债 #${id} 已标记为解决: ${entry.description}`],
        };
      }

      default: {
        const lines = [
          '用法：/tech-debt <subcommand>',
          '',
          '  add <描述>     — 记录一条新的技术债',
          '  list           — 列出所有未解决的技术债',
          '  resolve <id>   — 将指定技术债标记为已解决',
          '',
          '别名: /td',
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }
    }
  },
};
