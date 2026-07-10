// desktop/main/bridges/config-bridge.ts
// Config 领域 delegate：负责配置读取/更新、test_connection 内联处理
// 原 RouteDevEngine.getConfig / updateConfig / handleTestConnection 委托至此。
// 注意：reloadConfig 与 initialize/setCwd/destroy 属于引擎生命周期管理，仍保留在 RouteDevEngine 中。

import type { AppConfig } from '../../../src/config/schema.js';
import { createLLMClient } from '../../../src/router/llm/index.js';
import type { EngineContext } from './engine-context.js';

/**
 * Config 领域桥接器
 *
 * 提供配置读取与热更新（updateConfig 实时生效，reloadConfig 触发重新初始化——后者仍在 RouteDevEngine）。
 * handleTestConnection 内联处理 test_connection 工具调用（executeTool 在 RouteDevEngine 中转发到此）。
 */
export class ConfigBridge {
  constructor(private ctx: EngineContext) {}

  /**
   * 获取当前配置（供主进程 IPC 处理器读取安全策略等）
   */
  getConfig(): AppConfig {
    return this.ctx.config;
  }

  /**
   * 更新引擎配置（用户在设置页面修改配置后调用，确保自主度等设置实时生效）
   */
  updateConfig(newConfig: AppConfig): void {
    this.ctx.config = newConfig;
    console.log(`[Engine] 配置已更新，自主度: ${newConfig.autonomy.defaultMode}`);
  }

  /**
   * F-N016 修复：内联处理 test_connection 工具调用
   *
   * test_connection 未在 ToolExecutor 注册，此处用传入的 baseUrl/apiKey 临时构造一个
   * LLM 客户端，发送一条 maxTokens=1 的极简请求以验证连通性与凭据有效性。
   * protocol 与 modelId 从当前已保存配置中按 providerId 查找（测试草稿值时仍用已保存的 protocol）。
   *
   * @returns { success: boolean; error?: string }
   */
  async handleTestConnection(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> {
    const providerId = String(args.providerId ?? '');
    const baseUrl = String(args.baseUrl ?? '');
    const apiKey = String(args.apiKey ?? '');
    if (!providerId || !baseUrl || !apiKey) {
      return { success: false, error: '缺少 providerId / baseUrl / apiKey 参数' };
    }

    // 从当前已保存配置中查找 protocol 与可用模型 id
    const provider = this.ctx.config.providers.find((p) => p.id === providerId);
    if (!provider) {
      return { success: false, error: `未找到 provider: ${providerId}（请先保存配置）` };
    }
    const modelId = provider.models[0]?.id ?? '';

    try {
      const client = createLLMClient({
        id: providerId,
        protocol: provider.protocol,
        baseUrl,
        apiKey,
        timeoutMs: 15000,
      });
      // 轻量连通性测试：maxTokens=1 的极简请求
      await client.complete({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        timeoutMs: 15000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
