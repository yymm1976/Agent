// tests/integration/phase47-task5.test.ts
// Phase 47 Task 5 集成测试：/review 独立子代理对抗性审查
//
// 测试策略：
//   1. /review 命令定义正确（name, aliases, description）
//   2. 无变更时返回「无需审查」消息
//   3. 有变更时构建审查 prompt（含 focus 参数）
//   4. 审查子代理不接收主会话的 conversationHistory（验证 isolated: true）
//   5. 审查子代理只有只读工具，file_write 被拒绝（验证 subagentType: 'reviewer'）
//   6. /review security 聚焦安全审查（prompt 中包含安全相关关键词）
//   7. 审查结果格式化正确（含问题数量与详情）
//   8. 陷阱 #137：调用子代理前沙箱级被临时设为 read-only，调用后恢复

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ============================================================
// Mock simple-git（必须在 import review.ts 之前）
// ============================================================
const mockCheckIsRepo = vi.fn();
const mockDiff = vi.fn();
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    checkIsRepo: mockCheckIsRepo,
    diff: mockDiff,
  })),
}));

// 导入被测模块
import { reviewCommand, buildReviewPrompt, parseReviewResult, type ReviewFocus } from '../../src/cli/commands/review.js';
import type { ServiceContext } from '../../src/cli/service-context.js';
import { PermissionEngine, type SandboxLevel } from '../../src/tools/permission-engine.js';

// ============================================================
// 工具函数：构造 mock ServiceContext
// ============================================================

/** 记录 spawn_agent 调用参数 */
interface SpawnCall {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

/** 创建 mock ServiceContext，捕获 spawn_agent 调用 */
function createMockCtx(overrides: {
  cwd?: string;
  spawnResult?: string;
  permissionEngine?: PermissionEngine;
} = {}): ServiceContext & { spawnCalls: SpawnCall[]; addSystemMessages: string[] } {
  const spawnCalls: SpawnCall[] = [];
  const addSystemMessages: string[] = [];

  const toolExecutor = {
    executeTool: vi.fn(async (toolName: string, toolCallId: string, args: Record<string, unknown>) => {
      spawnCalls.push({ toolName, toolCallId, args });
      return overrides.spawnResult ?? '### Critical\n- [src/foo.ts:10] 示例问题 → 修复建议';
    }),
  };

  const commandBridge = {
    addSystemMessage: vi.fn((content: string) => {
      addSystemMessages.push(content);
    }),
  } as unknown as ServiceContext['commandBridge'];

  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    toolExecutor,
    commandBridge,
    permissionEngine: overrides.permissionEngine,
  } as unknown as ServiceContext;

  // 附加测试用捕获字段
  (ctx as unknown as { spawnCalls: SpawnCall[] }).spawnCalls = spawnCalls;
  (ctx as unknown as { addSystemMessages: string[] }).addSystemMessages = addSystemMessages;

  return ctx as ServiceContext & { spawnCalls: SpawnCall[]; addSystemMessages: string[] };
}

/** 创建临时目录作为 cwd */
function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `routedev-phase47-task5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 示例 diff 文本 */
const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,8 @@ function foo() {
   const x = 1;
-  return x;
+  const y = 2;
+  return x + y;
+  eval(userInput);
}`;

/** 示例审查输出（含 critical/major/minor 各级问题） */
const SAMPLE_REVIEW_OUTPUT = `### Critical
- [src/foo.ts:13] eval() 执行用户输入，存在代码注入风险 → 改用 JSON.parse 或白名单校验

### Major
- [src/foo.ts:11] 变量 y 命名过于简短 → 改用有意义的名称如 delta

### Minor
- [src/foo.ts:12] 缺少分号 → 统一加分号

### 总结
问题总数：3 个（critical: 1, major: 1, minor: 1）`;

