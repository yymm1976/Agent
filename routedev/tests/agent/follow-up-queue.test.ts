// tests/agent/follow-up-queue.test.ts
// Phase 73 Part C：Follow-up 消息队列单元测试
//
// 覆盖验收标准：
//   1. followUp() 把消息排入 follow-up 队列
//   2. drainFollowUpQueue 'all' 模式返回全部并清空队列
//   3. drainFollowUpQueue 'one-at-a-time' 模式仅返回第一条，剩余保留
//   4. clearAllQueues 清空 follow-up 队列
//   5. follow-up 消息通过 defaultConvertToLlm 转换为 user 消息（前缀 [后续任务]）
//   6. getFollowUpQueue / removeFollowUp / getQueueStatus 辅助 API 行为正确

import { describe, it, expect } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { defaultConvertToLlm } from '../../src/agent/message-types.js';
import type { AgentMessage, FollowUpMessage } from '../../src/agent/message-types.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';

// ============================================================
// 测试桩：无工具执行器（不参与本次测试，仅满足 Loop 构造参数）
// ============================================================

class NoOpToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() {
    return [];
  }
  async executeTool(toolName: string): Promise<string> {
    return `[系统提示] 工具 "${toolName}" 当前不可用。`;
  }
  hasTool(): boolean {
    return false;
  }
}

// ============================================================
// 辅助：通过类型断言访问 private 方法 drainFollowUpQueue
// 测试需要直接验证出队语义，避免为单个私有方法构造完整的 LLM mock
// ============================================================
type LoopWithDrain = ReActAgentLoop & {
  drainFollowUpQueue: () => FollowUpMessage[];
};

