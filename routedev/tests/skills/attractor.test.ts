// tests/skills/attractor.test.ts
// 吸因子引导层单元测试（Phase 49 Task 1.7）
//
// 测试策略：
//   - 构造 FlowNode（含/不含 attractor 字段）
//   - 验证 AttractorInjector.inject 返回的 prompt 包含期望的引导文本
//   - 验证未配置 attractor 时原样返回（向后兼容）

import { describe, it, expect, beforeEach } from 'vitest';
import { AttractorInjector } from '../../src/skills/attractor.js';
import type { FlowNode, SkillFlow } from '../../src/skills/skill-flow-types.js';

describe('AttractorInjector（Phase 49 Task 1.7）', () => {
  let injector: AttractorInjector;

  beforeEach(() => {
    injector = new AttractorInjector();
  });

  /** 构造一个简单的 flow 用于测试（attractor 不依赖 flow 内容） */
  function makeFlow(): SkillFlow {
    return {
      nodes: [],
      entryNodeId: '',
      exitNodeId: '',
      maxTotalIterations: 10,
    };
  }

  it('未配置 attractor 字段时原样返回 prompt', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '第一步',
      prompt: '执行步骤1',
      onFailure: 'abort',
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toBe('执行步骤1');
  });

  it('attractor 字段为空对象时原样返回 prompt（避免空块）', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '第一步',
      prompt: '执行步骤1',
      onFailure: 'abort',
      attractor: {},
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toBe('执行步骤1');
  });

  it('注入 desiredOutput（期望产出画像）', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '构建',
      prompt: '运行构建命令',
      onFailure: 'abort',
      attractor: {
        desiredOutput: '构建产物路径 + 成功日志',
      },
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toContain('=== 期望产出（吸因子引导）===');
    expect(result).toContain('目标画像：构建产物路径 + 成功日志');
    expect(result).toContain('=== 吸因子引导结束 ===');
    // 原始 prompt 仍然存在
    expect(result).toContain('运行构建命令');
  });

  it('注入 styleSample（风格样本路径）', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '实现功能',
      prompt: '实现用户登录',
      onFailure: 'abort',
      attractor: {
        styleSample: 'src/samples/login-sample.ts',
      },
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toContain('风格样本：参照 src/samples/login-sample.ts');
    // 注释明确"勿照抄业务逻辑"（陷阱 153）
    expect(result).toContain('勿照抄业务逻辑');
  });

  it('注入 doneCriteria（完成判定标准）', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '编写测试',
      prompt: '编写单元测试',
      onFailure: 'abort',
      attractor: {
        doneCriteria: '测试覆盖率 >= 80% 且全部通过',
      },
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toContain('完成判定：测试覆盖率 >= 80% 且全部通过');
  });

  it('同时注入三要素（desiredOutput + styleSample + doneCriteria）', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '完整功能',
      prompt: '实现完整功能',
      onFailure: 'abort',
      attractor: {
        desiredOutput: '功能可用 + 文档完整',
        styleSample: 'src/samples/full-sample.ts',
        doneCriteria: '测试通过 + lint 无错误',
      },
    };

    const result = injector.inject(node, makeFlow());

    expect(result).toContain('目标画像：功能可用 + 文档完整');
    expect(result).toContain('风格样本：参照 src/samples/full-sample.ts');
    expect(result).toContain('完成判定：测试通过 + lint 无错误');
    // 引导而非命令的说明
    expect(result).toContain('引导而非硬性要求');
  });

  it('引导文本使用"期望产出"而非"禁止事项"的表述', () => {
    const node: FlowNode = {
      id: 'step1',
      type: 'step',
      title: '构建',
      prompt: '运行构建',
      onFailure: 'abort',
      attractor: {
        desiredOutput: '构建成功',
      },
    };

    const result = injector.inject(node, makeFlow());

    // 标题是"期望产出"而非"禁止事项"
    expect(result).toContain('期望产出');
    expect(result).not.toMatch(/禁止事项/);
  });
});