// ============================================================
// 1. /review 命令定义正确
// ============================================================
describe('Phase 47 Task 5 - /review 命令定义', () => {
  it('命令名为 review', () => {
    expect(reviewCommand.name).toBe('review');
  });

  it('别名为 rv', () => {
    expect(reviewCommand.aliases).toContain('rv');
  });

  it('description 包含「审查」', () => {
    expect(reviewCommand.description).toContain('审查');
  });

  it('handler 是函数', () => {
    expect(typeof reviewCommand.handler).toBe('function');
  });

  it('usage 字段已定义', () => {
    expect(reviewCommand.usage).toBeDefined();
    expect(reviewCommand.usage).toContain('review');
  });
});

// ============================================================
// 2. 无变更时返回「无需审查」消息
// ============================================================
describe('Phase 47 Task 5 - 无变更时返回无需审查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('diff 为空时返回无需审查消息', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue('');

    const ctx = createMockCtx();
    const result = await reviewCommand.handler('', ctx);

    expect(result.type).toBe('handled');
    expect(result.messages).toBeDefined();
    expect(result.messages![0]).toContain('无需审查');
  });

  it('diff 仅含空白时也返回无需审查', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue('   \n  \n');

    const ctx = createMockCtx();
    const result = await reviewCommand.handler('', ctx);

    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('无需审查');
  });

  it('非 Git 仓库时返回提示', async () => {
    mockCheckIsRepo.mockResolvedValue(false);

    const ctx = createMockCtx();
    const result = await reviewCommand.handler('', ctx);

    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('Git 仓库');
  });
});

// ============================================================
// 3. 有变更时构建审查 prompt（含 focus 参数）
// ============================================================
describe('Phase 47 Task 5 - 有变更时构建审查 prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有变更时调用 spawn_agent 并传入构建的 prompt', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx({
      spawnResult: '### 总结\n未发现问题',
    });

    await reviewCommand.handler('', ctx);

    expect(ctx.spawnCalls.length).toBe(1);
    const call = ctx.spawnCalls[0];
    expect(call.toolName).toBe('spawn_agent');
    expect(call.args.description).toContain('对抗性代码审查');
    expect(call.args.prompt).toContain('diff');
    expect(call.args.prompt).toContain('src/foo.ts');
    // 默认 focus 为 correctness
    expect(call.args.prompt).toContain('正确性');
  });

  it('prompt 中包含 focus 关键词', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('performance', ctx);

    const prompt = ctx.spawnCalls[0].args.prompt as string;
    expect(prompt).toContain('性能');
    expect(prompt).toContain('时间复杂度');
  });
});

// ============================================================
// 4. 审查子代理不接收主会话的 conversationHistory（验证 isolated: true）
// ============================================================
describe('Phase 47 Task 5 - 子代理不共享主会话 conversationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawn_agent 调用时 isolated: true', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('', ctx);

    expect(ctx.spawnCalls.length).toBe(1);
    const call = ctx.spawnCalls[0];
    // isolated: true 是关键声明，确保子代理不接收主会话历史
    expect(call.args.isolated).toBe(true);
  });

  it('spawn_agent 不传入主会话的 conversationHistory 字段', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('', ctx);

    const call = ctx.spawnCalls[0];
    // spawn_agent 工具签名不包含 conversationHistory 字段
    // 子代理内部硬编码 conversationHistory: []（见 app-init.ts）
    expect(call.args.conversationHistory).toBeUndefined();
    expect(call.args.history).toBeUndefined();
  });
});

