// tests/cli/phase50-ui-integration.test.ts
// Phase 50 Task 7：7 个 React 组件接入 UI 集成测试
// 验证内容：
//   1. UIComponentsSchema 配置开关默认值与覆盖
//   2. 各组件渲染函数在有数据时正确输出
//   3. 命令处理器在配置开关开启时触发 CommandBridge 回调（接入 React 组件）
//   4. 命令处理器在配置开关关闭时回退到纯文本渲染（向后兼容）
//
// 设计原则：
//   - 单元测试已覆盖各 render*Text 函数的细节，此处聚焦"接入行为"
//   - 通过 mock ServiceContext + CommandBridge 验证命令→UI 的桥接
//   - 配置开关测试覆盖 schema 默认值与运行时判断逻辑

import { describe, it, expect, vi } from 'vitest';
import { UIComponentsSchema, AppConfigSchema } from '../../src/config/schema.js';
import { renderBranchTreeText } from '../../src/cli/components/BranchSwitcher.js';
import { renderProgressBar } from '../../src/cli/components/ProgressBar.js';
import { parseUnifiedDiff, renderDiffText } from '../../src/cli/components/DiffView.js';
import { generateReloadNotices } from '../../src/cli/components/ConfigReloadUI.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { traceCommand } from '../../src/cli/commands/trace.js';
// E11 更新：durable-executor 已删除，/resume 改用 GoalPersistence.listResumable
import { GoalPersistence, type PersistedGoal } from '../../src/agent/goal-persistence.js';
import type { TraceSpan } from '../../src/harness/trace-types.js';
import type { BranchInfo } from '../../src/agent/branch.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

// ============================================================
// 测试辅助函数
// ============================================================

/** 创建测试用 PersistedGoal（替代旧 ExecutionSnapshot） */
function makeGoal(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
  return {
    id: 'plan-test-001',
    spec: { goal: '实现用户登录功能', context: '', steps: [], done: '', verification: '' },
    plan: {
      steps: [
        { id: 's1', description: 'step1', status: 'completed', dependencies: [] },
        { id: 's2', description: 'step2', status: 'completed', dependencies: [] },
        { id: 's3', description: 'step3', status: 'pending', dependencies: [] },
      ],
    },
    status: 'paused',
    checkpointIds: [],
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 30000,
    tokenUsed: 1000,
    tokenBudget: 10000,
    ...overrides,
  };
}

/** 创建测试用 TraceSpan（tool_call 类型） */
function makeToolCallSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 1,
    sessionId: 'session-001',
    type: 'tool_call',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 100,
    payload: {
      type: 'tool_call',
      toolName: 'file_read',
      toolCallId: 'call-001',
      result: '文件内容',
      isError: false,
    },
    status: 'completed',
    ...overrides,
  };
}

/** 创建 mock ServiceContext（仅包含 /resume 命令所需字段） */
function makeResumeMockCtx(
  goals: PersistedGoal[],
  opts: { resumePickerEnabled?: boolean; showResumePicker?: boolean } = {},
): { ctx: Partial<ServiceContext>; showResumePicker: ReturnType<typeof vi.fn> } {
  const showResumePicker = vi.fn();
  // E11 更新：mock GoalPersistence.prototype.listResumable 而非 durableExecutor
  // （resume.ts 内部通过 `new GoalPersistence(cwd).listResumable()` 读取目标列表）
  vi.spyOn(GoalPersistence.prototype, 'listResumable').mockResolvedValue(goals);
  return {
    ctx: {
      cwd: '/tmp/test-routedev',  // 任意路径，GoalPersistence.listResumable 已 mock
      commandBridge: {
        addSystemMessage: vi.fn(),
        ...(opts.showResumePicker !== false ? { showResumePicker } : {}),
      } as never,
      config: {
        ui: {
          outputStyle: 'standard',
          components: {
            branchSwitcher: true,
            resumePicker: opts.resumePickerEnabled ?? true,
            progressBar: true,
            tracePanel: false,
            disclosureLevel: true,
            diffView: true,
            configReloadNotice: true,
          },
        },
      } as never,
    } as Partial<ServiceContext>,
    showResumePicker,
  };
}

