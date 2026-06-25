// src/cli/components/MicroSummaryCard.tsx
// Phase 34 Task 2：微摘要卡片
// 成功时折叠过程 + 展示微摘要；失败时自动展开 + 高亮错误

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MicroSummary } from '../../agent/micro-summary.js';
import type { OutputStyle } from '../../config/schema.js';
import { getColor } from '../design-system.js';
import { formatElapsed } from './Spinner.js';

interface MicroSummaryCardProps {
  summary: MicroSummary;
  outputStyle?: OutputStyle;
  /** 初始折叠状态（失败时不折叠） */
  initiallyCollapsed?: boolean;
}

export function MicroSummaryCard({
  summary,
  outputStyle = 'standard',
  initiallyCollapsed,
}: MicroSummaryCardProps) {
  // 失败时默认展开；verbose 模式下也默认展开；其余按传入值或 true
  const defaultCollapsed =
    initiallyCollapsed ?? (summary.status === 'failure' || outputStyle === 'verbose' ? false : true);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useInput((char, _key) => {
    if (char === 'd' || char === 'D') {
      setCollapsed(prev => !prev);
    }
  });

  const statusIcon = summary.status === 'success' ? '✅' : summary.status === 'failure' ? '❌' : '⏸️';
  const statusColor = summary.status === 'success' ? 'green' : summary.status === 'failure' ? 'red' : 'yellow';
  const infoColor = getColor('info');

  const hasDetails = summary.keyDecisions.length > 0 || summary.fileChanges.length > 0;
  const durationText = summary.durationMs > 0 ? formatElapsed(Math.floor(summary.durationMs / 1000)) : '';
  const tokenText = summary.trajectory
    ? `${summary.trajectory.totalTokens} tokens`
    : '';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={statusColor} paddingX={1}>
      <Box>
        <Text color={statusColor} bold>{statusIcon} </Text>
        <Text bold>{summary.title}</Text>
      </Box>

      {/* 统计行：步骤 / 耗时 / token */}
      <Box>
        <Text color={infoColor}>
          {summary.stepCount} 步
          {durationText ? ` / ${durationText}` : ''}
          {tokenText ? ` / ${tokenText}` : ''}
        </Text>
      </Box>

      {/* 展开详情 */}
      {!collapsed && hasDetails && (
        <Box flexDirection="column" marginTop={1}>
          {summary.keyDecisions.length > 0 && (
            <Box flexDirection="column">
              <Text color={infoColor} dimColor>关键决策：</Text>
              {summary.keyDecisions.map((decision, idx) => (
                <Text key={idx} color="gray">  • {decision}</Text>
              ))}
            </Box>
          )}

          {summary.fileChanges.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={infoColor} dimColor>文件变更：</Text>
              {summary.fileChanges.map((change, idx) => (
                <Text key={idx} color="gray">
                  {'  '}• {change.path}
                  {change.added > 0 && <Text color="green"> +{change.added}</Text>}
                  {change.removed > 0 && <Text color="red"> -{change.removed}</Text>}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {hasDetails && (
        <Box marginTop={1}>
          <Text color={infoColor} dimColor>
            {collapsed ? '按 d 展开详情' : '按 d 折叠'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
