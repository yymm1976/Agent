// src/agent/kernel.ts
// Phase 97 Part A：AgentKernel 内核接口抽象
//
// 设计目的：
//   为未来接入外部内核（Pi / Claude SDK）预留插槽。自研 ReActAgentLoop 作为
//   kernel A（routedev-native）先满足接口，上层（引擎桥、远程、子 Agent）只依赖
//   AgentKernel，不依赖具体循环实现。切换内核时消息持久化不丢（复用现有会话存储）。

import type { EngineEventV1 } from '../harness/event-types.js';
import type { AgentExecutionContext } from './execution-context.js';
import type { ReActRunParams } from './loop.js';
import type { ReActEvent } from './loop-config.js';

/** 内核会话状态快照 */
export interface KernelSessionState {
  sessionId: string;
  running: boolean;
  currentTurnId?: string;
  lastEventSequence: number;
  model?: string;
  error?: string;
}

/** Agent 内核接口 */
export interface AgentKernel {
  /** 内核标识：'routedev-native' | 'pi' | 'claude-sdk' */
  readonly id: string;
  /** 执行一次会话（用户输入 → 事件流），事件含完整生命周期与 sequence */
  run(ctx: AgentExecutionContext, input: string): AsyncIterable<EngineEventV1>;
  /** Native adapter path used by the desktop stream bridge while preserving ReAct events. */
  runReAct?(ctx: AgentExecutionContext, params: ReActRunParams): AsyncIterable<ReActEvent>;
  /** 中止指定会话 */
  abort(sessionId: string): Promise<void>;
  /** 读取会话当前状态（供 UI 重建与远程查询） */
  getSessionState(sessionId: string): KernelSessionState | null;
  /** 列出已登记过的会话 id（供状态聚合 / 全量中止遍历） */
  listSessions(): string[];
}

/** 会话级内核记录（持久化到会话元数据，切换内核时保留历史） */
export interface KernelBinding {
  sessionId: string;
  kernelId: string;
  switchedAt: number;
}
