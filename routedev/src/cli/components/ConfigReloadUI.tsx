// src/cli/components/ConfigReloadUI.tsx
// 配置热更新 UI 集成（Phase 23 Task 4）
// 将 ConfigWatcher 事件与 CLI 界面打通，用户能感知配置变更
// Phase 24 Task 1：迁移到设计系统颜色语义

import React from 'react';
import { Box, Text } from 'ink';
import { getColor, getMessageStyle } from '../design-system.js';

// ============================================================
// 类型定义
// ============================================================

/** 单条配置变更 */
export interface ConfigChange {
  /** 配置路径（如 "autonomy.defaultMode"） */
  path: string;
  /** 是否热更新（立即生效） */
  hot: boolean;
  /** 通知文案 */
  message: string;
}

/** ConfigReloadNotice 组件 Props */
export interface ConfigReloadNoticeProps {
  /** 变更列表 */
  changes: ConfigChange[];
  /** 变更时间戳 */
  timestamp: Date;
}

// ============================================================
// 变更分类
// ============================================================

/** 热更新路径前缀列表（匹配即热更新） */
const HOT_RELOAD_PREFIXES: Array<{ prefix: string; message: string }> = [
  { prefix: 'autonomy', message: '自主模式已切换' },
  { prefix: 'router.budget', message: '预算设置已更新' },
  { prefix: 'router.userPreference', message: '用户偏好已更新' },
  { prefix: 'general', message: '界面设置已更新' },
  { prefix: 'sounds', message: '提示音设置已更新' },
];

/** 冷更新路径前缀列表 */
const COLD_RELOAD_PREFIXES: Array<{ prefix: string; message: string }> = [
  { prefix: 'providers', message: 'Provider 配置已变更，将在下次会话生效' },
  { prefix: 'router.rules', message: '模型分配已更新，将在下次对话时生效' },
  { prefix: 'router.classifierModel', message: '分类器模型已变更，将在下次对话时生效' },
  { prefix: 'channels', message: '通道配置已变更，需要重启以生效' },
  { prefix: 'security', message: '安全配置已变更，需要重启以生效' },
  { prefix: 'mcp', message: 'MCP 配置已变更，需要重启以生效' },
];

/**
 * 根据配置路径分类变更
 * @param path 配置路径（如 "autonomy.defaultMode"）
 * @param newValue 新值（可选，用于生成更详细的消息）
 */
export function classifyConfigChange(path: string, newValue?: unknown): ConfigChange {
  // 检查热更新
  for (const rule of HOT_RELOAD_PREFIXES) {
    if (path.startsWith(rule.prefix)) {
      // 自主模式特殊处理：包含具体模式值
      if (path === 'autonomy.defaultMode' && newValue !== undefined) {
        return {
          path,
          hot: true,
          message: `自主模式已切换为 ${String(newValue)}`,
        };
      }
      return { path, hot: true, message: rule.message };
    }
  }

  // 检查冷更新
  for (const rule of COLD_RELOAD_PREFIXES) {
    if (path.startsWith(rule.prefix)) {
      return { path, hot: false, message: rule.message };
    }
  }

  // 默认：冷更新
  return {
    path,
    hot: false,
    message: '配置已变更，将在下次会话生效',
  };
}

// ============================================================
// 配置 Diff
// ============================================================

/**
 * 比较两个配置对象，返回变更路径列表
 * 仅比较第一层和第二层字段（足够覆盖所有配置场景）
 */
export function diffConfigs(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
  prefix = '',
): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldConfig[key];
    const newVal = newConfig[key];

    if (oldVal === newVal) continue;

    // 两者都是对象（非数组、非 null）→ 递归比较
    if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === 'object' && typeof newVal === 'object' &&
      !Array.isArray(oldVal) && !Array.isArray(newVal)
    ) {
      changes.push(...diffConfigs(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
        fullPath,
      ));
    } else {
      // 基本类型或数组变更
      changes.push(fullPath);
    }
  }

  return changes;
}

// ============================================================
// 通知合并
// ============================================================

/** 合并窗口内的多条变更，去重相同消息 */
export function mergeChanges(changes: ConfigChange[]): ConfigChange[] {
  const seen = new Map<string, ConfigChange>();

  for (const change of changes) {
    const key = `${change.hot}:${change.message}`;
    // 保留第一条（时间最早），跳过重复
    if (!seen.has(key)) {
      seen.set(key, change);
    }
  }

  return Array.from(seen.values());
}

// ============================================================
// 组件
// ============================================================

/** ConfigReloadNotice：配置变更通知——嵌入 ChatView 消息流 */
export function ConfigReloadNotice({ changes, timestamp }: ConfigReloadNoticeProps) {
  if (changes.length === 0) return null;

  const timeStr = timestamp.toLocaleTimeString('zh-CN', { hour12: false });
  const configStyle = getMessageStyle('config');
  const configColor = getColor(configStyle.color);
  const infoColor = getColor('info');

  return (
    <Box flexDirection="column" marginY={0}>
      {changes.map((change, i) => (
        <Box key={`${change.path}-${i}`}>
          <Text color={configColor} italic={configStyle.italic}>
            {configStyle.prefix}{configStyle.prefix ? ' ' : ''}{change.message}
            {change.hot ? '（已立即生效）' : ''}
          </Text>
        </Box>
      ))}
      <Text color={infoColor} dimColor>  └ {timeStr}</Text>
    </Box>
  );
}

// ============================================================
// 通知生成辅助
// ============================================================

/**
 * 从新旧配置生成合并后的通知变更列表
 * 封装 diff + classify + merge 三步
 */
export function generateReloadNotices(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): ConfigChange[] {
  const paths = diffConfigs(oldConfig, newConfig);
  const changes = paths.map(p => {
    // 尝试从新配置中提取值
    const parts = p.split('.');
    let val: unknown = newConfig;
    for (const part of parts) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        val = (val as Record<string, unknown>)[part];
      } else {
        val = undefined;
        break;
      }
    }
    return classifyConfigChange(p, val);
  });
  return mergeChanges(changes);
}

/**
 * 处理配置重载：返回通知消息字符串列表（供 App.tsx 集成使用）
 * 封装 generateReloadNotices + 消息格式化
 */
export function handleConfigReload(
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): string[] {
  const notices = generateReloadNotices(oldConfig, newConfig);
  if (notices.length === 0) return ['[配置] 配置已变更，将在下次请求时生效。'];
  return notices.map(n => `[配置] ${n.message}${n.hot ? '（已立即生效）' : ''}`);
}
