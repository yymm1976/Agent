// src/agent/message-types.ts
// Phase 73 Part A：AgentMessage 消息抽象层
//
// 设计目的：
//   把"循环内部的消息"与"LLM 能理解的消息"解耦。循环可以承载任意自定义消息
//   （如 plan 状态、memory 片段、tool 元信息等），只在调用 LLM 边界通过 convertToLlm
//   过滤为标准 LLMMessage。插件通过 declaration merging 扩展 CustomAgentMessages
//   即可向循环注入自定义消息类型，无需改动 Loop 核心代码。
//
// Phase 73 Part C：新增 steering / follow_up 自定义消息类型
//   - steering：用户在 Agent 工作期间排队的中断指令（已由 task-orchestrator 持有，
//     此处仅给出类型定义供 convertToLlm 识别）
//   - follow_up：Agent 完成当前工作后排队执行的后续任务（由 ReActAgentLoop 持有）

import type { LLMMessage } from '../router/types.js';

/** 自定义 Agent 消息类型接口，插件通过 declaration merging 扩展 */
export interface CustomAgentMessages {}

/** Agent 消息 = 标准 LLM 消息 + 自定义消息类型 */
export type AgentMessage = LLMMessage | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * steering 转向消息——用户在 Agent 工作期间排队的中断指令
 *
 * 实际队列状态由 TaskOrchestrator 持有，Loop 通过 setSteeringConsumer 消费。
 * 此类型用于 declaration merging 注册到 CustomAgentMessages，
 * 让 defaultConvertToLlm 能识别并转为 user 消息注入 LLM。
 */
export interface SteeringMessage {
  role: 'steering';
  content: string;
  enqueuedAt: number;
  mode: 'immediate' | 'next_iteration' | 'after_current_step';
}

/**
 * follow-up 后续消息——Agent 完成当前工作后排队执行的后续任务
 *
 * 队列状态由 ReActAgentLoop.followUpQueue 持有。Loop 内层 ReAct 循环自然退出时，
 * 外层循环会取出 follow-up 消息注入到 messages 并重新进入内层循环。
 * 此类型用于 declaration merging 注册到 CustomAgentMessages，
 * 让 defaultConvertToLlm 能识别并转为 user 消息注入 LLM。
 */
export interface FollowUpMessage {
  role: 'follow_up';
  content: string;
  enqueuedAt: number;
}

// Phase 73 Part C：通过 declaration merging 把 steering / follow_up 注册到自定义消息类型
// 注册后 AgentMessage 联合类型自动包含这两种 role，convertToLlm 可基于 role 字段识别并转换
declare module './message-types' {
  interface CustomAgentMessages {
    steering: SteeringMessage;
    follow_up: FollowUpMessage;
  }
}

/**
 * 默认 convertToLlm：把 AgentMessage[] 过滤为 LLM 能理解的 LLMMessage[]
 *
 * 转换规则：
 *   - user / assistant / system：原样保留
 *   - steering：转为 user 消息，内容前缀 `[用户转向指令]`，让 LLM 知悉这是用户中途插入的指令
 *   - follow_up：转为 user 消息，内容前缀 `[后续任务]`，让 LLM 知悉这是上一个任务完成后接续的新任务
 *   - 其他未知 role：过滤掉（由插件注册自定义 convertToLlm 处理）
 */
export function defaultConvertToLlm(messages: AgentMessage[]): LLMMessage[] {
  return messages.flatMap(m => {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') return [m];
    if (m.role === 'steering') {
      return [{ role: 'user' as const, content: `[用户转向指令] ${m.content}` }];
    }
    if (m.role === 'follow_up') {
      return [{ role: 'user' as const, content: `[后续任务] ${m.content}` }];
    }
    return [];
  });
}
