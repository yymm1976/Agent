// src/cli/commands/experiment.ts
// 实验管理命令：/experiment create|list|run|compare|adopt|discard
// 基于 Git Worktree 的实验分支管理
//
// 子命令：
//   /experiment create <名称> [基于分支] — 创建实验
//   /experiment list — 列出实验
//   /experiment run <id> <任务描述> — 在实验分支上运行
//   /experiment compare <id-a> <id-b> — 对比两个实验
//   /experiment adopt <id> — 采纳（合并到当前分支）
//   /experiment discard <id> — 丢弃

import type { CommandDefinition } from '../command-registry.js';
// E9-B：移除 ExperimentManager 直接 import，改为从 ctx.experimentManager 复用单例
// 这样 ExperimentRunner 注入（app-init.ts 中 setExperimentRunner）才能在 /experiment run 路径生效

export const experimentCommand: CommandDefinition = {
  name: 'experiment',
  aliases: ['exp'],
  description: '实验分支管理（基于 Git Worktree）',
  usage:
    '/experiment create <名称> [基于分支] | list | run <id> <任务> | compare <id-a> <id-b> | adopt <id> | discard <id>',
  handler: async (args, ctx) => {
    const parts = args.split(/\s+/);
    const sub = parts[0] || '';

    // E9-B 修复：从 ServiceContext 读取单例，复用 app-init.ts 注入的 ExperimentRunner
    // 旧实现每次 new 一个新实例导致 runner 注入丢失，/experiment run 退化为仅记录任务描述
    const manager = ctx.experimentManager;

    switch (sub) {
      case 'create': {
        const name = parts[1];
        if (!name) {
          return {
            type: 'handled',
            messages: ['用法: /experiment create <名称> [基于分支]'],
          };
        }
        const baseBranch = parts[2];
        try {
          const exp = await manager.createExperiment(name, baseBranch);
          return {
            type: 'handled',
            messages: [
              `🧪 实验已创建: ${exp.id} (${exp.name})`,
              `  分支: ${exp.branch}`,
              `  工作树: ${exp.worktreePath}`,
              `  基础: ${exp.baseBranch} (${exp.baseCommit.slice(0, 7)})`,
            ],
          };
        } catch (error: any) {
          return {
            type: 'handled',
            messages: [`创建实验失败: ${error.message}`],
          };
        }
      }

      case 'list': {
        const experiments = manager.listExperiments();
        if (experiments.length === 0) {
          return {
            type: 'handled',
            messages: ['暂无实验。使用 /experiment create <名称> 创建。'],
          };
        }
        const lines = experiments.map((exp, i) => {
          const time = new Date(exp.createdAt).toLocaleString('zh-CN');
          const statusIcon =
            exp.status === 'active'
              ? '✓'
              : exp.status === 'adopted'
                ? '✓已采纳'
                : '✗已丢弃';
          return `  ${i + 1}. [${exp.id}] ${exp.name} [${statusIcon}]\n     分支: ${exp.branch} | 基础: ${exp.baseCommit.slice(0, 7)} | 创建: ${time} | 运行: ${exp.runCount}次`;
        });
        return {
          type: 'handled',
          messages: [`实验列表 (${experiments.length}):\n${lines.join('\n')}`],
        };
      }

      case 'run': {
        const expId = parts[1];
        const task = parts.slice(2).join(' ');
        if (!expId || !task) {
          return {
            type: 'handled',
            messages: ['用法: /experiment run <id> <任务描述>'],
          };
        }
        const result = await manager.runInExperiment(expId, task);
        return {
          type: 'handled',
          messages: [
            result.success ? `✓ ${result.result}` : `✗ ${result.result}`,
          ],
        };
      }

      case 'compare': {
        const idA = parts[1];
        const idB = parts[2];
        if (!idA || !idB) {
          return {
            type: 'handled',
            messages: ['用法: /experiment compare <id-a> <id-b>'],
          };
        }
        try {
          const diff = await manager.compareExperiments(idA, idB);
          const lines = [
            `📊 实验对比: ${diff.expA.id} vs ${diff.expB.id}`,
            `  变更文件: ${diff.filesChanged}`,
            `  新增行数: +${diff.additions}`,
            `  删除行数: -${diff.deletions}`,
            '',
            '差异摘要（前 100 行）:',
            diff.diffSummary || '（无差异）',
          ];
          return { type: 'handled', messages: [lines.join('\n')] };
        } catch (error: any) {
          return {
            type: 'handled',
            messages: [`对比失败: ${error.message}`],
          };
        }
      }

      case 'adopt': {
        const expId = parts[1];
        if (!expId) {
          return {
            type: 'handled',
            messages: ['用法: /experiment adopt <id>'],
          };
        }
        const result = await manager.adoptExperiment(expId);
        const suffix = result.conflict ? '（存在冲突）' : '';
        return {
          type: 'handled',
          messages: [
            result.success
              ? `✓ ${result.message}`
              : `✗ ${result.message}${suffix}`,
          ],
        };
      }

      case 'discard': {
        const expId = parts[1];
        if (!expId) {
          return {
            type: 'handled',
            messages: ['用法: /experiment discard <id>'],
          };
        }
        try {
          await manager.discardExperiment(expId);
          return {
            type: 'handled',
            messages: [
              `✓ 实验 ${expId} 已丢弃（worktree 和分支已清理）`,
            ],
          };
        } catch (error: any) {
          return {
            type: 'handled',
            messages: [`丢弃失败: ${error.message}`],
          };
        }
      }

      default:
        return {
          type: 'handled',
          messages: [
            '用法:',
            '  /experiment create <名称> [基于分支] — 创建实验',
            '  /experiment list — 列出实验',
            '  /experiment run <id> <任务描述> — 在实验分支上运行',
            '  /experiment compare <id-a> <id-b> — 对比两个实验',
            '  /experiment adopt <id> — 采纳（合并到当前分支）',
            '  /experiment discard <id> — 丢弃',
          ],
        };
    }
  },
};
