// src/config/defaults.ts
// 默认配置值
// 当配置文件缺少某些字段时，Zod schema 内部的 default() 会自动填充
// 此文件保留为"显式可读"的默认值备份，方便在代码中引用（如「恢复出厂设置」功能）

import type { AppConfig } from './schema.js';

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  general: {
    language: 'zh-CN',
    theme: 'dark',
    startupBehavior: 'restore',
  },
  providers: [],
  router: {
    rules: [
      { tier: 'simple', modelId: 'deepseek-v4-flash' },
      { tier: 'medium', modelId: 'minimax-m3' },
      { tier: 'complex', modelId: 'qwen3.7-plus' },
      { tier: 'reasoning', modelId: 'kimi-k2.7', fallbackModelId: 'deepseek-v4-pro' },
    ],
    budget: {
      mode: 'track_only',
      dailyLimit: 500000,
      degradationThreshold: 0.8,
    },
    classifierModel: 'deepseek-v4-flash',
    userPreference: 'balanced',
  },
  checkpoint: {
    enabled: true,
    triggers: [
      { level: 20, action: 'initial' },
      { level: 45, action: 'incremental' },
      { level: 70, action: 'compress' },
    ],
    modelId: 'deepseek-v4-flash',
    maxTokensPerCheckpoint: 500,
  },
  goalVerifier: {
    enabled: true,
    modelId: 'kimi-k2.7',
    maxTokensPerVerification: 1000,
    autoVerify: true,
  },
  security: {
    directoryBoundary: true,
    commandBlacklist: ['rm -rf', 'format', 'del /s'],
    commandWhitelist: [],
    sensitiveFiles: ['.env', 'credentials.json', '*.key'],
    sensitiveFilePolicy: 'readonly',
    networkConfirm: true,
  },
  autonomy: {
    defaultMode: 'semi',
  },
  sounds: {
    enabled: true,
    completion: 'default',
    error: 'warning',
    approval: 'notification',
  },
  updates: {
    checkOnStartup: true,
    autoUpdate: false,
  },
  mcp: {
    servers: [],
    autoConnect: true,
  },
};