function createLoop(): LoopWithDrain {
  return new ReActAgentLoop(new NoOpToolExecutor()) as LoopWithDrain;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 73 Part C：follow-up 队列', () => {
  describe('followUp() 排队消息', () => {
    it('单条消息入队后，getFollowUpQueue 返回该条', () => {
      const loop = createLoop();
      loop.followUp('继续重构模块 A');
      const queue = loop.getFollowUpQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].role).toBe('follow_up');
      expect(queue[0].content).toBe('继续重构模块 A');
      expect(typeof queue[0].enqueuedAt).toBe('number');
    });

    it('多条消息按入队顺序保留', () => {
      const loop = createLoop();
      loop.followUp('任务一');
      loop.followUp('任务二');
      loop.followUp('任务三');
      const queue = loop.getFollowUpQueue();
      expect(queue.map((m) => m.content)).toEqual(['任务一', '任务二', '任务三']);
    });

    it('getFollowUpQueue 返回浅拷贝，外部修改不影响内部状态', () => {
      const loop = createLoop();
      loop.followUp('原始任务');
      const snapshot = loop.getFollowUpQueue();
      snapshot.pop();
      // 内部队列不应被影响
      expect(loop.getFollowUpQueue()).toHaveLength(1);
    });
  });

  describe('drainFollowUpQueue 出队语义', () => {
    it('空队列返回空数组', () => {
      const loop = createLoop();
      expect(loop.drainFollowUpQueue()).toEqual([]);
    });

    it("'all' 模式：一次性返回全部并清空队列", () => {
      const loop = createLoop();
      loop.setFollowUpMode('all');
      loop.followUp('任务一');
      loop.followUp('任务二');
      loop.followUp('任务三');

      const drained = loop.drainFollowUpQueue();
      expect(drained).toHaveLength(3);
      expect(drained.map((m) => m.content)).toEqual(['任务一', '任务二', '任务三']);
      // 队列应已清空
      expect(loop.getFollowUpQueue()).toHaveLength(0);
    });

    it("'one-at-a-time' 模式：仅返回最早入队的一条，剩余保留", () => {
      const loop = createLoop();
      // 默认即为 'one-at-a-time'，显式设置一次以验证 setter
      loop.setFollowUpMode('one-at-a-time');
      loop.followUp('任务一');
      loop.followUp('任务二');
      loop.followUp('任务三');

      const first = loop.drainFollowUpQueue();
      expect(first).toHaveLength(1);
      expect(first[0].content).toBe('任务一');
      // 剩余两条仍在队列中
      expect(loop.getFollowUpQueue()).toHaveLength(2);
      expect(loop.getFollowUpQueue().map((m) => m.content)).toEqual(['任务二', '任务三']);
    });

    it("'one-at-a-time' 模式：连续调用逐条出队直到空", () => {
      const loop = createLoop();
      loop.followUp('A');
      loop.followUp('B');

      expect(loop.drainFollowUpQueue()[0].content).toBe('A');
      expect(loop.drainFollowUpQueue()[0].content).toBe('B');
      expect(loop.drainFollowUpQueue()).toEqual([]);
    });

    it('模式切换不影响已入队消息的顺序', () => {
      const loop = createLoop();
      loop.followUp('A');
      loop.followUp('B');
      // 切换到 'all' 后再切换回 'one-at-a-time'，队列内容不应丢失或重排
      loop.setFollowUpMode('all');
      loop.setFollowUpMode('one-at-a-time');
      expect(loop.getFollowUpQueue().map((m) => m.content)).toEqual(['A', 'B']);
    });
  });

  describe('clearAllQueues 清空所有队列', () => {
    it('清空 follow-up 队列且 steering 队列保持为空（steer() 已删除，无外部入队入口）', () => {
      const loop = createLoop();
      // steer() 已删除（生产路径统一走 setSteeringConsumer），本地 steering 队列恒为空
      loop.followUp('后续任务');

      const statusBefore = loop.getQueueStatus();
      expect(statusBefore.steering).toBe(0);
      expect(statusBefore.followUp).toBe(1);

      loop.clearAllQueues();

      const statusAfter = loop.getQueueStatus();
      expect(statusAfter.steering).toBe(0);
      expect(statusAfter.followUp).toBe(0);
    });

    it('清空后 follow-up 队列出队返回空', () => {
      const loop = createLoop();
      loop.followUp('A');
      loop.clearAllQueues();
      expect(loop.drainFollowUpQueue()).toEqual([]);
    });
  });

  describe('removeFollowUp 删除单条', () => {
    it('删除指定索引的消息', () => {
      const loop = createLoop();
      loop.followUp('A');
      loop.followUp('B');
      loop.followUp('C');

      const ok = loop.removeFollowUp(1);
      expect(ok).toBe(true);
      expect(loop.getFollowUpQueue().map((m) => m.content)).toEqual(['A', 'C']);
    });

    it('删除第一条后顺序保留', () => {
      const loop = createLoop();
      loop.followUp('A');
      loop.followUp('B');

      expect(loop.removeFollowUp(0)).toBe(true);
      expect(loop.getFollowUpQueue().map((m) => m.content)).toEqual(['B']);
    });

    it('索引越界返回 false，队列不变', () => {
      const loop = createLoop();
      loop.followUp('A');

      expect(loop.removeFollowUp(-1)).toBe(false);
      expect(loop.removeFollowUp(99)).toBe(false);
      expect(loop.getFollowUpQueue()).toHaveLength(1);
    });

    it('空队列删除任何索引都返回 false', () => {
      const loop = createLoop();
      expect(loop.removeFollowUp(0)).toBe(false);
    });
  });

  describe('getQueueStatus 查询状态', () => {
    it('初始状态队列为空', () => {
      const loop = createLoop();
      const status = loop.getQueueStatus();
      expect(status).toEqual({ followUp: 0 });
    });

    it('反映 follow-up 队列长度变化', () => {
      const loop = createLoop();
      loop.followUp('A');
      expect(loop.getQueueStatus().followUp).toBe(1);

      loop.followUp('B');
      expect(loop.getQueueStatus().followUp).toBe(2);

      loop.clearAllQueues();
      expect(loop.getQueueStatus().followUp).toBe(0);
    });

  });

  describe('defaultConvertToLlm 转换 follow-up 消息', () => {
    it('follow_up 消息转为 user 消息，内容前缀 [后续任务]', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: '开始任务' },
        { role: 'assistant', content: '任务完成' },
        { role: 'follow_up', content: '继续下一个任务', enqueuedAt: Date.now() },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toHaveLength(3);
      // 前两条原样保留
      expect(result[0]).toEqual({ role: 'user', content: '开始任务' });
      expect(result[1]).toEqual({ role: 'assistant', content: '任务完成' });
      // follow_up 转为 user，内容加前缀
      expect(result[2].role).toBe('user');
      expect(result[2].content).toBe('[后续任务] 继续下一个任务');
    });

    it('多条 follow_up 消息各自独立转换', () => {
      const messages: AgentMessage[] = [
        { role: 'follow_up', content: '任务 A', enqueuedAt: 1 },
        { role: 'follow_up', content: '任务 B', enqueuedAt: 2 },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('[后续任务] 任务 A');
      expect(result[1].content).toBe('[后续任务] 任务 B');
    });

    it('steering 消息转为 user 消息，内容前缀 [用户转向指令]', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: '开始' },
        {
          role: 'steering',
          content: '改用另一个方案',
          enqueuedAt: Date.now(),
          mode: 'next_iteration',
        },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe('user');
      expect(result[1].content).toBe('[用户转向指令] 改用另一个方案');
    });

    it('steering 与 follow_up 混合时按顺序转换', () => {
      const messages: AgentMessage[] = [
        { role: 'user', content: '原始任务' },
        {
          role: 'steering',
          content: '调整方向',
          enqueuedAt: 1,
          mode: 'immediate',
        },
        { role: 'assistant', content: '已调整' },
        { role: 'follow_up', content: '接续任务', enqueuedAt: 2 },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user']);
      expect(result[1].content).toBe('[用户转向指令] 调整方向');
      expect(result[3].content).toBe('[后续任务] 接续任务');
    });
  });
});
