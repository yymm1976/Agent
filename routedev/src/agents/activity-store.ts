// src/agents/activity-store.ts
// Agent 活动面板——specialist 活动实时追踪
//
// 借鉴 ohmypi ActivityStore：三态机（start → update → finish），
// 事件推送（非轮询），active[] 与 recent[] 双列表，
// slice 防膨胀。适配 RouteDev 的 AgentRole 体系（researcher/executor/reviewer/custom）。
//
// 同时承载 Task 11 的 splitModelLabel：把 "openai-codex/gpt-5.4:high"
// 切为 { model: "gpt-5.4", thinking: "high" }，避免 UI 把 ":high" 误读为模型名一部分。

import type { AgentRole } from './profiles/types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// AgentActivityRecord
// ============================================================

/**
 * Agent 活动记录
 * 借鉴 ohmypi ActivityRecord，但适配 RouteDev 的角色体系
 */
export interface AgentActivityRecord {
  id: string;
  /** 血统链——如 "executor > researcher" */
  lineage: string;
  /** 委派深度 */
  depth: number;
  /** 角色 */
  role: AgentRole;
  /** 任务预览（截断 72 字符） */
  taskPreview: string;
  /** 状态 */
  status: 'running' | 'success' | 'error';
  /** 工具调用计数 */
  toolCallCount: number;
  /** 最近工具名 */
  lastToolName?: string;
  /** 最近工具描述 */
  lastToolDescription?: string;
  /** 模型 ID（纯名，不含 thinking 等级） */
  modelId?: string;
  /** thinking 等级（从 modelId 分离） */
  thinkingLevel?: string;
  /** 开始时间 */
  startedAt: number;
  /** 完成时间 */
  finishedAt?: number;
  /** 错误信息（status=error 时） */
  error?: string;
}

// ============================================================
// AgentActivityStore
// ============================================================

/** 默认最大同时显示活动数 */
const DEFAULT_MAX_ACTIVE = 4;
/** 默认最大历史记录数 */
const DEFAULT_MAX_RECENT = 3;
/** 默认任务预览截断长度 */
const DEFAULT_PREVIEW_LEN = 72;

/**
 * 活动存储——三态机
 * 借鉴 ohmypi createActivityStore
 *
 * 状态转换：startActivity → updateActivity → finishActivity
 * 完成后从 active[] 移到 recent[]（slice 防膨胀）
 * 通过 subscribe 事件推送更新（非轮询）
 */
export class AgentActivityStore {
  private active: AgentActivityRecord[] = [];
  private recent: AgentActivityRecord[] = [];
  private listeners: Set<(active: AgentActivityRecord[], recent: AgentActivityRecord[]) => void> = new Set();

  constructor(
    private maxActive: number = DEFAULT_MAX_ACTIVE,
    private maxRecent: number = DEFAULT_MAX_RECENT,
  ) {}

  /** 启动新活动：unshift 到 active[] 首位，超过 maxActive 截断 */
  startActivity(record: Omit<AgentActivityRecord, 'status' | 'toolCallCount' | 'startedAt'>): string {
    const full: AgentActivityRecord = {
      ...record,
      status: 'running',
      toolCallCount: 0,
      startedAt: Date.now(),
    };
    this.active.unshift(full);
    if (this.active.length > this.maxActive) {
      this.active = this.active.slice(0, this.maxActive);
    }
    this.notify();
    return full.id;
  }

  /** 原地更新（按 id 查找） */
  updateActivity(id: string, update: Partial<AgentActivityRecord>): void {
    const idx = this.active.findIndex((a) => a.id === id);
    if (idx >= 0) {
      this.active[idx] = { ...this.active[idx], ...update };
      this.notify();
    } else {
      logger.warn('activity-store: id 不存在', { id });
    }
  }

  /** 完成：从 active[] 移到 recent[] 且 slice 防膨胀 */
  finishActivity(id: string, status: 'success' | 'error', error?: string): void {
    const idx = this.active.findIndex((a) => a.id === id);
    if (idx >= 0) {
      const [record] = this.active.splice(idx, 1);
      record.status = status;
      record.finishedAt = Date.now();
      record.error = error;
      this.recent.unshift(record);
      if (this.recent.length > this.maxRecent) {
        this.recent = this.recent.slice(0, this.maxRecent);
      }
      this.notify();
    } else {
      logger.warn('activity-store: id 不存在', { id });
    }
  }

  /** 订阅更新（事件推送，非轮询）。返回取消订阅函数 */
  subscribe(listener: (active: AgentActivityRecord[], recent: AgentActivityRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 获取当前活跃列表（不可变副本） */
  getActive(): AgentActivityRecord[] {
    return [...this.active];
  }

  /** 获取最近完成列表（不可变副本） */
  getRecent(): AgentActivityRecord[] {
    return [...this.recent];
  }

  /** 清空所有记录 */
  clear(): void {
    this.active = [];
    this.recent = [];
    this.notify();
  }

  private notify(): void {
    // 传副本而非直接引用，防止 listener 修改内部状态
    const activeSnapshot = this.active.slice();
    const recentSnapshot = this.recent.slice();
    for (const listener of this.listeners) {
      try {
        listener(activeSnapshot, recentSnapshot);
      } catch (error) {
        logger.warn('activity-store: listener 抛错', { error });
      }
    }
  }
}

// ============================================================
// splitModelLabel（Task 11 核心）
// ============================================================

/** 合法的 thinking 等级 */
const THINKING_LEVELS = ['low', 'medium', 'high', 'auto'] as const;

/**
 * 模型标签分离——借鉴 ohmypi splitModelLabel
 *
 * 输入 `"openai-codex/gpt-5.4:high"` → `{ model: "gpt-5.4", thinking: "high" }`
 *
 * 规则：
 *   1. 找最后一个 `:`，判断后面是否是 low/medium/high/auto
 *   2. 若是 thinking 等级，去掉 provider 前缀（最后一个 `/` 之后）
 *   3. 若不是 thinking 等级，整体当模型名处理（仍去 provider 前缀）
 */
export function splitModelLabel(modelString: string): { model: string; thinking?: string } {
  if (!modelString) return { model: '' };

  const colonIdx = modelString.lastIndexOf(':');
  if (colonIdx > 0) {
    const thinking = modelString.slice(colonIdx + 1);
    const modelWithProvider = modelString.slice(0, colonIdx);
    if (THINKING_LEVELS.includes(thinking as typeof THINKING_LEVELS[number])) {
      const slashIdx = modelWithProvider.lastIndexOf('/');
      return {
        model: slashIdx >= 0 ? modelWithProvider.slice(slashIdx + 1) : modelWithProvider,
        thinking,
      };
    }
  }

  const slashIdx = modelString.lastIndexOf('/');
  return { model: slashIdx >= 0 ? modelString.slice(slashIdx + 1) : modelString };
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 截断任务预览
 * 超长时截断并加省略号，保证 UI 不会因长任务描述而拉伸
 */
export function truncatePreview(text: string, maxLen: number = DEFAULT_PREVIEW_LEN): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

/**
 * 构建血统链
 *
 * @param parentLineage 父 Agent 的 lineage（无父时传 undefined）
 * @param currentRole 当前 Agent 的角色
 * @returns 如 "executor > researcher"
 */
export function buildLineage(parentLineage: string | undefined, currentRole: AgentRole): string {
  if (!parentLineage) return currentRole;
  return `${parentLineage} > ${currentRole}`;
}
