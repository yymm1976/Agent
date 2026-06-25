// src/cli/commands/schedule.ts
// /schedule 命令：定时任务管理
// Phase 37 Task 2：子命令 list / add / remove / toggle / run / next
// 任务持久化到 ~/.qoderwork/routedev/scheduled-tasks.json

import type { CommandDefinition } from '../command-registry.js';
import path from 'node:path';
import os from 'node:os';
import { ScheduleStore } from '../../scheduler/store.js';
import { validateCron, parseCron, getNextRun } from '../../scheduler/cron-parser.js';
import type { ScheduledTask } from '../../scheduler/types.js';

/** 默认存储路径 */
const DEFAULT_STORE_PATH = path.join(
  os.homedir(),
  '.qoderwork',
  'routedev',
  'scheduled-tasks.json',
);

/** 默认时区 */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 获取默认 store 实例 */
function getStore(): ScheduleStore {
  return new ScheduleStore(DEFAULT_STORE_PATH);
}

/** 生成任务 ID */
function generateId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 解析带引号的参数
 * 支持 "双引号" '单引号' 和 无引号 三种形式
 */
function parseQuotedArgs(args: string): string[] {
  const result: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(args)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

/**
 * 将时区名称转换为 UTC 偏移分钟数
 * 使用 Intl.DateTimeFormat（内置，不引入外部库）
 */
function getTimezoneOffsetMinutes(timezone: string): number {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    const tzAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    const diffMs = tzAsUtc - now.getTime();
    return Math.round(diffMs / 60000);
  } catch {
    return -new Date().getTimezoneOffset();
  }
}

/** 计算指定 cron 在指定时区下的下次执行时间戳 */
function calcNextRun(cron: string, timezone: string): number | undefined {
  try {
    const parsed = parseCron(cron);
    const offset = getTimezoneOffsetMinutes(timezone);
    return getNextRun(parsed, new Date(), offset).getTime();
  } catch {
    return undefined;
  }
}

/** 格式化下次执行时间 */
function formatNextRun(task: ScheduledTask): string {
  if (!task.enabled) return '已禁用';
  if (task.nextRun === undefined) return '未计算';
  return new Date(task.nextRun).toLocaleString('zh-CN');
}

export const scheduleCommand: CommandDefinition = {
  name: 'schedule',
  aliases: ['cron'],
  description: '定时任务管理',
  usage: '/schedule <list|add|remove|toggle|run|next>',
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    const spaceIdx = trimmed.search(/\s/);
    const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
    const store = getStore();

    switch (sub) {
      case 'list': {
        const tasks = store.list();
        if (tasks.length === 0) {
          return { type: 'handled', messages: ['（暂无定时任务）'] };
        }
        const lines = [
          `## 定时任务（${tasks.length} 个）`,
          '',
          ...tasks.map((t) => {
            const status = t.enabled ? '[ON] ' : '[OFF]';
            return `${status} ${t.id}\n    名称: ${t.name}\n    cron: ${t.cron}\n    下次: ${formatNextRun(t)}\n    已执行: ${t.runCount} 次`;
          }),
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'add': {
        const parsed = parseQuotedArgs(rest);
        if (parsed.length < 3) {
          return {
            type: 'handled',
            messages: ['用法: /schedule add "任务名称" "cron表达式" "目标描述"'],
          };
        }
        const [name, cron, goal] = parsed;

        // 校验 cron 表达式
        const validation = validateCron(cron);
        if (!validation.valid) {
          return {
            type: 'handled',
            messages: [`❌ cron 表达式无效: ${validation.error}`],
          };
        }

        const task: ScheduledTask = {
          id: generateId(),
          name,
          goal,
          cron,
          timezone: DEFAULT_TIMEZONE,
          enabled: true,
          nextRun: calcNextRun(cron, DEFAULT_TIMEZONE),
          runCount: 0,
          notifyOnComplete: true,
          createdAt: Date.now(),
        };
        store.add(task);
        return {
          type: 'handled',
          messages: [
            `✓ 定时任务已添加: ${task.id}`,
            `  名称: ${name}`,
            `  cron: ${cron}`,
            `  下次执行: ${formatNextRun(task)}`,
          ],
        };
      }

      case 'remove': {
        const id = rest.split(/\s+/)[0];
        if (!id) {
          return { type: 'handled', messages: ['用法: /schedule remove <id>'] };
        }
        const ok = store.remove(id);
        return {
          type: 'handled',
          messages: [ok ? `✓ 任务 ${id} 已删除` : `❌ 任务 ${id} 不存在`],
        };
      }

      case 'toggle': {
        const id = rest.split(/\s+/)[0];
        if (!id) {
          return { type: 'handled', messages: ['用法: /schedule toggle <id>'] };
        }
        const task = store.get(id);
        if (!task) {
          return { type: 'handled', messages: [`❌ 任务 ${id} 不存在`] };
        }
        const newEnabled = !task.enabled;
        const updates: Partial<ScheduledTask> = { enabled: newEnabled };
        // 重新启用时计算 nextRun
        if (newEnabled) {
          updates.nextRun = calcNextRun(task.cron, task.timezone);
        }
        store.update(id, updates);
        return {
          type: 'handled',
          messages: [`✓ 任务 ${id} 已${newEnabled ? '启用' : '禁用'}`],
        };
      }

      case 'run': {
        const id = rest.split(/\s+/)[0];
        if (!id) {
          return { type: 'handled', messages: ['用法: /schedule run <id>'] };
        }
        const task = store.get(id);
        if (!task) {
          return { type: 'handled', messages: [`❌ 任务 ${id} 不存在`] };
        }
        // 立即执行：通过 commandBridge 启动 goal
        ctx.commandBridge.startGoal(task.goal);
        // 更新执行计数（不改变 nextRun，让引擎按原计划继续）
        store.update(id, {
          lastRun: Date.now(),
          runCount: task.runCount + 1,
        });
        return {
          type: 'handled',
          messages: [`✓ 任务 ${id} 已手动触发: ${task.goal}`],
        };
      }

      case 'next': {
        const tasks = store.list();
        const enabled = tasks.filter((t) => t.enabled);
        if (enabled.length === 0) {
          return { type: 'handled', messages: ['（无启用的定时任务）'] };
        }
        const lines = [
          '## 下次执行时间',
          '',
          ...enabled.map((t) => `- ${t.name} (${t.id}): ${formatNextRun(t)}`),
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      default: {
        const lines = [
          '用法：/schedule <subcommand>',
          '',
          '  list                          — 列出所有定时任务',
          '  add "名称" "cron" "目标描述"   — 添加任务',
          '  remove <id>                   — 删除任务',
          '  toggle <id>                   — 启用/禁用任务',
          '  run <id>                      — 立即手动执行一次',
          '  next                          — 显示下次执行时间',
          '',
          '别名: /cron',
          '',
          'cron 表达式格式（5 字段）: 分 时 日 月 周',
          '  *         — 任意值',
          '  */15      — 每 15 分钟',
          '  1,3,5     — 列表',
          '  1-5       — 范围',
          '  0 8 * * * — 每天 8 点',
          '  0 0 1 * * — 每月 1 号',
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }
    }
  },
};
