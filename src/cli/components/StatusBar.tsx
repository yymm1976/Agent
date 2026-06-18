// src/cli/components/StatusBar.tsx
// 状态栏组件：显示当前模型、场景等级、Token 消耗、降级状态

import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../../router/types.js';

interface StatusBarProps {
  currentModel: string;
  currentTier: ScenarioTier;
  isDegraded: boolean;
  todayTokensUsed: number;
  autonomyMode: string;
  workMode: string;
}

/** 场景等级的颜色 */
function tierColor(tier: ScenarioTier): string {
  switch (tier) {
    case 'simple': return 'green';
    case 'medium': return 'yellow';
    case 'complex': return 'magenta';
    case 'reasoning': return 'cyan';
    default: return 'white';
  }
}

/** 场景等级的标签 */
function tierLabel(tier: ScenarioTier): string {
  switch (tier) {
    case 'simple': return '简单';
    case 'medium': return '中等';
    case 'complex': return '复杂';
    case 'reasoning': return '推理';
    default: return tier;
  }
}

/** 格式化 Token 数量 */
function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

export function StatusBar({
  currentModel,
  currentTier,
  isDegraded,
  todayTokensUsed,
  autonomyMode,
  workMode,
}: StatusBarProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="gray">模型: </Text>
        <Text bold>{currentModel}</Text>
        <Text color="gray"> │ </Text>
        <Text color={tierColor(currentTier)} bold>[{tierLabel(currentTier)}]</Text>
        {isDegraded && <Text color="red"> ⚠ 已降级</Text>}
        <Text color="gray"> │ </Text>
        <Text color="gray">Token: </Text>
        <Text>{formatTokenCount(todayTokensUsed)}</Text>
        <Text color="gray"> │ </Text>
        <Text color="gray">自主: </Text>
        <Text>{autonomyMode}</Text>
        <Text color="gray"> │ </Text>
        <Text color="gray">模式: </Text>
        <Text>{workMode}</Text>
      </Box>
    </Box>
  );
}
