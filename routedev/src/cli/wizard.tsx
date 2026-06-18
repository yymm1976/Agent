// src/cli/wizard.tsx
// 首次运行 Setup Wizard（Phase 23 Task 3）
// 新用户首次运行时通过交互式向导完成基础配置
// 仅在 config.yaml 不存在时触发

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { existsSync } from 'node:fs';
import { getGlobalConfigPath } from '../utils/paths.js';

// ============================================================
// 类型定义
// ============================================================

/** Wizard 步骤类型 */
export type WizardStepType = 'select' | 'multiselect' | 'input';

/** Wizard 步骤选项 */
export interface WizardOption {
  label: string;
  value: string;
}

/** Wizard 步骤定义 */
export interface WizardStep {
  id: string;
  title: string;
  prompt: string;
  type: WizardStepType;
  options?: WizardOption[];
  /** 返回 null 表示验证通过，否则返回错误消息 */
  validate?: (value: string) => string | null;
  default: string;
}

/** Wizard 答案 */
export type WizardAnswers = Record<string, string>;

// ============================================================
// 步骤定义
// ============================================================

/** Provider 选项 */
export const PROVIDER_OPTIONS: WizardOption[] = [
  { label: 'OpenAI (GPT-4o, o1)', value: 'openai' },
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Qwen (通义千问)', value: 'qwen' },
  { label: 'Ollama (本地模型)', value: 'ollama' },
];

/** Provider → 环境变量映射 */
export const PROVIDER_ENV_VARS: Record<string, string | null> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'QWEN_API_KEY',
  ollama: null, // 本地模型无需 API Key
};

/** Provider → 默认配置 */
export const PROVIDER_DEFAULTS: Record<string, { protocol: string; baseUrl: string; models: Array<{ id: string; name: string; tier: string }> }> = {
  openai: {
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', tier: 'simple' },
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'complex' },
      { id: 'o1-preview', name: 'o1 Preview', tier: 'reasoning' },
    ],
  },
  anthropic: {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-3-haiku', name: 'Claude 3 Haiku', tier: 'simple' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', tier: 'complex' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', tier: 'reasoning' },
    ],
  },
  deepseek: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', tier: 'simple' },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', tier: 'medium' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', tier: 'reasoning' },
    ],
  },
  qwen: {
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-turbo', name: 'Qwen Turbo', tier: 'simple' },
      { id: 'qwen-plus', name: 'Qwen Plus', tier: 'medium' },
      { id: 'qwen-max', name: 'Qwen Max', tier: 'complex' },
    ],
  },
  ollama: {
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'llama3.2', name: 'Llama 3.2', tier: 'simple' },
      { id: 'qwen2.5-coder', name: 'Qwen2.5 Coder', tier: 'medium' },
    ],
  },
};

/** 五个步骤定义 */
export const WIZARD_STEPS: WizardStep[] = [
  {
    id: 'lang',
    title: '语言偏好',
    prompt: '选择界面语言',
    type: 'select',
    options: [
      { label: '中文 (zh-CN)', value: 'zh-CN' },
      { label: 'English (en-US)', value: 'en-US' },
    ],
    default: 'zh-CN',
  },
  {
    id: 'providers',
    title: 'Provider 配置',
    prompt: '选择要启用的 LLM 提供商（逗号分隔，如 openai,deepseek）',
    type: 'multiselect',
    options: PROVIDER_OPTIONS,
    validate: (value) => {
      if (!value.trim()) return '至少选择一个 Provider';
      const selected = value.split(',').map(s => s.trim()).filter(Boolean);
      const valid = selected.every(s => PROVIDER_OPTIONS.some(o => o.value === s));
      if (!valid) return '包含无效的 Provider 名称';
      return null;
    },
    default: 'openai',
  },
  {
    id: 'models',
    title: '模型分级',
    prompt: '为各任务等级指定模型（留空使用默认推荐）\n格式: simple=模型ID,medium=模型ID,complex=模型ID,reasoning=模型ID',
    type: 'input',
    validate: (value) => {
      if (!value.trim()) return null; // 留空允许
      const parts = value.split(',').map(p => p.trim()).filter(Boolean);
      for (const part of parts) {
        const [tier, model] = part.split('=').map(s => s.trim());
        if (!tier || !model) return '格式错误，应为 tier=model（如 simple=gpt-4o-mini）';
        const validTiers = ['simple', 'medium', 'complex', 'reasoning'];
        if (!validTiers.includes(tier)) return `无效的任务等级: ${tier}（应为 simple/medium/complex/reasoning）`;
      }
      return null;
    },
    default: '',
  },
  {
    id: 'budget',
    title: '预算偏好',
    prompt: '选择预算偏好',
    type: 'select',
    options: [
      { label: '省钱模式（优先使用便宜模型）', value: 'saving' },
      { label: '平衡模式（成本与质量兼顾）', value: 'balanced' },
      { label: '高质量模式（优先使用强模型）', value: 'premium' },
    ],
    default: 'balanced',
  },
  {
    id: 'autonomy',
    title: '自主模式',
    prompt: '选择默认自主模式',
    type: 'select',
    options: [
      { label: '全自动（auto）— 工具调用无需确认', value: 'auto' },
      { label: '半自动（semi）— 关键操作需确认', value: 'semi' },
      { label: '手动（manual）— 每步都需确认', value: 'manual' },
    ],
    default: 'semi',
  },
];

