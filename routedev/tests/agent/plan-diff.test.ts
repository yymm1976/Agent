// tests/agent/plan-diff.test.ts
// PlanDiffEngine + OmissionChecker 单元测试（Phase 71）
// 覆盖：diff 算法四分类（added/removed/modified/unchanged）、toDiffPlanStep 适配、
//       OmissionChecker 的 fail-open 行为（disabled / LLM 失败 / prompt 加载失败 / 正常解析）

import { describe, it, expect, vi } from 'vitest';
import { PlanDiffEngine, toDiffPlanStep, type PlanStep } from '../../src/agent/plan-diff.js';
import { OmissionChecker } from '../../src/agent/omission-checker.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../src/router/types.js';

// ============================================================
// 工具：构造 mock LLM 客户端
// ============================================================

/**
 * 创建 mock LLM 客户端
 * @param responseContent LLM 响应内容（content 字段）
 * @param shouldThrow complete 调用是否抛错（模拟 LLM 失败）
 */
function makeMockClient(responseContent: string, shouldThrow = false): ILLMClient {
  return {
    protocol: 'openai' as const,
    providerId: 'mock-provider',
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
      if (shouldThrow) {
        throw new Error('模拟 LLM 调用失败');
      }
      return {
        content: responseContent,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        finishReason: 'stop',
        model: 'mock-model',
      };
    }),
    stream: vi.fn(async function* () { /* 空实现 */ }),
  };
}

// ============================================================
// PlanDiffEngine 测试
// ============================================================

describe('PlanDiffEngine', () => {
  const engine = new PlanDiffEngine();

  describe('added', () => {
    it('after 中新增的步骤被识别为 added', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一' },
        { id: '2', description: '步骤二' }, // 新增
      ];

      const result = engine.diff(before, after);

      expect(result.added).toHaveLength(1);
      expect(result.added[0].id).toBe('2');
      expect(result.added[0].description).toBe('步骤二');
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.unchanged).toHaveLength(1);
    });

    it('after 全部新增（before 为空）时全部为 added', () => {
      const before: PlanStep[] = [];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一' },
        { id: '2', description: '步骤二' },
      ];

      const result = engine.diff(before, after);

      expect(result.added).toHaveLength(2);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
    });
  });

  describe('removed', () => {
    it('before 中存在但 after 中不存在的步骤被识别为 removed', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一' },
        { id: '2', description: '步骤二（将被删除）' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一' },
      ];

      const result = engine.diff(before, after);

      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('2');
      expect(result.removed[0].description).toBe('步骤二（将被删除）');
      expect(result.added).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.unchanged).toHaveLength(1);
    });

    it('after 为空（before 全删）时全部为 removed', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一' },
        { id: '2', description: '步骤二' },
      ];
      const after: PlanStep[] = [];

      const result = engine.diff(before, after);

      expect(result.removed).toHaveLength(2);
      expect(result.added).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
    });
  });

  describe('modified', () => {
    it('description 变化时被识别为 modified，fieldChanges 包含 description', () => {
      const before: PlanStep[] = [
        { id: '1', description: '旧描述' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '新描述' },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].id).toBe('1');
      expect(result.modified[0].before.description).toBe('旧描述');
      expect(result.modified[0].after.description).toBe('新描述');
      expect(result.modified[0].fieldChanges).toContain('description');
      expect(result.modified[0].fieldChanges).not.toContain('acceptanceCriteria');
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
    });

    it('acceptanceCriteria 数组长度变化时被识别为 modified', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['验收1'] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['验收1', '验收2'] },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toContain('acceptanceCriteria');
      expect(result.modified[0].fieldChanges).not.toContain('description');
    });

    it('acceptanceCriteria 内容变化（长度相同）时被识别为 modified', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['验收A'] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['验收B'] },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toContain('acceptanceCriteria');
    });

    it('acceptanceCriteria 顺序变化时被识别为 modified（顺序敏感）', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['A', 'B'] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['B', 'A'] },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toContain('acceptanceCriteria');
    });

    it('description 和 acceptanceCriteria 同时变化时 fieldChanges 包含两项', () => {
      const before: PlanStep[] = [
        { id: '1', description: '旧描述', acceptanceCriteria: ['A'] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '新描述', acceptanceCriteria: ['A', 'B'] },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toEqual(
        expect.arrayContaining(['description', 'acceptanceCriteria']),
      );
      expect(result.modified[0].fieldChanges).toHaveLength(2);
    });

    it('acceptanceCriteria 从 undefined 变为有值时识别为 modified', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['新验收'] },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toContain('acceptanceCriteria');
    });

    it('acceptanceCriteria 从有值变为 undefined 时识别为 modified', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['验收'] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一' },
      ];

      const result = engine.diff(before, after);

      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].fieldChanges).toContain('acceptanceCriteria');
    });
  });

  describe('unchanged', () => {
    it('完全相同的步骤被识别为 unchanged', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['A', 'B'] },
        { id: '2', description: '步骤二' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: ['A', 'B'] },
        { id: '2', description: '步骤二' },
      ];

      const result = engine.diff(before, after);

      expect(result.unchanged).toHaveLength(2);
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
    });

    it('acceptanceCriteria 同为 undefined 时视为 unchanged', () => {
      const before: PlanStep[] = [{ id: '1', description: '步骤一' }];
      const after: PlanStep[] = [{ id: '1', description: '步骤一' }];

      const result = engine.diff(before, after);

      expect(result.unchanged).toHaveLength(1);
      expect(result.modified).toHaveLength(0);
    });

    it('acceptanceCriteria 同为空数组时视为 unchanged', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: [] },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一', acceptanceCriteria: [] },
      ];

      const result = engine.diff(before, after);

      expect(result.unchanged).toHaveLength(1);
      expect(result.modified).toHaveLength(0);
    });
  });

  describe('混合场景', () => {
    it('同时存在 added/removed/modified/unchanged', () => {
      const before: PlanStep[] = [
        { id: '1', description: '步骤一（保持不变）' },
        { id: '2', description: '步骤二（将被修改）' },
        { id: '3', description: '步骤三（将被删除）' },
      ];
      const after: PlanStep[] = [
        { id: '1', description: '步骤一（保持不变）' }, // unchanged
        { id: '2', description: '步骤二（已修改）' }, // modified
        { id: '4', description: '步骤四（新增）' }, // added
      ];

      const result = engine.diff(before, after);

      expect(result.unchanged).toHaveLength(1);
      expect(result.unchanged[0].id).toBe('1');
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].id).toBe('2');
      expect(result.added).toHaveLength(1);
      expect(result.added[0].id).toBe('4');
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].id).toBe('3');
    });

    it('两边都为空时返回空 diff', () => {
      const result = engine.diff([], []);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
    });
  });
});

