// src/cli/components/StatusBar.tsx
// 状态栏组件：显示当前模型、场景等级、Token 消耗、降级状态
// Phase 24 Task 1：迁移到设计系统颜色语义
// Phase 27 Task 3：接入 ThemePlugin，支持插件自定义配色（向后兼容）

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../../router/types.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { ThemeColors, ThemePlugin } from '../../plugins/types.js';
import type { OutputStyle } from '../../config/schema.js';
import {
  getColor,
  getTierLabel,
  type SemanticColor,
} from '../design-system.js';

interface StatusBarProps {
  currentModel: string;
  currentTier: ScenarioTier;
  isDegraded: boolean;
  todayTokensUsed: number;
  autonomyMode: string;
  workMode: string;
  /** Compose 管线摘要（可选，非 Compose 模式不传） */
  composeSummary?: { phase: string; progress: string } | null;
  /** 执行快照（可选，无运行计划不传；DurableExecutor 已移除，保留供未来扩展） */
  durableSnapshot?: { lastStepCompleted: number; totalSteps: number; status: string } | null;
  /** 插件注册表（Phase 27 Task 3：可选，用于读取 ThemePlugin 配色） */
  pluginRegistry?: PluginRegistry;
  /** Phase 34 P1：输出样式，控制状态栏信息密度，默认 standard */
  outputStyle?: OutputStyle;
}

/** ThemeColors 字段到 SemanticColor 的映射（仅覆盖有对应关系的颜色） */
const THEME_TO_SEMANTIC: Partial<Record<SemanticColor, keyof ThemeColors>> = {
  primary: 'primary',
  success: 'success',
  error: 'error',
  accent: 'accent',
};

/**
 * 获取语义颜色，ThemePlugin 提供时优先使用插件颜色，否则用设计系统默认
 * 导出供测试使用
 */
export function getColorWithTheme(
  semantic: SemanticColor,
  themeColors?: Partial<ThemeColors>,
): string {
  const themeKey = THEME_TO_SEMANTIC[semantic];
  if (themeColors && themeKey && themeColors[themeKey]) {
    return themeColors[themeKey] as string;
  }
  return getColor(semantic);
}

/**
 * 获取场景等级颜色，ThemePlugin 提供时优先覆盖
 * 导出供测试使用
 */
export function getTierColorWithTheme(
  tier: string,
  themeColors?: Partial<ThemeColors>,
): string {
  // tier → SemanticColor 映射与 design-system.ts 的 TIER_COLORS 对齐
  const tierSemanticMap: Record<string, SemanticColor> = {
    simple: 'success',
    medium: 'warning',
    complex: 'accent',
    reasoning: 'primary',
  };
  const semantic = tierSemanticMap[tier] ?? 'info';
  // warning / info 在 ThemeColors 中无对应字段，仅覆盖有映射的颜色
  return getColorWithTheme(semantic, themeColors);
}

/** 格式化 Token 数量 */
export function formatTokenCount(count: number): string {
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
  composeSummary,
  durableSnapshot,
  pluginRegistry,
  outputStyle = 'standard',
}: StatusBarProps) {
  // Phase 27 Task 3：组件初始化时检查 ThemePlugin，获取主题颜色
  const themeColors = useMemo<Partial<ThemeColors> | undefined>(() => {
    const themePlugin = pluginRegistry?.getEnabledByType('theme')[0] as ThemePlugin | undefined;
    return themePlugin?.colors;
  }, [pluginRegistry]);

  // 设计系统颜色（ThemePlugin 覆盖时优先使用插件颜色）
  const labelColor = getColorWithTheme('info', themeColors);      // 标签灰色
  const modelColor = getColorWithTheme('primary', themeColors);   // 模型名蓝色
  const tierColor = getTierColorWithTheme(currentTier, themeColors); // 等级按语义色
  const errorColor = getColorWithTheme('error', themeColors);     // 降级红色
  const accentColor = getColorWithTheme('accent', themeColors);   // 编排高亮

  // Phase 34 P1：根据 outputStyle 控制字段可见性
  // minimal：仅模型 + 等级 + 降级标志
  // standard：minimal + Token + 自主 + 模式
  // verbose：standard + 编排摘要 + 执行快照
  const showTokenAndMode = outputStyle !== 'minimal';
  const showOrchestration = outputStyle === 'verbose';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color={labelColor}>模型: </Text>
        <Text bold color={modelColor}>{currentModel}</Text>
        <Text color={labelColor}> │ </Text>
        <Text color={tierColor} bold>[{getTierLabel(currentTier)}]</Text>
        {isDegraded && <Text color={errorColor}> ⚠ 已降级</Text>}
        {showTokenAndMode && (
          <>
            <Text color={labelColor}> │ </Text>
            <Text color={labelColor}>Token: </Text>
            <Text>{formatTokenCount(todayTokensUsed)}</Text>
            <Text color={labelColor}> │ </Text>
            <Text color={labelColor}>自主: </Text>
            <Text>{autonomyMode}</Text>
            <Text color={labelColor}> │ </Text>
            <Text color={labelColor}>模式: </Text>
            <Text>{workMode}</Text>
          </>
        )}
        {showOrchestration && composeSummary && (
          <>
            <Text color={labelColor}> │ </Text>
            <Text color={accentColor}>编排: {composeSummary.phase} {composeSummary.progress}</Text>
          </>
        )}
        {showOrchestration && durableSnapshot && (
          <>
            <Text color={labelColor}> │ </Text>
            <Text color={modelColor}>执行: {durableSnapshot.lastStepCompleted}/{durableSnapshot.totalSteps}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
