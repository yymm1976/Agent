// tests/router/capability-resolver.test.ts
// B-14：模型运行时能力声明与显式降级
//
// 契约：
// 1. 白名单语义：未声明 = 不支持 = 显式降级（原因字符串）
// 2. 完整声明不降级
// 3. 不请求的能力不判降级（wantsTools=false 时无 tool_use 也不降级）
// 4. maxSchemaTokens 默认 4096，可覆盖
// 5. catalog 内置模型自动获得运行时能力（router 合并点）

import { describe, it, expect } from 'vitest';
import { resolveCapabilities } from '../../src/router/capability-resolver.js';
import { runtimeCapabilities, RUNTIME_CAPABILITIES } from '../../src/router/model-catalog.js';

describe('B-14 resolveCapabilities', () => {
  it('完整声明时不降级', () => {
    const d = resolveCapabilities(
      ['tool_use', 'streaming', 'parallel_tool_calls', 'multimodal'],
      undefined,
      { wantsTools: true, wantsImages: true, wantsParallelTools: true },
    );
    expect(d.toolsEnabled).toBe(true);
    expect(d.imageInputEnabled).toBe(true);
    expect(d.parallelToolsEnabled).toBe(true);
    expect(d.streamingEnabled).toBe(true);
    expect(d.degradations).toHaveLength(0);
  });

  it('无 tool_use 声明：工具调用显式禁用且原因可见', () => {
    const d = resolveCapabilities(['streaming'], undefined, { wantsTools: true });
    expect(d.toolsEnabled).toBe(false);
    expect(d.degradations.some((s) => s.includes('tool_use'))).toBe(true);
  });

  it('无 parallel_tool_calls 声明：并行降级为串行', () => {
    const d = resolveCapabilities(['tool_use', 'streaming'], undefined, {
      wantsTools: true,
      wantsParallelTools: true,
    });
    expect(d.parallelToolsEnabled).toBe(false);
    expect(d.degradations.some((s) => s.includes('parallel_tool_calls'))).toBe(true);
  });

  it('无 multimodal 声明：图像输入被剥离', () => {
    const d = resolveCapabilities(['tool_use'], undefined, { wantsImages: true });
    expect(d.imageInputEnabled).toBe(false);
    expect(d.degradations.some((s) => s.includes('multimodal'))).toBe(true);
  });

  it('无 streaming 声明：显式提示', () => {
    const d = resolveCapabilities(['tool_use'], undefined, { wantsTools: true });
    expect(d.streamingEnabled).toBe(false);
    expect(d.degradations.some((s) => s.includes('streaming'))).toBe(true);
  });

  it('未请求的能力不判降级', () => {
    const d = resolveCapabilities(['code'], undefined, {}); // 什么都不请求
    expect(d.toolsEnabled).toBe(true);
    expect(d.imageInputEnabled).toBe(true);
    expect(d.parallelToolsEnabled).toBe(true);
    expect(d.degradations).toHaveLength(0);
  });

  it('未声明任何能力且请求全部：全部降级', () => {
    const d = resolveCapabilities([], undefined, {
      wantsTools: true,
      wantsImages: true,
      wantsParallelTools: true,
    });
    expect(d.toolsEnabled).toBe(false);
    expect(d.imageInputEnabled).toBe(false);
    expect(d.parallelToolsEnabled).toBe(false);
    expect(d.streamingEnabled).toBe(false);
    expect(d.degradations.length).toBeGreaterThanOrEqual(3);
  });

  it('maxSchemaTokens 默认 4096 且可覆盖', () => {
    expect(resolveCapabilities([], undefined).maxSchemaTokens).toBe(4096);
    expect(resolveCapabilities([], 16000).maxSchemaTokens).toBe(16000);
    expect(resolveCapabilities([], 0).maxSchemaTokens).toBe(0);
  });
});

describe('B-14 runtimeCapabilities（catalog 合并）', () => {
  it('内置模型自动获得运行时能力（tool_use/streaming/parallel_tool_calls）', () => {
    const caps = runtimeCapabilities('deepseek-chat');
    expect(caps).toContain('tool_use');
    expect(caps).toContain('streaming');
    expect(caps).toContain('parallel_tool_calls');
    // catalog 原有标签保留
    expect(caps).toContain('code');
  });

  it('gpt-4o 保留 multimodal（图像能力来自 catalog 标签）', () => {
    const caps = runtimeCapabilities('gpt-4o');
    expect(caps).toContain('multimodal');
  });

  it('catalog 未覆盖的模型返回协议级默认能力（防存量配置静默禁工具，审查 I4 修复）', () => {
    const caps = runtimeCapabilities('my-custom-model-xyz');
    expect(caps).toContain('tool_use');
    expect(caps).toContain('streaming');
    expect(caps).toContain('parallel_tool_calls');
  });

  it('RUNTIME_CAPABILITIES 常量与枚举值一致', () => {
    expect([...RUNTIME_CAPABILITIES].sort()).toEqual(
      ['tool_use', 'streaming', 'parallel_tool_calls'].sort(),
    );
  });
});
