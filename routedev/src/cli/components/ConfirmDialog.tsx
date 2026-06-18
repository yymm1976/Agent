// src/cli/components/ConfirmDialog.tsx
// 确认对话框：权限确认、安全确认的可视化实现（Phase 25 Task 2）
// 支持键盘快捷键、超时自动拒绝、详情展开

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getColor, type SemanticColor } from '../design-system.js';

// ============================================================
// 类型定义
// ============================================================

export interface ConfirmDialogProps {
  /** 操作描述（如 "删除文件 src/old-module.ts"） */
  operation: string;
  /** 影响说明 */
  impact: string;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
  /** 详情（可选，用于展开模式） */
  detail?: string;
  /** 超时时间（毫秒，默认 30 秒） */
  timeoutMs?: number;
  /** 确认回调 */
  onConfirm: () => void;
  /** 拒绝回调 */
  onDeny: () => void;
}

// ============================================================
// 辅助函数
// ============================================================

/** 风险等级 → 中文标签 */
export function riskLabel(risk: ConfirmDialogProps['riskLevel']): string {
  switch (risk) {
    case 'low': return '低';
    case 'medium': return '中等';
    case 'high': return '高';
    default: return '未知';
  }
}

/** 风险等级 → 语义颜色 */
export function riskColor(risk: ConfirmDialogProps['riskLevel']): SemanticColor {
  switch (risk) {
    case 'low': return 'success';
    case 'medium': return 'warning';
    case 'high': return 'error';
    default: return 'info';
  }
}

/** 格式化剩余秒数 */
export function formatRemainingSeconds(ms: number): string {
  return Math.max(0, Math.ceil(ms / 1000)).toString();
}

// ============================================================
// Ink 组件
// ============================================================

/** ConfirmDialog：安全确认对话框 */
export function ConfirmDialog({
  operation,
  impact,
  riskLevel,
  detail,
  timeoutMs = 30000,
  onConfirm,
  onDeny,
}: ConfirmDialogProps) {
  const [remainingMs, setRemainingMs] = useState(timeoutMs);
  const [showDetail, setShowDetail] = useState(false);

  // 倒计时：超时自动拒绝
  useEffect(() => {
    if (remainingMs <= 0) {
      onDeny();
      return;
    }
    const timer = setTimeout(() => {
      setRemainingMs(prev => Math.max(0, prev - 1000));
    }, 1000);
    return () => clearTimeout(timer);
  }, [remainingMs, onDeny]);

  useInput((char, key) => {
    if (char === 'y' || char === 'Y') {
      onConfirm();
      return;
    }
    if (char === 'n' || char === 'N') {
      onDeny();
      return;
    }
    if (char === 'd' || char === 'D') {
      setShowDetail(prev => !prev);
      return;
    }
    if (key.escape) {
      onDeny();
    }
  });

  const riskC = riskColor(riskLevel);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={getColor(riskC)} paddingX={1}>
      <Box>
        <Text color={getColor(riskC)} bold>⚠️  确认操作</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={getColor('info')}>操作: </Text>
        <Text>{operation}</Text>
      </Box>
      <Box>
        <Text color={getColor('info')}>影响: </Text>
        <Text>{impact}</Text>
      </Box>
      <Box>
        <Text color={getColor('info')}>风险: </Text>
        <Text color={getColor(riskC)} bold>{riskLabel(riskLevel)}</Text>
      </Box>

      <Box marginTop={1}>
        <Text backgroundColor={getColor('success')} color="black"> [Y] 确认 </Text>
        <Text>  </Text>
        <Text backgroundColor={getColor('error')} color="black"> [N] 拒绝 </Text>
        <Text>  </Text>
        {detail && (
          <Text backgroundColor={getColor('info')} color="black"> [D] 详情 </Text>
        )}
      </Box>

      {showDetail && detail && (
        <Box marginTop={1} flexDirection="column">
          <Text color={getColor('info')}>详情:</Text>
          {detail.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={getColor('warning')}>⏱ {formatRemainingSeconds(remainingMs)}秒后自动拒绝（安全策略）</Text>
      </Box>
    </Box>
  );
}