// ============================================================
// 配置生成
// ============================================================

/**
 * 解析模型分级输入字符串
 * @param input 如 "simple=gpt-4o-mini,complex=gpt-4o"
 * @returns Record<tier, modelId>
 */
export function parseModelAssignments(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input.trim()) return result;

  for (const part of input.split(',').map(p => p.trim()).filter(Boolean)) {
    const [tier, model] = part.split('=').map(s => s.trim());
    if (tier && model) {
      result[tier] = model;
    }
  }
  return result;
}

/**
 * 根据 Wizard 答案生成带注释的 config.yaml 内容
 * API Key 不在 Wizard 中收集——使用 ${ENV_VAR} 占位符
 */
export function generateConfigYaml(answers: WizardAnswers): string {
  const lang = answers.lang || 'zh-CN';
  const providers = (answers.providers || 'openai').split(',').map(s => s.trim()).filter(Boolean);
  const modelAssignments = parseModelAssignments(answers.models || '');
  const budget = answers.budget || 'balanced';
  const autonomy = answers.autonomy || 'semi';

  const lines: string[] = [];

  lines.push('# RouteDev 配置文件');
  lines.push('# 由 Setup Wizard 生成');
  lines.push('# API Key 请通过环境变量设置（如 OPENAI_API_KEY）');
  lines.push('');
  lines.push(`version: 1`);
  lines.push('');

  // general
  lines.push('# 通用设置');
  lines.push('general:');
  lines.push(`  language: ${lang}                # 界面语言 (zh-CN / en-US)`);
  lines.push('  theme: dark                    # 主题 (dark / light)');
  lines.push('  startupBehavior: restore       # 启动行为 (restore / project_select)');
  lines.push('');

  // providers
  lines.push('# LLM 提供商配置');
  // 仅当存在需要 API Key 的 Provider 时才添加环境变量说明注释
  const hasEnvVarProvider = providers.some(pId => PROVIDER_ENV_VARS[pId] !== null && PROVIDER_ENV_VARS[pId] !== undefined);
  if (hasEnvVarProvider) {
    lines.push('# apiKey 使用 ${ENV_VAR} 引用环境变量，请设置对应的环境变量');
  }
  lines.push('providers:');
  for (const pId of providers) {
    const def = PROVIDER_DEFAULTS[pId];
    if (!def) continue;
    const envVar = PROVIDER_ENV_VARS[pId];
    lines.push(`  - id: ${pId}`);
    lines.push(`    name: ${pId.charAt(0).toUpperCase() + pId.slice(1)}`);
    lines.push(`    protocol: ${def.protocol}`);
    lines.push(`    baseUrl: ${def.baseUrl}`);
    if (envVar) {
      lines.push(`    apiKey: \${${envVar}}    # 请设置环境变量 ${envVar}`);
    } else {
      lines.push(`    apiKey: dummy    # 本地模型无需 API Key`);
    }
    lines.push('    models:');
    for (const m of def.models) {
      lines.push(`      - id: ${m.id}`);
      lines.push(`        name: ${m.name}`);
      lines.push(`        provider: ${pId}`);
      lines.push(`        tier: ${m.tier}`);
      lines.push(`        contextWindow: 128000`);
      lines.push(`        capabilities: []`);
      lines.push(`        latencyMs: 0`);
      lines.push(`        available: true`);
    }
    lines.push('');
  }

  // router
  lines.push('# 路由配置');
  lines.push('router:');
  lines.push('  # 四级分类路由规则');
  lines.push('  rules:');

  const defaultModels: Record<string, { modelId: string; fallback?: string }> = {
    simple: { modelId: 'deepseek-v4-flash' },
    medium: { modelId: 'minimax-m3' },
    complex: { modelId: 'qwen3.7-plus' },
    reasoning: { modelId: 'kimi-k2.7', fallback: 'deepseek-v4-pro' },
  };

  for (const tier of ['simple', 'medium', 'complex', 'reasoning']) {
    const modelId = modelAssignments[tier] || defaultModels[tier].modelId;
    const fallback = defaultModels[tier].fallback;
    let line = `    - tier: ${tier}`;
    line += `\n      modelId: ${modelId}`;
    if (fallback) line += `\n      fallbackModelId: ${fallback}`;
    lines.push(line);
  }

  lines.push('');
  lines.push('  # Token 预算');
  lines.push('  budget:');
  lines.push('    mode: track_only             # track_only / enforce');
  lines.push('    dailyLimit: 500000           # 日 token 上限');
  lines.push('    degradationThreshold: 0.8    # 达到此比例后降级');
  lines.push('');
  lines.push('  classifierModel: deepseek-v4-flash  # 分类器模型（选最便宜的）');
  lines.push(`  userPreference: ${budget}          # 用户偏好 (saving / balanced / premium)`);
  lines.push('');

  // checkpoint
  lines.push('# 增量 Checkpoint 配置');
  lines.push('checkpoint:');
  lines.push('  enabled: true');
  lines.push('  triggers:');
  lines.push('    - level: 20');
  lines.push('      action: initial');
  lines.push('    - level: 45');
  lines.push('      action: incremental');
  lines.push('    - level: 70');
  lines.push('      action: compress');
  lines.push('  modelId: deepseek-v4-flash');
  lines.push('  maxTokensPerCheckpoint: 500');
  lines.push('');

  // autonomy
  lines.push('# 自主度配置');
  lines.push('autonomy:');
  lines.push(`  defaultMode: ${autonomy}                # auto / semi / manual`);
  lines.push('  autoApprovePatterns: [file_read, file_search, code_search]');
  lines.push('  confirmTimeout: 30000          # 确认超时（毫秒）');
  lines.push('');

  // security
  lines.push('# 安全配置');
  lines.push('security:');
  lines.push('  directoryBoundary: true');
  lines.push('  commandBlacklist: ["rm -rf", "format", "del /s"]');
  lines.push('  sensitiveFiles: [".env", "credentials.json", "*.key"]');
  lines.push('  sensitiveFilePolicy: readonly');
  lines.push('  networkConfirm: true');
  lines.push('');

  // channels
  lines.push('# 渠道配置（按需启用）');
  lines.push('channels:');
  lines.push('  entries: []');
  lines.push('  port: 9800');
  lines.push('  maxResponseLength: 2000');
  lines.push('  requestTimeout: 60000');
  lines.push('');

  lines.push('# 提示音 / 更新 / MCP 等配置使用默认值即可');

  return lines.join('\n');
}