// ============================================================
// 5. 审查子代理只有只读工具，file_write 被拒绝（验证 subagentType: 'reviewer'）
// ============================================================
describe('Phase 47 Task 5 - 子代理工具白名单（reviewer）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subagentType 为 reviewer', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('', ctx);

    const call = ctx.spawnCalls[0];
    expect(call.args.subagentType).toBe('reviewer');
  });

  it('reviewer 白名单不包含 file_write（验证白名单定义）', async () => {
    // 直接验证 SUBAGENT_TOOL_WHITELIST 常量
    const { SUBAGENT_TOOL_WHITELIST } = await import('../../src/tools/builtin/spawn-agent.js');
    const reviewerTools = SUBAGENT_TOOL_WHITELIST.reviewer;

    expect(reviewerTools.has('file_read')).toBe(true);
    expect(reviewerTools.has('code_search')).toBe(true);
    expect(reviewerTools.has('list_directory')).toBe(true);
    // 写工具不在 reviewer 白名单中
    expect(reviewerTools.has('file_write')).toBe(false);
    expect(reviewerTools.has('file_edit')).toBe(false);
    expect(reviewerTools.has('shell_exec')).toBe(false);
  });

  it('reviewer 白名单不包含网络和 shell 工具', async () => {
    const { SUBAGENT_TOOL_WHITELIST } = await import('../../src/tools/builtin/spawn-agent.js');
    const reviewerTools = SUBAGENT_TOOL_WHITELIST.reviewer;

    expect(reviewerTools.has('web_search')).toBe(false);
    expect(reviewerTools.has('web_fetch')).toBe(false);
    expect(reviewerTools.has('shell_exec')).toBe(false);
    expect(reviewerTools.has('git_op')).toBe(false);
  });
});

// ============================================================
// 6. /review security 聚焦安全审查（prompt 中包含安全相关关键词）
// ============================================================
describe('Phase 47 Task 5 - /review security 聚焦安全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('security focus 时 prompt 包含安全关键词', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('security', ctx);

    const prompt = ctx.spawnCalls[0].args.prompt as string;
    expect(prompt).toContain('安全性');
    // 安全审查关键词
    expect(prompt).toContain('注入');
    expect(prompt).toContain('敏感信息');
    expect(prompt).toContain('权限提升');
  });

  it('security focus 时 description 标注 focus', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('security', ctx);

    const desc = ctx.spawnCalls[0].args.description as string;
    expect(desc).toContain('security');
  });

  it('非法 focus 值默认为 correctness', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx();
    await reviewCommand.handler('invalid-focus', ctx);

    const prompt = ctx.spawnCalls[0].args.prompt as string;
    expect(prompt).toContain('正确性');
  });
});

// ============================================================
// 7. 审查结果格式化正确（含问题数量与详情）
// ============================================================
describe('Phase 47 Task 5 - 审查结果格式化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('输出包含问题总数和各级别数量', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx({
      spawnResult: SAMPLE_REVIEW_OUTPUT,
    });

    const result = await reviewCommand.handler('security', ctx);

    expect(result.type).toBe('handled');
    const output = result.messages![0];
    expect(output).toContain('问题总数');
    expect(output).toContain('critical: 1');
    expect(output).toContain('major: 1');
    expect(output).toContain('minor: 1');
  });

  it('输出包含审查侧重和变更文件数', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx({
      spawnResult: SAMPLE_REVIEW_OUTPUT,
    });

    const result = await reviewCommand.handler('security', ctx);

    const output = result.messages![0];
    expect(output).toContain('审查侧重');
    expect(output).toContain('安全性');
    expect(output).toContain('变更文件数');
  });

  it('输出包含原始审查内容', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const ctx = createMockCtx({
      spawnResult: SAMPLE_REVIEW_OUTPUT,
    });

    const result = await reviewCommand.handler('', ctx);

    const output = result.messages![0];
    expect(output).toContain('eval()');
    expect(output).toContain('代码注入');
  });

  it('parseReviewResult 正确解析问题数量', () => {
    const counts = parseReviewResult(SAMPLE_REVIEW_OUTPUT);
    expect(counts.critical).toBe(1);
    expect(counts.major).toBe(1);
    expect(counts.minor).toBe(1);
    expect(counts.total).toBe(3);
  });

  it('parseReviewResult 无问题时返回 0', () => {
    const output = '### 总结\n未发现正确性方面的问题';
    const counts = parseReviewResult(output);
    expect(counts.total).toBe(0);
    expect(counts.critical).toBe(0);
    expect(counts.major).toBe(0);
    expect(counts.minor).toBe(0);
  });
});

