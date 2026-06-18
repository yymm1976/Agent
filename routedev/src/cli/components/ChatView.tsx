// src/cli/components/ChatView.tsx
// 对话视图组件：显示消息列表，支持流式输出
// Phase 24 Task 1：迁移到设计系统颜色语义

import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../../router/types.js';
import { getColor, type SemanticColor } from '../design-system.js';

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tier?: ScenarioTier;
  modelId?: string;
  isStreaming?: boolean;
}

interface ChatViewProps {
  messages: ChatMessage[];
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

export function ChatView({ messages }: ChatViewProps) {
  const infoColor = getColor('info');

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
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
            <Text wrap="wrap">
              {msg.content}
              {msg.isStreaming && <Text color={infoColor}> ▌</Text>}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
