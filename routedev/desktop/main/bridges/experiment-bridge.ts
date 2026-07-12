// desktop/main/bridges/experiment-bridge.ts
// Experiment 领域 delegate：负责实验分支的列表/采纳/丢弃/diff 查询
// 原 RouteDevEngine.listExperiments / adoptExperiment / discardExperiment / getExperimentDiff 委托至此。

import { ExperimentManager } from '../../../src/harness/experiment-manager.js';
import { logger } from '../../../src/utils/logger.js';
import type { ExperimentInfo } from '../../shared/ipc-types.js';
import type { EngineContext } from './engine-context.js';

/**
 * Experiment 领域桥接器
 *
 * 优先复用 AppDependencies.experimentManager 单例（含 ExperimentRunner 注入）；
 * 仅在引擎未初始化（deps === null）时回退到本地实例化（保持向后兼容）。
 * fail-open：底层模块调用失败时返回默认值，不抛异常。
 */
export class ExperimentBridge {
  constructor(private ctx: EngineContext) {}

  /** 列出所有实验分支 */
  listExperiments(): ExperimentInfo[] {
    try {
      const manager = this.ctx.deps?.experimentManager ?? new ExperimentManager(this.ctx.options.cwd);
      return manager.listExperiments() as unknown as ExperimentInfo[];
    } catch (err) {
      logger.warn('[ExperimentBridge] listExperiments failed', { err });
      return [];
    }
  }

  /** 采纳实验分支（合并到主分支） */
  async adoptExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const manager = this.ctx.deps?.experimentManager ?? new ExperimentManager(this.ctx.options.cwd);
      const result = await manager.adoptExperiment(id);
      return { success: result.success, error: result.success ? undefined : result.message };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 丢弃实验分支（删除 worktree 和分支） */
  async discardExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const manager = this.ctx.deps?.experimentManager ?? new ExperimentManager(this.ctx.options.cwd);
      await manager.discardExperiment(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 获取实验分支 diff */
  async getExperimentDiff(
    id: string,
  ): Promise<{ diff: string; filesChanged: number; error?: string }> {
    try {
      const manager = this.ctx.deps?.experimentManager ?? new ExperimentManager(this.ctx.options.cwd);
      const diff = await manager.getExperimentDiff(id);
      // 从 diff 内容统计变更文件数
      const filesChanged = (diff.match(/^diff --git/gm) || []).length;
      return { diff, filesChanged };
    } catch (err) {
      return { diff: '', filesChanged: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
