// desktop/main/agent-status-service.ts
// Phase 97 Part H：常驻 Agent Island 状态聚合服务
//
// 设计目的（借鉴 Proma Agent Island）：
//   主进程成为 Agent 运行状态的唯一权威源，聚合：
//     - running：运行中的会话（来自 subagentRegistry 或显式标记）
//     - waiting_interruption：等待用户处理中断的会话（来自 InterruptionBroker）
//     - completed / error：会话结束状态（显式标记）
//   状态快照按 sessionId 持久化，重启后可从快照重建 UI 状态（renderer 不做二次推导）。
//
// 约束：
//   - 纯内存 + 可选文件持久化；未注入数据源时返回内存视图
//   - 所有读取 fail-open，异常不阻塞 UI
//   - 数据源为 duck-typed 接口，便于测试注入

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../src/utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** Agent 运行状态（唯一权威枚举） */
export type AgentRunStatus = 'running' | 'waiting_interruption' | 'completed' | 'error';

/** 单个 session 的状态记录 */
export interface AgentStatusRecord {
  /** 会话 ID（主对话 sessionId / 子会话 childSessionId） */
  sessionId: string;
  /** 运行状态 */
  status: AgentRunStatus;
  /** 展示标题（子会话 description 或用户消息摘要） */
  title: string;
  /** 中断队列计数（waiting_interruption 时 >0） */
  interruptionCount: number;
  /** 开始时间戳 */
  startedAt: number;
  /** 最近更新时间戳 */
  updatedAt: number;
  /** 错误信息（status=error 时填写） */
  error?: string;
}

/** 聚合快照（IPC 传输 + 持久化载荷） */
export interface AgentStatusSnapshot {
  /** 全部 session 状态（按 startedAt 降序） */
  sessions: AgentStatusRecord[];
  /** 快照生成时间（ISO 8601） */
  updatedAt: string;
}

/** 持久化文件结构（含版本号，便于迁移） */
interface AgentStatusFile {
  version: 1;
  sessions: AgentStatusRecord[];
  savedAt: string;
}

// ============================================================
// 数据源依赖（duck-typed，便于测试注入）
// ============================================================

/** subagentRegistry 只读视图（子会话可见性） */
export interface AgentStatusSubagentSource {
  list(): Array<{ childSessionId: string; status: string; description: string; createdAt: number }>;
}

/** InterruptionBroker 只读视图（中断队列） */
export interface AgentStatusInterruptionSource {
  list(): Array<{ sessionId: string; status: string }>;
}

/** AgentKernel 只读视图（内核会话状态——Phase 97 Part A Task A3 消费点） */
export interface AgentStatusKernelSource {
  listSessions(): string[];
  getSessionState(sessionId: string): import('../../src/agent/kernel.js').KernelSessionState | null;
}

// ============================================================
// 常量
// ============================================================

/** 默认持久化文件名（位于 <cwd>/.routedev/ 下） */
const DEFAULT_FILE_NAME = 'agent-status.json';

// ============================================================
// AgentStatusService
// ============================================================

/**
 * Agent 状态聚合服务（主进程单例）
 *
 * 能力：
 *   - upsert：显式更新某 session 状态（sendChat 开始/结束、子会话登记时调用）
 *   - markRunning / markCompleted / markError / markInterruption：便捷更新
 *   - getSnapshot：聚合内存状态 + 数据源（subagentRegistry / interruptionBroker）
 *   - persist / restore：按 sessionId 持久化与重建
 *
 * 数据源规则：
 *   - 中断队列计数：从 interruptionSource.list() 按 sessionId 统计 pending 中断数，
 *     该 session 存在 pending 中断时状态覆盖为 waiting_interruption
 *   - 子会话：从 subagentSource.list() 提取 running 子会话为独立记录
 */
export class AgentStatusService {
  private readonly records = new Map<string, AgentStatusRecord>();
  /** 持久化文件路径（未设置时不持久化，仅内存） */
  private readonly persistPath?: string;

  constructor(
    private sources?: {
      subagent?: AgentStatusSubagentSource;
      interruption?: AgentStatusInterruptionSource;
      kernel?: AgentStatusKernelSource;
    },
    options?: { persistPath?: string },
  ) {
    this.persistPath = options?.persistPath;
  }

  // ===== 更新 API =====

  /** 运行时注入数据源（deps 就绪后调用；可重复设置覆盖） */
  setSources(sources?: {
    subagent?: AgentStatusSubagentSource;
    interruption?: AgentStatusInterruptionSource;
    kernel?: AgentStatusKernelSource;
  }): void {
    this.sources = sources;
  }

