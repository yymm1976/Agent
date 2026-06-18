// src/cli/components/ChatView.tsx
// 对话视图组件：显示消息列表，支持流式输出

import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../../router/types.js';

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

/** 消息角色颜色 */
function roleColor(role: string): string {
  switch (role) {
    case 'user': return 'green';
    case 'assistant': return 'white';
    case 'system': return 'gray';
    default: return 'white';
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
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={roleColor(msg.role)} bold>{roleLabel(msg.role)}: </Text>
            {msg.tier && (
              <Text color="gray" dimColor>[{msg.tier}] </Text>
            )}
            {msg.modelId && (
              <Text color="gray" dimColor>({msg.modelId}) </Text>
            )}
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">
              {msg.content}
              {msg.isStreaming && <Text color="gray"> ▌</Text>}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