// ============================================================
// toDiffPlanStep 测试
// ============================================================

describe('toDiffPlanStep', () => {
  it('把 number id 转换为 string id', () => {
    const result = toDiffPlanStep({
      id: 42,
      description: '测试步骤',
    });

    expect(result.id).toBe('42');
    expect(result.description).toBe('测试步骤');
    expect(result.acceptanceCriteria).toBeUndefined();
  });

  it('保留 string id 不变', () => {
    const result = toDiffPlanStep({
      id: 'step-1',
      description: '测试步骤',
    });

    expect(result.id).toBe('step-1');
  });

  it('按换行符拆分 acceptanceCriteria', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '验收1\n验收2\n验收3',
    });

    expect(result.acceptanceCriteria).toEqual(['验收1', '验收2', '验收3']);
  });

  it('按分号（中英文）拆分 acceptanceCriteria', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '验收1;验收2；验收3',
    });

    expect(result.acceptanceCriteria).toEqual(['验收1', '验收2', '验收3']);
  });

  it('混合换行和分号拆分', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '验收1\n验收2;验收3；验收4',
    });

    expect(result.acceptanceCriteria).toEqual(['验收1', '验收2', '验收3', '验收4']);
  });

  it('空白 acceptanceCriteria 返回 undefined', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '   ',
    });

    expect(result.acceptanceCriteria).toBeUndefined();
  });

  it('空字符串 acceptanceCriteria 返回 undefined', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '',
    });

    expect(result.acceptanceCriteria).toBeUndefined();
  });

  it('未提供 acceptanceCriteria 时返回 undefined', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
    });

    expect(result.acceptanceCriteria).toBeUndefined();
  });

  it('拆分后仅含空白条目时返回 undefined', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '\n  ;\n；',
    });

    expect(result.acceptanceCriteria).toBeUndefined();
  });

  it('去除每条验收标准的前后空白', () => {
    const result = toDiffPlanStep({
      id: 1,
      description: '测试',
      acceptanceCriteria: '  验收1  \n  验收2  ',
    });

    expect(result.acceptanceCriteria).toEqual(['验收1', '验收2']);
  });
});

// ============================================================
// OmissionChecker 测试（fail-open 行为）
// ============================================================