  /** 创建或更新一个 session 状态记录 */
  upsert(
    sessionId: string,
    patch: Partial<Pick<AgentStatusRecord, 'status' | 'title' | 'error'>> & { startedAt?: number },
  ): void {
    try {
      const now = Date.now();
      const existing = this.records.get(sessionId);
      this.records.set(sessionId, {
        sessionId,
        status: patch.status ?? existing?.status ?? 'running',
        title: patch.title ?? existing?.title ?? sessionId,
        interruptionCount: existing?.interruptionCount ?? 0,
        startedAt: patch.startedAt ?? existing?.startedAt ?? now,
        updatedAt: now,
        error: patch.error !== undefined ? patch.error : existing?.error,
      });
    } catch (err) {
      logger.debug('AgentStatusService.upsert failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 标记 session 为运行中 */
  markRunning(sessionId: string, title?: string): void {
    this.upsert(sessionId, { status: 'running', title });
  }

  /** 标记 session 已完成 */
  markCompleted(sessionId: string, title?: string): void {
    this.upsert(sessionId, { status: 'completed', title, error: undefined });
  }

  /** 标记 session 出错 */
  markError(sessionId: string, error: string, title?: string): void {
    this.upsert(sessionId, { status: 'error', error, title });
  }

  /** 标记 session 进入等待中断状态（中断提交/解析时调用） */
  markInterruption(sessionId: string, pendingCount: number): void {
    try {
      const now = Date.now();
      const existing = this.records.get(sessionId);
      this.records.set(sessionId, {
        sessionId,
        // pendingCount 清零 = 中断已处理，会话回到运行中
        status: pendingCount > 0 ? 'waiting_interruption' : 'running',
        title: existing?.title ?? sessionId,
        interruptionCount: pendingCount,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        error: existing?.error,
      });
    } catch (err) {
      logger.debug('AgentStatusService.markInterruption failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 删除一个 session 记录（会话清理时调用） */
  remove(sessionId: string): void {
    this.records.delete(sessionId);
  }

  // ===== 查询 API =====

  /**
   * 生成聚合快照
   *
   * 合并顺序：
   *   1. 内存显式记录（sendChat / 子会话结束标记）
   *   2. interruptionSource：有 pending 中断的 session → waiting_interruption + 计数
   *   3. subagentSource：running 子会话 → 独立 running 记录（不重复覆盖主会话）
   *
   * fail-open：数据源抛错时仅返回内存记录。
   */
  getSnapshot(now: number = Date.now()): AgentStatusSnapshot {
    const merged = new Map<string, AgentStatusRecord>(this.records);

    // 中断队列：按 sessionId 统计 pending 中断数
    try {
      const pendingBySession = new Map<string, number>();
      for (const interruption of this.sources?.interruption?.list() ?? []) {
        if (interruption.status !== 'pending') continue;
        pendingBySession.set(
          interruption.sessionId,
          (pendingBySession.get(interruption.sessionId) ?? 0) + 1,
        );
      }
      for (const [sessionId, count] of pendingBySession) {
        const existing = merged.get(sessionId);
        merged.set(sessionId, {
          sessionId,
          status: 'waiting_interruption',
          title: existing?.title ?? sessionId,
          interruptionCount: count,
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
          error: existing?.error,
        });
      }
    } catch (err) {
      logger.debug('AgentStatusService: interruption source failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 子会话：running 子会话补充为独立记录（与主会话分开展示）
    try {
      for (const subagent of this.sources?.subagent?.list() ?? []) {
        if (subagent.status !== 'running') continue;
        if (!merged.has(subagent.childSessionId)) {
          merged.set(subagent.childSessionId, {
            sessionId: subagent.childSessionId,
            status: 'running',
            title: subagent.description || subagent.childSessionId,
            interruptionCount: 0,
            startedAt: subagent.createdAt,
            updatedAt: now,
          });
        }
      }
    } catch (err) {
      logger.debug('AgentStatusService: subagent source failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 内核：kernel 已登记会话补充为记录（Phase 97 Part A Task A3——getSessionState 生产消费点）
    // 仅补充运行中状态；终态（completed/error）由显式标记管理，避免覆盖 title/时间戳
    try {
      for (const sessionId of this.sources?.kernel?.listSessions() ?? []) {
        const state = this.sources?.kernel?.getSessionState(sessionId);
        if (!state || !state.running || merged.has(sessionId)) continue;
        merged.set(sessionId, {
          sessionId,
          status: 'running',
          title: sessionId,
          interruptionCount: 0,
          startedAt: now,
          updatedAt: now,
        });
      }
    } catch (err) {
      logger.debug('AgentStatusService: kernel source failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const sessions = [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
    return { sessions, updatedAt: new Date(now).toISOString() };
  }

  // ===== 持久化 =====

  /** 将当前快照持久化到文件（fail-open，失败仅记日志） */
  persist(now: number = Date.now()): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const payload: AgentStatusFile = {
        version: 1,
        sessions: this.getSnapshot(now).sessions,
        savedAt: new Date(now).toISOString(),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('AgentStatusService.persist failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从持久化快照恢复内存状态（重启后重建 UI 状态）
   *
   * 兼容规则：
   *   - 文件不存在 → 返回空快照（首次启动）
   *   - 版本不匹配 / JSON 损坏 → 清空并返回空快照
   *
   * @returns 恢复的快照；失败时为空快照
   */
  restore(): AgentStatusSnapshot {
    if (!this.persistPath) return { sessions: [], updatedAt: new Date().toISOString() };
    try {
      if (!fs.existsSync(this.persistPath)) {
        return { sessions: [], updatedAt: new Date().toISOString() };
      }
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const file = JSON.parse(raw) as AgentStatusFile;
      if (file.version !== 1 || !Array.isArray(file.sessions)) {
        logger.warn('AgentStatusService.restore: 版本不匹配或结构损坏，重置为空', {
          version: file.version,
        });
        return { sessions: [], updatedAt: new Date().toISOString() };
      }
      // 只恢复终态记录（running 状态重启后已失效，由运行时重新标记）
      const recoverable = file.sessions.filter((s) => s.status !== 'running');
      this.records.clear();
      for (const record of recoverable) {
        this.records.set(record.sessionId, record);
      }
      return { sessions: recoverable, updatedAt: file.savedAt ?? new Date().toISOString() };
    } catch (err) {
      logger.warn('AgentStatusService.restore failed, 重置为空 (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { sessions: [], updatedAt: new Date().toISOString() };
    }
  }

  /** 清空全部内存状态（销毁/重置时调用） */
  clear(): void {
    this.records.clear();
  }
}

/** 构造默认持久化路径（<cwd>/.routedev/agent-status.json） */
export function defaultAgentStatusPath(cwd: string): string {
  return path.join(cwd, '.routedev', DEFAULT_FILE_NAME);
}