/** 创建 mock ServiceContext（仅包含 /trace 命令所需字段） */
function makeTraceMockCtx(
  spans: TraceSpan[],
  opts: { tracePanelEnabled?: boolean; sessionId?: string } = {},
): { ctx: Partial<ServiceContext>; showTracePanel: ReturnType<typeof vi.fn> } {
  const showTracePanel = vi.fn();
  return {
    ctx: {
      trace: {
        getSessionId: vi.fn(() => opts.sessionId ?? 'session-001'),
        getSpans: vi.fn(() => spans),
      } as never,
      audit: {} as never,
      tracker: {} as never,
      commandBridge: {
        addSystemMessage: vi.fn(),
        showTracePanel,
      } as never,
      config: {
        ui: {
          outputStyle: 'standard',
          components: {
            branchSwitcher: true,
            resumePicker: true,
            progressBar: true,
            tracePanel: opts.tracePanelEnabled ?? false,
            disclosureLevel: true,
            diffView: true,
            configReloadNotice: true,
          },
        },
      } as never,
    } as Partial<ServiceContext>,
    showTracePanel,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 50 Task 7: UIComponentsSchema 配置开关', () => {
  it('默认值：6 个组件默认 true，tracePanel 默认 false', () => {
    // 解析空对象应使用 schema 内置默认值
    const parsed = UIComponentsSchema.parse({});
    expect(parsed.branchSwitcher).toBe(true);
    expect(parsed.resumePicker).toBe(true);
    expect(parsed.progressBar).toBe(true);
    expect(parsed.tracePanel).toBe(false); // 默认关闭：需交互式 Ink 输入
    expect(parsed.disclosureLevel).toBe(true);
    expect(parsed.diffView).toBe(true);
    expect(parsed.configReloadNotice).toBe(true);
  });

  it('支持显式覆盖每个开关', () => {
    const parsed = UIComponentsSchema.parse({
      branchSwitcher: false,
      resumePicker: false,
      progressBar: false,
      tracePanel: true,
      disclosureLevel: false,
      diffView: false,
      configReloadNotice: false,
    });
    expect(parsed.branchSwitcher).toBe(false);
    expect(parsed.resumePicker).toBe(false);
    expect(parsed.progressBar).toBe(false);
    expect(parsed.tracePanel).toBe(true);
    expect(parsed.disclosureLevel).toBe(false);
    expect(parsed.diffView).toBe(false);
    expect(parsed.configReloadNotice).toBe(false);
  });

  it('AppConfigSchema 顶层包含 ui.components 字段', () => {
    // 验证完整配置 schema 能正确解析 ui.components
    const parsed = AppConfigSchema.parse({
      providers: [],
      ui: {
        components: {
          tracePanel: true,
          progressBar: false,
        },
      },
    });
    expect(parsed.ui.components.tracePanel).toBe(true);
    expect(parsed.ui.components.progressBar).toBe(false);
    // 未指定的字段使用默认值
    expect(parsed.ui.components.branchSwitcher).toBe(true);
    expect(parsed.ui.components.diffView).toBe(true);
  });
});