describe('OmissionChecker', () => {
  // 注：omission-checker.ts 内部 cachedPrompt 是模块级缓存，
  //     未指定 promptPath 的测试共用同一次加载的模板（默认 prompts/omission-check.txt）

  describe('fail-open：禁用时', () => {
    it('enabled=false 时直接返回空结果，不调用 LLM', async () => {
      const mockClient = makeMockClient('不应该被调用');
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: false,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试目标' },
      );

      expect(result.omissions).toEqual([]);
      expect(result.summary).toContain('禁用');
      // complete 方法不应被调用
      expect(mockClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('fail-open：LLM 调用失败时', () => {
    it('LLM 抛错时返回空结果，不抛出', async () => {
      const mockClient = makeMockClient('', true); // shouldThrow=true
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试目标' },
      );

      expect(result.omissions).toEqual([]);
      expect(result.summary).toContain('fail-open');
      expect(mockClient.complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('fail-open：prompt 模板加载失败时', () => {
    it('指定不存在的 promptPath 时返回空结果', async () => {
      const mockClient = makeMockClient('不应该被调用');
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
        promptPath: 'Z:/definitely-not-exist/omission-check.txt',
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试目标' },
      );

      expect(result.omissions).toEqual([]);
      expect(result.summary).toContain('prompt');
      expect(mockClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('正常解析', () => {
    it('LLM 返回有效 JSON 时正确解析遗漏点', async () => {
      const llmResponse = JSON.stringify({
        omissions: [
          {
            category: 'edge-case',
            description: '未处理空输入',
            severity: 'major',
            suggestedStep: '增加输入校验',
          },
          {
            category: 'testing',
            description: '缺少单元测试',
            severity: 'minor',
          },
        ],
        summary: '发现 2 个遗漏点',
      });
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [
          { id: '1', description: '步骤一' },
          { id: '2', description: '步骤二' },
        ],
        { goal: '实现功能 X' },
      );

      expect(result.omissions).toHaveLength(2);
      expect(result.omissions[0].category).toBe('edge-case');
      expect(result.omissions[0].description).toBe('未处理空输入');
      expect(result.omissions[0].severity).toBe('major');
      expect(result.omissions[0].suggestedStep).toBe('增加输入校验');
      expect(result.omissions[1].category).toBe('testing');
      expect(result.omissions[1].severity).toBe('minor');
      expect(result.omissions[1].suggestedStep).toBeUndefined();
      expect(result.summary).toBe('发现 2 个遗漏点');
    });

    it('LLM 返回 ```json 代码块包裹的 JSON 时正确解析', async () => {
      const llmResponse = '```json\n' + JSON.stringify({
        omissions: [
          { category: 'security', description: 'SQL 注入风险', severity: 'critical' },
        ],
        summary: '安全检查',
      }) + '\n```';
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '实现登录' },
      );

      expect(result.omissions).toHaveLength(1);
      expect(result.omissions[0].category).toBe('security');
      expect(result.omissions[0].severity).toBe('critical');
    });

    it('LLM 返回无效 JSON 时返回空结果（fail-open）', async () => {
      const mockClient = makeMockClient('这不是 JSON 内容');
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试目标' },
      );

      expect(result.omissions).toEqual([]);
      expect(result.summary).toContain('JSON');
    });

    it('omissions 字段中的非法 category 回退为 edge-case', async () => {
      const llmResponse = JSON.stringify({
        omissions: [
          { category: 'invalid-category', description: '测试遗漏', severity: 'minor' },
        ],
        summary: '测试',
      });
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试' },
      );

      expect(result.omissions).toHaveLength(1);
      expect(result.omissions[0].category).toBe('edge-case');
    });

    it('omissions 字段中的非法 severity 回退为 minor', async () => {
      const llmResponse = JSON.stringify({
        omissions: [
          { category: 'performance', description: '性能问题', severity: 'invalid' },
        ],
        summary: '测试',
      });
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试' },
      );

      expect(result.omissions).toHaveLength(1);
      expect(result.omissions[0].severity).toBe('minor');
    });

    it('缺少 description 的 omission 条目被过滤', async () => {
      const llmResponse = JSON.stringify({
        omissions: [
          { category: 'testing', severity: 'minor' }, // 无 description
          { category: 'testing', description: '有效遗漏', severity: 'minor' },
          { description: '', severity: 'minor' }, // 空 description
        ],
        summary: '测试',
      });
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试' },
      );

      expect(result.omissions).toHaveLength(1);
      expect(result.omissions[0].description).toBe('有效遗漏');
    });

    it('LLM 返回 summary 缺失时使用默认 summary', async () => {
      const llmResponse = JSON.stringify({
        omissions: [
          { category: 'testing', description: '遗漏1', severity: 'minor' },
        ],
      });
      const mockClient = makeMockClient(llmResponse);
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      const result = await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '测试' },
      );

      expect(result.summary).toContain('1');
    });

    it('projectContext 被传入 prompt（通过 LLM 调用参数验证）', async () => {
      const mockClient = makeMockClient(JSON.stringify({ omissions: [], summary: '空' }));
      const checker = new OmissionChecker({
        llmClient: mockClient,
        modelId: 'fast',
        enabled: true,
      });

      await checker.check(
        [{ id: '1', description: '步骤一' }],
        { goal: '目标', projectContext: '项目使用 TypeScript' },
      );

      expect(mockClient.complete).toHaveBeenCalledTimes(1);
      const callArg = (mockClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LLMRequestOptions;
      const userMessage = callArg.messages[0];
      const content = typeof userMessage.content === 'string' ? userMessage.content : '';
      expect(content).toContain('TypeScript');
      expect(content).toContain('目标');
      expect(content).toContain('步骤一');
    });
  });
});