// ============================================================
// 8. 陷阱 #137：沙箱级确定性兜底
// ============================================================
describe('Phase 47 Task 5 - 陷阱 #137：沙箱级确定性兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用子代理前沙箱级被临时设为 read-only', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const engine = new PermissionEngine();
    engine.setSandboxLevel('full-access'); // 初始 full-access
    const ctx = createMockCtx({ permissionEngine: engine });

    // 在 executeTool 调用瞬间检查沙箱级
    let sandboxDuringCall: SandboxLevel | null = null;
    ctx.toolExecutor.executeTool = vi.fn(async () => {
      sandboxDuringCall = engine.getSandboxLevel();
      return '### 总结\n无问题';
    });

    await reviewCommand.handler('', ctx);

    // 子代理执行期间沙箱级应为 read-only
    expect(sandboxDuringCall).toBe('read-only');
  });

  it('调用完成后沙箱级恢复原值', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const engine = new PermissionEngine();
    engine.setSandboxLevel('workspace-write'); // 初始 workspace-write
    const ctx = createMockCtx({ permissionEngine: engine });

    await reviewCommand.handler('', ctx);

    // 调用完成后沙箱级恢复
    expect(engine.getSandboxLevel()).toBe('workspace-write');
  });

  it('子代理失败时沙箱级也恢复（finally 块）', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    const engine = new PermissionEngine();
    engine.setSandboxLevel('full-access');
    const ctx = createMockCtx({ permissionEngine: engine });

    // 让 spawn_agent 返回错误
    ctx.toolExecutor.executeTool = vi.fn(async () => '[工具错误] spawn_agent: 子代理执行失败');

    await reviewCommand.handler('', ctx);

    // 即使失败，沙箱级也恢复
    expect(engine.getSandboxLevel()).toBe('full-access');
  });

  it('无 permissionEngine 时不报错（向后兼容）', async () => {
    mockCheckIsRepo.mockResolvedValue(true);
    mockDiff.mockResolvedValue(SAMPLE_DIFF);

    // 不传入 permissionEngine
    const ctx = createMockCtx({ permissionEngine: undefined });

    const result = await reviewCommand.handler('', ctx);

    expect(result.type).toBe('handled');
    // 仍能正常执行
    expect(ctx.spawnCalls.length).toBe(1);
  });
});

// ============================================================
// 9. buildReviewPrompt 单元测试
// ============================================================
describe('Phase 47 Task 5 - buildReviewPrompt 单元测试', () => {
  it('correctness focus 包含正确性关键词', () => {
    const prompt = buildReviewPrompt('correctness', SAMPLE_DIFF, ['src/foo.ts']);
    expect(prompt).toContain('正确性');
    expect(prompt).toContain('逻辑错误');
    expect(prompt).toContain('边界条件');
  });

  it('style focus 包含风格关键词', () => {
    const prompt = buildReviewPrompt('style', SAMPLE_DIFF, ['src/foo.ts']);
    expect(prompt).toContain('代码风格');
    expect(prompt).toContain('命名规范');
    expect(prompt).toContain('可读性');
  });

  it('变更文件列表正确渲染', () => {
    const prompt = buildReviewPrompt('correctness', SAMPLE_DIFF, ['src/a.ts', 'src/b.ts']);
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
  });

  it('过长的 diff 被截断', () => {
    const longDiff = 'diff --git a/x b/x\n' + '+'.repeat(10000);
    const prompt = buildReviewPrompt('correctness', longDiff, ['x']);
    expect(prompt.length).toBeLessThan(longDiff.length + 5000);
    expect(prompt).toContain('已截断');
  });
});
