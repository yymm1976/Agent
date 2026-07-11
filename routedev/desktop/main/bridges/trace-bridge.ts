// desktop/main/bridges/trace-bridge.ts
// Checkpoint + Trace 领域 delegate：负责检查点管理与运行回放/评分卡
// G-022a：从 engine-bridge.ts 拆分。原 RouteDevEngine 的 listCheckpoints/rollbackCheckpoint/
// listTraceSessions/replayTrace/generateTraceScorecard 委托至此。
// 两者均属于 harness 层且方法量较少，合并为一个 bridge 避免文件过小。
// fail-open：引擎未初始化或底层调用失败时返回空数组/null。

import type { Checkpoint } from '../../../src/harness/types.js';
// Phase 77：运行回放与评分卡——借鉴 HomeRail 的 hr replay / hr scorecard
import type { TraceSession } from '../../../src/harness/trace-types.js';
import { TraceReplayer, type TimelineEvent } from '../../../src/harness/trace-replayer.js';
import { generateScorecard, type Scorecard } from '../../../src/harness/scorecard.js';
import type { EngineContext } from './engine-context.js';

/**
 * Checkpoint + Trace 领域桥接器
 *
 * 提供检查点列表/回滚与 Trace 会话列表/回放/评分卡功能。
 * 两者均属于 harness 层，合并为一个 bridge 避免文件过小。
 * fail-open：引擎未初始化或底层调用失败时返回空数组/null。
 */
export class TraceBridge {
  constructor(private ctx: EngineContext) {}

  // ============================================================
  // Checkpoint（Phase 47 Task 6：检查点时间轴与语义化摘要）
  // ============================================================

  /**
   * 列出当前项目的所有检查点
   * @param projectId 项目 ID（当前未使用，CheckpointManager 已按工作目录隔离）
   * @returns 检查点列表（按创建时间升序，IPC 传输用，剥离 gitCommitHash 等内部字段）
   */
  listCheckpoints(projectId?: string): Checkpoint[] {
    if (!this.ctx.deps) return [];
    try {
      return this.ctx.deps.checkpointManager.list();
    } catch (err) {
      console.error('[Engine] listCheckpoints failed:', err);
      return [];
    }
  }

  /**
   * 回滚到指定检查点
   * 注意：这是破坏性操作（git reset --hard），调用方（UI）必须在执行前获得用户确认
   * @param checkpointId 检查点 ID
   * @returns 回滚结果
   */
  async rollbackCheckpoint(checkpointId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      const ok = await this.ctx.deps.checkpointManager.rollback(checkpointId);
      return { success: ok, error: ok ? undefined : '回滚失败（检查点不存在或工作区有未提交更改）' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Trace（Phase 77：运行回放与评分卡——委托 TraceCollector + TraceReplayer + scorecard）
  // ============================================================

  /** 列出磁盘上的 Trace 会话（按 startTime 倒序） */
  async listTraceSessions(limit?: number): Promise<TraceSession[]> {
    if (!this.ctx.deps) return [];
    try {
      return await this.ctx.deps.trace.listSessions(limit);
    } catch (err) {
      console.error('[Engine] listTraceSessions failed:', err);
      return [];
    }
  }

  /** 回放指定会话，返回时间线事件；传入 step 时仅返回该步骤段落 */
  // Phase 81 Task 4：packs.harness.enabled 门控（standard-pack，默认 false 退出装配）
  //   未启用时直接返回空数组；enabled:true 恢复 TraceReplayer 装配
  async replayTrace(sessionId: string, step?: number): Promise<TimelineEvent[]> {
    if (!this.ctx.deps) return [];
    if (!this.ctx.config.packs?.harness?.enabled) return [];
    try {
      const replayer = new TraceReplayer(this.ctx.deps.trace);
      return await replayer.replay(sessionId, step !== undefined ? { step } : undefined);
    } catch (err) {
      console.error('[Engine] replayTrace failed:', err);
      return [];
    }
  }

  /** 生成指定会话的评分卡 */
  // Phase 81 Task 4：packs.harness.enabled 门控（standard-pack，默认 false 退出装配）
  async generateTraceScorecard(sessionId: string): Promise<Scorecard | null> {
    if (!this.ctx.deps) return null;
    if (!this.ctx.config.packs?.harness?.enabled) return null;
    try {
      return await generateScorecard(this.ctx.deps.trace, sessionId);
    } catch (err) {
      console.error('[Engine] generateTraceScorecard failed:', err);
      return null;
    }
  }
}
