// src/cli/components/ChatView.tsx
// 对话视图组件：显示消息列表，支持流式输出
// Phase 24 Task 1：迁移到设计系统颜色语义
// Phase 34 Task 2/3：支持折叠组、微摘要、工具执行 Spinner
// Phase 50 Task 7：接入 DisclosureLevel 渐进披露容器

import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../../router/types.js';
import { getColor, type SemanticColor } from '../design-system.js';
import { Spinner } from './Spinner.js';
import type { OutputStyle } from '../../config/schema.js';
import type { MicroSummary } from '../../agent/micro-summary.js';
import { MicroSummaryCard } from './MicroSummaryCard.js';
import { DisclosureLevel, type DisclosureContent } from './DisclosureLevel.js';

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tier?: ScenarioTier;
  modelId?: string;
  isStreaming?: boolean;
  /** Phase 34 Task 3：是否为正在执行中的工具/任务消息 */
  isPending?: boolean;
  /** Phase 34 Task 3：任务开始时间戳（用于计时器） */
  pendingSince?: number;
  /** Phase 34 Task 2：微摘要数据（仅 system 消息可能携带） */
  microSummary?: MicroSummary;
  /** Phase 34 Task 2：当前消息是否处于折叠状态（受 outputStyle 影响） */
  collapsed?: boolean;
}

interface ChatViewProps {
  messages: ChatMessage[];
  /** Phase 34：当前输出样式，控制信息密度 */
  outputStyle?: OutputStyle;
  /** Phase 50 Task 7：是否启用 DisclosureLevel 渐进披露（默认 false 保持向后兼容） */
  enableDisclosure?: boolean;
}

/** 消息角色对应的语义颜色 */
function roleSemanticColor(role: string): SemanticColor {
  switch (role) {
    case 'user': return 'success';
    case 'assistant': return 'primary';
    case 'system': return 'info';
    default: return 'info';
  }
}

/** 消息角色标签 */
function roleLabel(role: string): string {
  switch (role) {
    case 'user': return '你';
    case 'assistant': return 'AI';
    case 'system': return '系统';
    default: return role;
  }
}

/**
 * Phase 50 Task 7：将消息内容转换为 DisclosureContent
 * - L1：首行摘要（前 80 字符）
 * - L2：前 3 行
 * - L3：完整内容
 */
function toDisclosureContent(content: string): DisclosureContent {
  const lines = content.split('\n').filter(Boolean);
  const firstLine = lines[0] ?? content;
  const l1 = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
  const l2 = lines.slice(0, 3).join('\n');
  return { l1, l2, l3: content };
}

export function ChatView({ messages, outputStyle = 'standard', enableDisclosure = false }: ChatViewProps) {
  const infoColor = getColor('info');

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          {/* Phase 34 Task 2：微摘要卡片优先渲染 */}
          {msg.microSummary ? (
            <MicroSummaryCard
              summary={msg.microSummary}
              outputStyle={outputStyle}
              initiallyCollapsed={msg.collapsed}
            />
          ) : (
            <>
              <Box>
                <Text color={getColor(roleSemanticColor(msg.role))} bold>{roleLabel(msg.role)}: </Text>
                {msg.tier && (
                  <Text color={infoColor} dimColor>[{msg.tier}] </Text>
                )}
                {msg.modelId && (
                  <Text color={infoColor} dimColor>({msg.modelId}) </Text>
                )}
              </Box>
              <Box paddingLeft={2}>
                {msg.isPending ? (
                  <Text wrap="wrap">
                    <Spinner startTime={msg.pendingSince} />
                  </Text>
                ) : enableDisclosure && msg.role === 'system' && msg.content.length > 200 ? (
                  // Phase 50 Task 7：长系统消息用 DisclosureLevel 包裹，按需展开
                  <DisclosureLevel
                    content={toDisclosureContent(msg.content)}
                    outputStyle={outputStyle}
                  />
                ) : (
                  <Text wrap="wrap">
                    {msg.content}
                    {msg.isStreaming && <Text color={infoColor}> ▌</Text>}
                  </Text>
                )}
              </Box>
            </>
          )}
        </Box>
      ))}
    </Box>
  );
}
