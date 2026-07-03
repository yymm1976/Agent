import type { AppConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';

export type ConfigPreset = 'minimal' | 'balanced' | 'advanced' | 'research';

export interface PresetDescription {
  name: string;
  description: string;
  useCase: string;
}

export const PRESET_DESCRIPTIONS: Record<ConfigPreset, PresetDescription> = {
  minimal: {
    name: '极简模式',
    description: '关闭大部分高级功能，适合快速开发和日常编码任务',
    useCase: '日常编码、快速原型开发、学习使用',
  },
  balanced: {
    name: '均衡模式',
    description: '默认配置，平衡功能性和性能，适合大多数用户',
    useCase: '通用开发任务、团队协作、中等规模项目',
  },
  advanced: {
    name: '高级模式',
    description: '启用所有优化和诊断功能，适合复杂项目和性能调优',
    useCase: '大型项目、性能调优、复杂架构重构',
  },
  research: {
    name: '研究模式',
    description: '启用所有实验性功能和诊断工具，适合研究和实验',
    useCase: 'AI研究、算法验证、实验性功能测试',
  },
};

export function getPresetConfig(preset: ConfigPreset): Record<string, any> {
  switch (preset) {
    case 'minimal':
      return {
        memorySystem: { enabled: false },
        foundationProtocol: { enabled: false },
        reasoningQualityDiagnostics: { enabled: false },
        adversarial: { enabled: false },
        optimization: {
          tokenTracking: { enabled: false },
          structuredState: { enabled: false },
          declarativeContext: { enabled: false },
          conciseThinking: { enabled: false },
        },
      };

    case 'balanced':
      return {};

    case 'advanced':
      return {
        memorySystem: { enabled: true },
        foundationProtocol: { enabled: true },
        reasoningQualityDiagnostics: { enabled: true },
        adversarial: { enabled: true, threshold: 0.6 },
        optimization: {
          tokenTracking: { enabled: true, persistSession: true },
          structuredState: { enabled: true },
          declarativeContext: { enabled: true },
          conciseThinking: { enabled: true },
        },
      };

    case 'research':
      return {
        memorySystem: { enabled: true },
        foundationProtocol: { enabled: true },
        reasoningQualityDiagnostics: { enabled: true },
        adversarial: { enabled: true, threshold: 0.7 },
        optimization: {
          tokenTracking: { enabled: true, persistSession: true },
          structuredState: { enabled: true },
          declarativeContext: { enabled: true },
          conciseThinking: { enabled: true },
        },
      };

    default:
      return {};
  }
}

function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const result = { ...target } as Record<string, any>;
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result as T;
}

export function applyPreset(
  currentConfig: AppConfig,
  preset: ConfigPreset
): AppConfig {
  const presetConfig = getPresetConfig(preset);
  return deepMerge(currentConfig, presetConfig);
}

export function listPresets(): Array<{
  id: ConfigPreset;
  name: string;
  description: string;
  useCase: string;
}> {
  return Object.entries(PRESET_DESCRIPTIONS).map(([id, info]) => ({
    id: id as ConfigPreset,
    ...info,
  }));
}