describe('Phase 50 Task 7: BranchSwitcher 在有分支时渲染', () => {
  it('多个分支时渲染树形结构，当前分支高亮', () => {
    const branches: BranchInfo[] = [
      {
        id: 'main', name: 'main', tipNodeId: 'n1', messageCount: 12,
        isActive: true, createdAt: 0, parentId: null, lastActiveAt: Date.now(),
      },
      {
        id: 'feat', name: 'feature-auth', tipNodeId: 'n2', messageCount: 5,
        isActive: false, createdAt: 1, parentId: 'main', lastActiveAt: Date.now(),
      },
    ];
    const text = renderBranchTreeText(branches, 'main');
    // 当前分支用实心圆
    expect(text).toContain('● main');
    // 非当前分支用空心圆
    expect(text).toContain('○ feature-auth');
    // 树形连接符
    expect(text).toContain('└─');
    // 包含切换提示
    expect(text).toContain('/branch switch');
  });

  it('空分支列表返回友好提示', () => {
    const text = renderBranchTreeText([], null);
    expect(text).toContain('没有分支');
  });
});

describe('Phase 50 Task 7: ProgressBar 正确显示进度', () => {
  it('0% 进度时全部为空白字符', () => {
    const bar = renderProgressBar(0, 10, 10);
    // 0% 时应该全是 ░
    expect(bar).toBe('░'.repeat(10));
  });

  it('50% 进度时一半填充一半空白', () => {
    const bar = renderProgressBar(5, 10, 10);
    expect(bar).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('100% 进度时全部填充', () => {
    const bar = renderProgressBar(10, 10, 10);
    expect(bar).toBe('█'.repeat(10));
  });

  it('total 为 0 时返回全部填充（避免除零）', () => {
    const bar = renderProgressBar(0, 0, 10);
    expect(bar).toBe('█'.repeat(10));
  });
});

describe('Phase 50 Task 7: DiffView 正确渲染 diff', () => {
  const SAMPLE_DIFF = `--- a/src/handler.ts
+++ b/src/handler.ts
@@ -10,3 +10,5 @@
   const x = 1;
-  return x;
+  const y = 2;
+  return x + y;
`;

  it('解析 diff 并渲染包含文件名、统计和操作提示', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    expect(parsed.fileName).toBe('src/handler.ts');
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);

    const text = renderDiffText(parsed);
    expect(text).toContain('src/handler.ts');
    expect(text).toContain('+2 -1');
    expect(text).toContain('[A] 全部接受');
    expect(text).toContain('[R] 全部拒绝');
    expect(text).toContain('[S] 逐行审查');
  });

  it('空 diff 返回提示文本', () => {
    const text = renderDiffText({ fileName: '', additions: 0, deletions: 0, hunks: [] });
    expect(text).toContain('未检测到 diff 内容');
  });
});

describe('Phase 50 Task 7: ConfigReloadUI 在配置变更时显示通知', () => {
  it('配置变更时生成对应的通知（含热更新和冷更新）', () => {
    const oldConfig = {
      autonomy: { defaultMode: 'semi' },
      providers: [{ id: 'openai' }],
    };
    const newConfig = {
      autonomy: { defaultMode: 'auto' },
      providers: [{ id: 'openai' }, { id: 'deepseek' }],
    };
    const notices = generateReloadNotices(oldConfig, newConfig);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    // 自主模式变更为热更新
    const hotNotice = notices.find(n => n.message.includes('自主模式'));
    expect(hotNotice).toBeDefined();
    expect(hotNotice!.hot).toBe(true);
    // providers 变更为冷更新
    const coldNotice = notices.find(n => n.message.includes('Provider'));
    expect(coldNotice).toBeDefined();
    expect(coldNotice!.hot).toBe(false);
  });

  it('无变更时返回空通知列表', () => {
    const config = { autonomy: { defaultMode: 'semi' } };
    const notices = generateReloadNotices(config, config);
    expect(notices).toEqual([]);
  });
});

