// src/cli/commands/schedule.ts
// /schedule 命令：定时任务管理
// Phase 37 Task 2：子命令 list / add / remove / toggle / run / next
// 任务持久化到 <cwd>/.routedev/schedule-tasks.json（与 ScheduleEngine 共享同一 store）
//
// Phase 53 接线修复：原实现使用 os.homedir()/.qoderwork/routedev/scheduled-tasks.json，
// 与 app-init.ts 中 ScheduleEngine 的 store 路径（<cwd>/.routedev/schedule-tasks.json）不一致，
// 导致命令侧增删改与引擎触发读不到同一份数据。现优先复用 ctx.scheduleEngine 实例，
// 其次按引擎同款路径创建 ScheduleStore，并使用 config.scheduler 的 defaultTimezone/maxTasks。

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import path from 'node:path';
import { ScheduleStore } from '../../scheduler/store.js';
import { ScheduleEngine } from '../../scheduler/engine.js';
import { validateCron } from '../../scheduler/cron-parser.js';
import type { ScheduledTask } from '../../scheduler/types.js';

/** 默认时区（当 config.scheduler.defaultTimezone 未配置时的兜底） */
const FALLBACK_TIMEZONE = 'Asia/Shanghai';

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

/** 生成任务 ID */
function generateId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取调度器实例：优先复用 ctx.scheduleEngine（与后台引擎同一 store），
 * 否则用与引擎一致的路径（<cwd>/.routedev/schedule-tasks.json）创建独立 store + engine。
 * 这样即便 ctx.scheduleEngine 未注入（如 CLI 直接调用），命令侧操作仍写入引擎会读取的文件。
 */
function getScheduler(ctx: ServiceContext): {
  engine: ScheduleEngine;
  timezone: string;
  maxTasks: number;
} {
  const timezone = ctx.config.scheduler?.defaultTimezone ?? FALLBACK_TIMEZONE;
  const maxTasks = ctx.config.scheduler?.maxTasks ?? 20;

  if (ctx.scheduleEngine) {
    return { engine: ctx.scheduleEngine, timezone, maxTasks };
  }

  // 兜底：按 app-init.ts 中 ScheduleEngine 同款路径创建 store + engine
  // 不调用 start()——只用于命令侧的增删改查，不重复触发定时器
  const storePath = path.join(ctx.cwd, '.routedev', 'schedule-tasks.json');
  const store = new ScheduleStore(storePath);
  const engine = new ScheduleEngine({
    store,
    onTaskTrigger: async () => {
      /* 命令侧 engine 不触发任务，触发由 ctx.scheduleEngine 负责 */
    },
  });
  return { engine, timezone, maxTasks };
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
    const { engine, timezone, maxTasks } = getScheduler(ctx);

    switch (sub) {
      case 'list': {
        const tasks = engine.list();
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

        // 校验任务数量上限（防止无限添加拖垮调度循环）
        const currentCount = engine.list().length;
        if (currentCount >= maxTasks) {
          return {
            type: 'handled',
            messages: [
              `❌ 已达到最大任务数 ${maxTasks}（当前 ${currentCount} 个）。` +
                `可在 config.scheduler.maxTasks 调整上限。`,
            ],
          };
        }

        // 由引擎统一计算 nextRun（与后台触发逻辑共用 getTimezoneOffsetMinutes/DST 修正）
        let nextRun: number | undefined;
        try {
          nextRun = engine.getNextRun(cron, timezone).getTime();
        } catch {
          nextRun = undefined;
        }

        const task: ScheduledTask = {
          id: generateId(),
          name,
          goal,
          cron,
          timezone,
          enabled: true,
          nextRun,
          runCount: 0,
          notifyOnComplete: true,
          createdAt: Date.now(),
        };
        engine.add(task);
        return {
          type: 'handled',
          messages: [
            `✓ 定时任务已添加: ${task.id}`,
            `  名称: ${name}`,
            `  cron: ${cron}`,
            `  时区: ${timezone}`,
            `  下次执行: ${formatNextRun(task)}`,
          ],
        };
      }

      case 'remove': {
        const id = rest.split(/\s+/)[0];
        if (!id) {
          return { type: 'handled', messages: ['用法: /schedule remove <id>'] };
        }
        engine.remove(id);
        return {
          type: 'handled',
          messages: [`✓ 任务 ${id} 已删除`],
        };
      }

      case 'toggle': {
        const id = rest.split(/\s+/)[0];
        if (!id) {
          return { type: 'handled', messages: ['用法: /schedule toggle <id>'] };
        }
        const task = engine.list().find((t) => t.id === id);
        if (!task) {
          return { type: 'handled', messages: [`❌ 任务 ${id} 不存在`] };
        }
        const newEnabled = !task.enabled;
        // 启用时由 engine.update 自动重算 nextRun；禁用时清空 nextRun
        const updates: Partial<ScheduledTask> = {
          enabled: newEnabled,
          nextRun: newEnabled ? engine.getNextRun(task.cron, task.timezone).getTime() : undefined,
        };
        engine.update(id, updates);
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
        const task = engine.list().find((t) => t.id === id);
        if (!task) {
          return { type: 'handled', messages: [`❌ 任务 ${id} 不存在`] };
        }
        // 立即执行：通过 commandBridge 启动 goal
        ctx.commandBridge.startGoal(task.goal);
        // 更新执行计数（不改变 nextRun，让引擎按原计划继续）
        engine.update(id, {
          lastRun: Date.now(),
          runCount: task.runCount + 1,
        });
        return {
          type: 'handled',
          messages: [`✓ 任务 ${id} 已手动触发: ${task.goal}`],
        };
      }

      case 'next': {
        const tasks = engine.list();
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
