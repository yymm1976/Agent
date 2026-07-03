import { describe, it, expect } from 'vitest';
import { ActionChainDetector, ActionChain } from '../../../src/agent/memory/action-chain-detector.js';

const toolMsg = (name: string) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', name }],
});

const toolResultMsg = () => ({
  role: 'user',
  content: [{ type: 'tool_result' }],
});

const textMsg = (text: string) => ({
  role: 'user',
  content: text,
});

describe('ActionChainDetector', () => {
  describe('detect', () => {
    it('should detect chain of tool messages when count >= minToolCalls', () => {
      const detector = new ActionChainDetector(3);
      const messages = [
        textMsg('hello'),
        toolMsg('grep'),
        toolResultMsg(),
        toolMsg('read'),
        toolResultMsg(),
        toolMsg('write'),
        toolResultMsg(),
        textMsg('done'),
      ];

      const chains = detector.detect(messages);

      expect(chains).toHaveLength(1);
      expect(chains[0].startIndex).toBe(1);
      expect(chains[0].endIndex).toBe(7);
      expect(chains[0].chainType).toBe('repeated-tool');
      expect(chains[0].messageCount).toBe(6);
    });

    it('should ignore short chains when count < minToolCalls', () => {
      const detector = new ActionChainDetector(3);
      const messages = [
        toolMsg('grep'),
        toolMsg('read'),
      ];

      const chains = detector.detect(messages);

      expect(chains).toHaveLength(0);
    });

    it('should detect multiple chains', () => {
      const detector = new ActionChainDetector(2);
      const messages = [
        toolMsg('grep'),
        toolResultMsg(),
        toolMsg('grep'),
        toolResultMsg(),
        textMsg('break'),
        toolMsg('read'),
        toolResultMsg(),
        toolMsg('write'),
        toolResultMsg(),
      ];

      const chains = detector.detect(messages);

      expect(chains).toHaveLength(2);
      expect(chains[0].startIndex).toBe(0);
      expect(chains[0].endIndex).toBe(4);
      expect(chains[1].startIndex).toBe(5);
      expect(chains[1].endIndex).toBe(9);
    });

    it('should return empty when no tool messages', () => {
      const detector = new ActionChainDetector(3);
      const messages = [
        textMsg('hello'),
        textMsg('world'),
        textMsg('test'),
      ];

      const chains = detector.detect(messages);

      expect(chains).toHaveLength(0);
    });

    it('should detect chain at end of messages', () => {
      const detector = new ActionChainDetector(3);
      const messages = [
        textMsg('start'),
        toolMsg('grep'),
        toolResultMsg(),
        toolMsg('read'),
        toolResultMsg(),
        toolMsg('write'),
        toolResultMsg(),
      ];

      const chains = detector.detect(messages);

      expect(chains).toHaveLength(1);
      expect(chains[0].startIndex).toBe(1);
      expect(chains[0].endIndex).toBe(7);
    });
  });

  describe('collapseChain', () => {
    it('should produce system summary message', () => {
      const detector = new ActionChainDetector(3);
      const chain: ActionChain = {
        startIndex: 1,
        endIndex: 5,
        chainType: 'repeated-tool',
        summary: 'Used [grep, read] for 4 steps',
        messageCount: 4,
      };

      const result = detector.collapseChain(chain);

      expect(result.role).toBe('system');
      expect(result.content).toContain('[Collapsed]');
      expect(result.content).toContain('Used [grep, read] for 4 steps');
      expect(result.content).toContain('4 messages');
      expect(result.content).toContain('repeated-tool');
    });
  });
});
