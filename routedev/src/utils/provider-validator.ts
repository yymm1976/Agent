// src/utils/provider-validator.ts
// Provider 配置完整性校验（Phase 24 Task 8）
// 启动时检查配置中的 provider 是否有对应的 LLMClient 实现
// 不匹配时输出警告（不阻断启动）

import type { AppConfig, ProviderConfig } from '../config/schema.js';
import type { LLMClientManager } from '../router/llm/index.js';
import { logger } from './logger.js';

/**
 * Provider 校验结果
 */
export interface ProviderValidationResult {
  /** 校验通过的 provider 数量 */
  validCount: number;
  /** 校验失败的 provider 数量 */
  invalidCount: number;
  /** 失败的 provider 详情 */
  failures: Array<{
    providerId: string;
    reason: string;
    suggestion: string;
  }>;
}

/**
 * 校验单个 provider 配置
 * @param provider provider 配置
 * @param clientManager LLM 客户端管理器
 */
function validateProvider(
  provider: ProviderConfig,
  clientManager: LLMClientManager,
): { valid: boolean; reason?: string; suggestion?: string } {
  // 检查 1：LLMClientManager 是否有对应的 client 注册
  const client = clientManager.get(provider.id);
  if (!client) {
    return {
      valid: false,
      reason: `未找到对应的 API client`,
      suggestion: `请确认已安装 SDK 或设置 API_KEY 环境变量`,
    };
  }

  // 检查 2：client 是否就绪
  if (!client.isReady()) {
    return {
      valid: false,
      reason: `API client 未就绪`,
      suggestion: `检查 API Key 是否有效，或网络连接是否正常`,
    };
  }

  // 检查 3：providers[].models[] 列出的模型是否至少有一个可用
  if (provider.models.length === 0) {
    return {
      valid: false,
      reason: `未配置任何模型`,
      suggestion: `在配置中为该 provider 添加至少一个 model`,
    };
  }

  return { valid: true };
}

/**
 * 校验所有 provider 配置
 * @param config 应用配置
 * @param clientManager LLM 客户端管理器
 * @returns 校验结果
 */
export function validateProviders(
  config: AppConfig,
  clientManager: LLMClientManager,
): ProviderValidationResult {
  const failures: ProviderValidationResult['failures'] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const provider of config.providers) {
    const result = validateProvider(provider, clientManager);
    if (result.valid) {
      validCount++;
    } else {
      invalidCount++;
      failures.push({
        providerId: provider.id,
        reason: result.reason ?? '未知原因',
        suggestion: result.suggestion ?? '请检查配置',
      });

      // 输出警告日志
      logger.warn(`配置了 provider "${provider.id}" 但校验失败`, {
        providerId: provider.id,
        reason: result.reason,
        suggestion: result.suggestion,
      });
    }
  }

  // 汇总日志
  if (invalidCount > 0) {
    logger.warn(`Provider 配置校验完成：${validCount} 个通过，${invalidCount} 个失败`, {
      validCount,
      invalidCount,
    });
  } else if (validCount > 0) {
    logger.debug(`Provider 配置校验完成：全部 ${validCount} 个 provider 通过`, {
      validCount,
    });
  }

  return {
    validCount,
    invalidCount,
    failures,
  };
}

/**
 * 格式化校验结果为用户可读的消息列表
 * @param result 校验结果
 */
export function formatValidationMessages(result: ProviderValidationResult): string[] {
  if (result.invalidCount === 0) {
    return [];
  }

  const messages: string[] = [];
  for (const failure of result.failures) {
    messages.push(
      `[警告] 配置了 provider "${failure.providerId}" 但${failure.reason}。`,
      `  ${failure.suggestion}`,
    );
  }
  return messages;
}