// ============================================================
// 触发条件
// ============================================================

/**
 * 检查是否应该运行 Setup Wizard
 * 仅在全局 config.yaml 不存在时触发
 */
export function shouldRunWizard(configPath?: string): boolean {
  const path = configPath ?? getGlobalConfigPath();
  return !existsSync(path);
}

// ============================================================
// 交互式组件
// ============================================================

interface SetupWizardProps {
  steps?: WizardStep[];
  onComplete: (answers: WizardAnswers) => void;
  onCancel: () => void;
}

/** SetupWizard 交互式组件 */
export function SetupWizard({ steps = WIZARD_STEPS, onComplete, onCancel }: SetupWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswers>({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const step = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  const handleConfirm = useCallback(() => {
    let value: string;

    if (step.type === 'select') {
      const opt = step.options?.[selectedIndex];
      value = opt?.value ?? step.default;
    } else if (step.type === 'multiselect') {
      // multiselect 用 input 模式：用户直接输入逗号分隔的值
      value = inputValue.trim() || step.default;
    } else {
      value = inputValue.trim() || step.default;
    }

    // 验证
    if (step.validate) {
      const err = step.validate(value);
      if (err) {
        setError(err);
        return;
      }
    }

    setError(null);
    const newAnswers = { ...answers, [step.id]: value };
    setAnswers(newAnswers);

    if (isLastStep) {
      onComplete(newAnswers);
    } else {
      setCurrentStep(currentStep + 1);
      setSelectedIndex(0);
      setInputValue('');
    }
  }, [step, selectedIndex, inputValue, answers, isLastStep, currentStep, onComplete]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    if (step.type === 'select') {
      if (key.upArrow) {
        setSelectedIndex(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex(i => Math.min((step.options?.length ?? 1) - 1, i + 1));
      } else if (key.return) {
        handleConfirm();
      }
    } else {
      // input / multiselect：直接输入
      if (key.return) {
        handleConfirm();
      } else if (key.backspace || key.delete) {
        setInputValue(v => v.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setInputValue(v => v + input);
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>┌─ RouteDev Setup Wizard ──────────────────────────────────┐</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="yellow" bold>Step {currentStep + 1}/{steps.length}: {step.title}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray">{step.prompt}</Text>
      </Box>

      {step.type === 'select' && step.options && (
        <Box flexDirection="column" marginBottom={1}>
          {step.options.map((opt, i) => (
            <Box key={opt.value}>
              <Text color={i === selectedIndex ? 'cyan' : 'gray'}>
                {i === selectedIndex ? '❯ ' : '  '}{opt.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {(step.type === 'input' || step.type === 'multiselect') && (
        <Box marginBottom={1}>
          <Text color="cyan">{'> '}</Text>
          <Text>{inputValue || (step.default ? `(默认: ${step.default})` : '')}</Text>
        </Box>
      )}

      {error && (
        <Box marginBottom={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      <Box>
        <Text color="gray">↑↓ 选择  Enter 确认  Ctrl+C 退出</Text>
      </Box>
    </Box>
  );
}
