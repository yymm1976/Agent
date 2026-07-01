// src/agents/subagent-session.ts
// 子 Agent 独立会话作用域
// Phase 51 Task 4：call-scoped overlay——借鉴 Flue 的 detached child session 模型
//
// 核心原则：
//   1. 子 Agent 的角色指令不注入父 history
//   2. 子 Agent 的对话历史也不回流父上下文
//   3. 仅最终答案文本返回给父会话
//
// 借鉴 Flue session.ts:161 的 MAX_DELEGATION_DEPTH=4 限制与
// harness.ts:155-159 的存储键三元组（instanceId/harnessName/sessionName）。

import type { AgentProfile, AgentRole } from './profiles/types.js';

/**
 * 子 Agent 独立会话作用域
 *
 * 与父会话完全隔离：
 *   - sessionId 独立生成（不与父共享）
 *   - systemPrompt 由 AgentProfile 重新构建，不从父继承
 *   - messageHistory 从空数组开始，不回流父上下文
 */
export interface SubAgentSessionScope {
  /** 会话 ID（独立于父会话，格式 `sub-<timestamp>-<rand>`） */
  sessionId: string;
  /** 父会话 ID（用于溯源） */
  parentSessionId: string;
  /** 子 Agent 角色 */
  role: AgentRole;
  /** 独立 system prompt（由 AgentProfile.systemPrompt 构建，不从父继承） */
  systemPrompt: string;
  /** 独立消息历史（不回流父上下文），用 unknown 避免依赖具体 Message 类型 */
  messageHistory: unknown[];
  /** 委派深度（0=主 Agent，1=子 Agent，2=孙 Agent） */
  depth: number;
  /** 存储键三元组（借鉴 Flue createSessionStorageKey） */
  storageKey: { instanceId: string; harnessName: string; sessionName: string };
  /** 创建时间 */
  createdAt: number;
  /** 终止时间（由调用方在会话结束时写入） */
  completedAt?: number;
}

/**
 * 创建子 Agent 独立会话
 *
 * 借鉴 Flue 的 createTaskSession：
 *   - sessionId 形如 `sub-<timestamp>-<rand>`
 *   - sessionName 形如 `task:<parentSessionId>:<sessionId>`，作为存储键的尾段
 *   - systemPrompt 直接取自 profile.systemPrompt，不从父继承
 *   - messageHistory 初始化为空数组
 *
 * @param parentSessionId 父会话 ID
 * @param role 子 Agent 角色
 * @param profile 子 Agent 契约 Profile
 * @param depth 委派深度（主 Agent 派发时传 1）
 * @param parentStorageKey 父会话的存储键前两段（instanceId/harnessName），缺省时填 'default'
 */
export function createSubAgentSession(
  parentSessionId: string,
  role: AgentRole,
  profile: AgentProfile,
  depth: number,
  parentStorageKey?: { instanceId: string; harnessName: string },
): SubAgentSessionScope {
  const sessionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionName = `task:${parentSessionId}:${sessionId}`;

  return {
    sessionId,
    parentSessionId,
    role,
    // system prompt 由 profile 构建，不从父继承
    systemPrompt: profile.systemPrompt,
    // 独立空历史——不回流父上下文
    messageHistory: [],
    depth,
    // 存储键三元组（借鉴 Flue）
    storageKey: {
      instanceId: parentStorageKey?.instanceId ?? 'default',
      harnessName: parentStorageKey?.harnessName ?? 'default',
      sessionName,
    },
    createdAt: Date.now(),
  };
}

/**
 * 提取子 Agent 最终答案——仅文本，不含中间过程
 *
 * 借鉴 Flue "仅把 taskResult.text 返回给父会话" 的设计：
 * 取最后一条 role='assistant' 消息的文本内容。
 *
 * 由于 messageHistory 使用 unknown[] 避免循环依赖，
 * 此函数对消息形状做最小运行时探测：
 *   - 优先读取 m.content（string）
 *   - 兼容 m.content 为数组时取第一段文本
 *
 * @returns 提取到的文本；若无 assistant 消息则返回空字符串
 */
export function extractFinalAnswer(scope: SubAgentSessionScope): string {
  const lastAssistant = [...scope.messageHistory]
    .reverse()
    .find((m) => isAssistantMessage(m));
  if (!lastAssistant) return '';
  return extractText(lastAssistant);
}

/**
 * 判断会话是否已过期
 *
 * @param scope 子 Agent 会话作用域
 * @param maxAgeMs 最大存活时长（毫秒）
 * @returns 创建时间距今超过 maxAgeMs 时返回 true
 */
export function isSessionExpired(scope: SubAgentSessionScope, maxAgeMs: number): boolean {
  return Date.now() - scope.createdAt > maxAgeMs;
}

// ============================================================
// 内部辅助：最小运行时探测（避免依赖具体 Message 类型）
// ============================================================

/** 形状探测：是否像 assistant 消息 */
function isAssistantMessage(m: unknown): boolean {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { role?: unknown }).role === 'assistant'
  );
}

/** 从消息体中尽量取出文本内容（兼容 string / string[] / {text:string}[]） */
function extractText(m: unknown): string {
  if (m == null || typeof m !== 'object') return '';
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return '';
}
