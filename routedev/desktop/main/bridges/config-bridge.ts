// desktop/main/bridges/config-bridge.ts
// Config 领域 delegate：负责配置读取/更新、test_connection 内联处理
// 原 RouteDevEngine.getConfig / updateConfig / handleTestConnection 委托至此。
// 注意：reloadConfig 与 initialize/setCwd/destroy 属于引擎生命周期管理，仍保留在 RouteDevEngine 中。

import type { AppConfig } from '../../shared/config-types.js';
import { createLLMClient } from '../../../src/router/llm/index.js';
// G-006 修复：test_connection 增加 SSRF 防护
import { checkSSRF } from '../../../src/tools/security-enhanced.js';
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

    // G-006 修复：baseUrl SSRF 防护——拒绝指向内网/私有 IP 的请求
    // 防止渲染进程被劫持后通过 test_connection 探测内网服务
    const ssrfResult = await checkSSRF(baseUrl);
    if (!ssrfResult.allowed) {
      return { success: false, error: `baseUrl 被安全策略拒绝：${ssrfResult.reason}` };
    }

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

  /**
   * Phase 96 P1-4：拉取指定 provider 的可用模型列表
   *
   * 用传入的 baseUrl/apiKey 临时构造 LLM 客户端，调用 getModels() 拉取远端模型 ID 列表。
   * protocol 从当前已保存配置中按 providerId 查找（用户测试草稿值时仍用已保存的 protocol）。
   * provider 未保存时（用户正在新建未保存）回退到 args.protocol（可选）。
   *
   * @returns { success: boolean; models?: string[]; error?: string }
   */
  async handleListModels(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; models?: string[]; error?: string }> {
    const providerId = String(args.providerId ?? '');
    const baseUrl = String(args.baseUrl ?? '');
    const apiKey = String(args.apiKey ?? '');
    if (!providerId || !baseUrl || !apiKey) {
      return { success: false, error: '缺少 providerId / baseUrl / apiKey 参数' };
    }

    // 从当前已保存配置中查找 protocol（用户编辑未保存时仍用旧 protocol）
    const provider = this.ctx.config.providers.find((p) => p.id === providerId);
    const protocol = provider?.protocol ?? (args.protocol as AppConfig['providers'][number]['protocol'] | undefined);
    if (!protocol) {
      return { success: false, error: `未找到 provider: ${providerId}（请先保存配置或传入 protocol 参数）` };
    }

    // G-006 修复：baseUrl SSRF 防护——拒绝指向内网/私有 IP 的请求
    const ssrfResult = await checkSSRF(baseUrl);
    if (!ssrfResult.allowed) {
      return { success: false, error: `baseUrl 被安全策略拒绝：${ssrfResult.reason}` };
    }

    try {
      const client = createLLMClient({
        id: providerId,
        protocol,
        baseUrl,
        apiKey,
        timeoutMs: 15000,
      });
      // Phase 96 P1-4：调用 BaseLLMClient.getModels() 拉取远端模型列表
      // 失败时 getModels 内部已 fail-open 返回空数组，此处不再二次捕获
      const models = await client.getModels();
      return { success: true, models };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
