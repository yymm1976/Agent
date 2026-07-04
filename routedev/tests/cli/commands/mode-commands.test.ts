// tests/cli/commands/mode-commands.test.ts
// /architect /code /ask 命令测试（Phase 74）：
//   - /architect 切到 architect 模式
//   - /code 切到 code 模式（从 architect/ask 切回）
//   - /ask 无参数时返回用法
//   - /ask <question> 切到 ask 模式并返回 passthrough
//   - /ask 后调用 restoreMode 恢复原模式

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { architectCommand } from '../../../src/cli/commands/architect.js';
import { codeCommand } from '../../../src/cli/commands/code.js';
import { askCommand } from '../../../src/cli/commands/ask.js';
import { modeManager } from '../../../src/cli/commands/mode-manager.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';

function buildMockCtx(): ServiceContext {
  return {
    commandBridge: {
      addSystemMessage: vi.fn(),
    },
  } as unknown as ServiceContext;
}

describe('模式切换命令', () => {
  beforeEach(() => {
    modeManager.reset();
  });

  describe('/architect', () => {
    it('命令名与描述正确', () => {
      expect(architectCommand.name).toBe('architect');
      expect(architectCommand.description).toContain('architect');
    });

    it('从 code 切到 architect 模式', async () => {
      const ctx = buildMockCtx();
      const result = await architectCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(modeManager.getMode()).toBe('architect');
      const msg = result.messages?.[0] ?? '';
      expect(msg).toContain('Architect 模式');
      expect(msg).toContain('来自 code 模式');
    });

    it('已是 architect 模式时提示', async () => {
      modeManager.setMode('architect');
      const ctx = buildMockCtx();
      const result = await architectCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages?.[0]).toContain('已是此模式');
      expect(modeManager.getMode()).toBe('architect');
    });

    it('返回消息包含规划与执行说明', async () => {
      const ctx = buildMockCtx();
      const result = await architectCommand.handler('', ctx);
      const msg = (result.messages ?? []).join('\n');
      expect(msg).toContain('规划');
      expect(msg).toContain('执行');
      expect(msg).toContain('/code');
    });
  });

  describe('/code', () => {
    it('命令名与描述正确', () => {
      expect(codeCommand.name).toBe('code');
      expect(codeCommand.description).toContain('code');
    });

    it('从 architect 切回 code 模式', async () => {
      modeManager.setMode('architect');
      const ctx = buildMockCtx();
      const result = await codeCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(modeManager.getMode()).toBe('code');
      expect(result.messages?.[0]).toContain('来自 architect 模式');
    });

    it('从 ask 切回 code 模式', async () => {
      modeManager.setMode('ask');
      const ctx = buildMockCtx();
      const result = await codeCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(modeManager.getMode()).toBe('code');
      expect(result.messages?.[0]).toContain('来自 ask 模式');
    });

    it('已是 code 模式时提示', async () => {
      const ctx = buildMockCtx();
      const result = await codeCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages?.[0]).toContain('已是此模式');
    });
  });

  describe('/ask', () => {
    it('命令名与描述正确', () => {
      expect(askCommand.name).toBe('ask');
      expect(askCommand.description).toContain('问答');
    });

    it('无参数时返回用法提示', async () => {
      const ctx = buildMockCtx();
      const result = await askCommand.handler('', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages?.[0]).toContain('用法');
      expect(modeManager.getMode()).toBe('code'); // 未切换
    });

    it('切到 ask 模式并返回 passthrough', async () => {
      const ctx = buildMockCtx();
      const result = await askCommand.handler('这个函数做什么的？', ctx);
      expect(result.type).toBe('passthrough');
      expect(result.input).toBe('这个函数做什么的？');
      expect(modeManager.getMode()).toBe('ask');
    });

    it('ask 模式下 system prompt 包含只读说明', async () => {
      const ctx = buildMockCtx();
      await askCommand.handler('question', ctx);
      const addendum = modeManager.getSystemPromptAddendum();
      expect(addendum).toContain('只读');
      expect(addendum).toContain('file_edit');
    });

    it('调用 addSystemMessage 通知进入 ask 模式', async () => {
      const ctx = buildMockCtx();
      await askCommand.handler('question', ctx);
      expect(ctx.commandBridge.addSystemMessage).toHaveBeenCalled();
      const call = (ctx.commandBridge.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(call).toContain('Ask 模式');
      expect(call).toContain('禁用');
    });

    it('restoreMode 从 ask 恢复到原模式', async () => {
      modeManager.setMode('architect');
      const ctx = buildMockCtx();
      await askCommand.handler('question', ctx);
      expect(modeManager.getMode()).toBe('ask');

      const restored = modeManager.restoreMode();
      expect(restored).toBe(true);
      expect(modeManager.getMode()).toBe('architect');
    });

    it('从 code 进入 ask 后 restoreMode 回到 code', async () => {
      const ctx = buildMockCtx();
      await askCommand.handler('q', ctx);
      expect(modeManager.getMode()).toBe('ask');

      modeManager.restoreMode();
      expect(modeManager.getMode()).toBe('code');
    });
  });

  describe('模式切换组合', () => {
    it('code → architect → ask → 恢复 → architect → code', async () => {
      const ctx = buildMockCtx();
      expect(modeManager.getMode()).toBe('code');

      await architectCommand.handler('', ctx);
      expect(modeManager.getMode()).toBe('architect');

      await askCommand.handler('q', ctx);
      expect(modeManager.getMode()).toBe('ask');

      modeManager.restoreMode();
      expect(modeManager.getMode()).toBe('architect');

      await codeCommand.handler('', ctx);
      expect(modeManager.getMode()).toBe('code');
    });
  });
});