describe('Phase 50 Task 7: /resume 命令接入 ResumePicker', () => {
  it('多快照 + resumePicker 开关开启时触发 showResumePicker 回调', async () => {
    const goals = [
      makeGoal({ id: 'plan-001', spec: { goal: '任务A', context: '', steps: [], done: '', verification: '' } }),
      makeGoal({ id: 'plan-002', spec: { goal: '任务B', context: '', steps: [], done: '', verification: '' }, status: 'failed' }),
    ];
    const { ctx, showResumePicker } = makeResumeMockCtx(goals, {
      resumePickerEnabled: true,
    });

    const result = await resumeCommand.handler('', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 回调被调用，传入 goals 列表（E11：原 snapshots → goals，类型从 ExecutionSnapshot 改为 PersistedGoal）
    expect(showResumePicker).toHaveBeenCalledTimes(1);
    expect(showResumePicker).toHaveBeenCalledWith(goals);
    // 返回空消息（UI 由 React 组件接管）
    if (result.type === 'handled') {
      expect(result.messages).toEqual([]);
    }
  });

  it('resumePicker 开关关闭时回退到纯文本列表（向后兼容）', async () => {
    const goals = [
      makeGoal({ id: 'plan-001', spec: { goal: '任务A', context: '', steps: [], done: '', verification: '' } }),
      makeGoal({ id: 'plan-002', spec: { goal: '任务B', context: '', steps: [], done: '', verification: '' } }),
    ];
    const { ctx, showResumePicker } = makeResumeMockCtx(goals, {
      resumePickerEnabled: false,
    });

    const result = await resumeCommand.handler('', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 回调不应被调用
    expect(showResumePicker).not.toHaveBeenCalled();
    // 返回纯文本列表
    if (result.type === 'handled' && result.messages) {
      const text = result.messages[0];
      expect(text).toContain('可恢复的执行 (2)');
      expect(text).toContain('plan-001');
      expect(text).toContain('plan-002');
    }
  });

  it('单个快照时直接返回文本列表（不触发 ResumePicker）', async () => {
    const goals = [makeGoal({ id: 'plan-001' })];
    const { ctx, showResumePicker } = makeResumeMockCtx(goals, {
      resumePickerEnabled: true,
    });

    const result = await resumeCommand.handler('', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 单个目标不触发交互式选择器
    expect(showResumePicker).not.toHaveBeenCalled();
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('plan-001');
    }
  });
});

describe('Phase 50 Task 7: /trace 命令接入 TracePanel', () => {
  it('tracePanel 开关开启时触发 showTracePanel 回调', async () => {
    const spans = [makeToolCallSpan()];
    const { ctx, showTracePanel } = makeTraceMockCtx(spans, {
      tracePanelEnabled: true,
      sessionId: 'session-trace-001',
    });

    const result = await traceCommand.handler('view', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 回调被调用，传入时间线条目和会话 ID
    expect(showTracePanel).toHaveBeenCalledTimes(1);
    const [entries, sessionId] = showTracePanel.mock.calls[0];
    expect(entries.length).toBeGreaterThan(0);
    expect(sessionId).toBe('session-trace-001');
    // 返回空消息（UI 由 React 组件接管）
    if (result.type === 'handled') {
      expect(result.messages).toEqual([]);
    }
  });

  it('tracePanel 开关关闭时回退到纯文本时间线（默认行为）', async () => {
    const spans = [makeToolCallSpan()];
    const { ctx, showTracePanel } = makeTraceMockCtx(spans, {
      tracePanelEnabled: false,
    });

    const result = await traceCommand.handler('view', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 回调不应被调用
    expect(showTracePanel).not.toHaveBeenCalled();
    // 返回纯文本时间线
    if (result.type === 'handled' && result.messages) {
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  it('无 spans 时返回"暂无 Trace 记录"（不受开关影响）', async () => {
    const { ctx, showTracePanel } = makeTraceMockCtx([], {
      tracePanelEnabled: true,
    });

    const result = await traceCommand.handler('view', ctx as ServiceContext);

    expect(result.type).toBe('handled');
    // 无数据时不触发回调
    expect(showTracePanel).not.toHaveBeenCalled();
    if (result.type === 'handled' && result.messages) {
      expect(result.messages[0]).toContain('暂无 Trace 记录');
    }
  });
});
