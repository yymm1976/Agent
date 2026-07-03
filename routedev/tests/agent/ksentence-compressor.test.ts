import { describe, it, expect } from 'vitest';
import { KSentenceCompressor } from '../../src/agent/ksentence-compressor.js';

describe('KSentenceCompressor', () => {
  describe('splitSentences 中英文标点', () => {
    it('英文句号分割', () => {
      const comp = new KSentenceCompressor();
      const s = comp.splitSentences('Hello world. This is test. Done.');
      expect(s.length).toBe(3);
    });

    it('中文句号分割', () => {
      const comp = new KSentenceCompressor();
      const s = comp.splitSentences('你好世界。这是测试。完成。');
      expect(s.length).toBe(3);
    });

    it('感叹号和问号', () => {
      const comp = new KSentenceCompressor();
      const s = comp.splitSentences('Hello! How are you? Fine.');
      expect(s.length).toBe(3);
    });

    it('换行符分割', () => {
      const comp = new KSentenceCompressor();
      const s = comp.splitSentences('Line one.\nLine two.\n');
      expect(s.length).toBe(2);
    });
  });

  describe('scoreSentence 关键词得分', () => {
    it('含 error/throw/function 的句子得分更高', () => {
      const comp = new KSentenceCompressor();
      const withError = comp.scoreSentence('throw new Error("x")', 0, 5);
      const plain = comp.scoreSentence('普通文本描述', 0, 5);
      expect(withError).toBeGreaterThan(plain);
    });

    it('位置首句/末句得分 > 中间句', () => {
      const comp = new KSentenceCompressor();
      const first = comp.scoreSentence('same text here.', 0, 5);
      const middle = comp.scoreSentence('same text here.', 2, 5);
      const last = comp.scoreSentence('same text here.', 4, 5);
      expect(first).toBeGreaterThan(middle);
      expect(last).toBeGreaterThan(middle);
    });

    it('长度在 20-200 字符得分最高', () => {
      const comp = new KSentenceCompressor();
      const medium = comp.scoreSentence('a'.repeat(50), 1, 3);
      const tooShort = comp.scoreSentence('short', 1, 3);
      expect(medium).toBeGreaterThan(tooShort);
    });
  });

  describe('compress 句数 <= k 不压缩', () => {
    it('句数 <= k 时返回原内容，wasCompressed=false', () => {
      const comp = new KSentenceCompressor({ k: 4, scoring: { keywordWeight: 0.5, lengthWeight: 0.3, positionWeight: 0.2 } });
      const result = comp.compress('一句话。');
      expect(result.wasCompressed).toBe(false);
      expect(result.keptSentenceCount).toBe(result.originalSentenceCount);
    });
  });

  describe('compress 句数 > k 保留 top-k', () => {
    it('压缩后保留 k 个关键句', () => {
      const comp = new KSentenceCompressor({ k: 2, scoring: { keywordWeight: 0.5, lengthWeight: 0.3, positionWeight: 0.2 } });
      const content = '第一句介绍内容。第二句 throw new Error 重要信息。第三句普通描述。第四句无关紧要。';
      const result = comp.compress(content);
      expect(result.wasCompressed).toBe(true);
      expect(result.keptSentenceCount).toBe(2);
      expect(result.compressed).toContain('K-sentence 压缩');
    });
  });

  describe('compressMessages', () => {
    it('跳过 system 消息不压缩', () => {
      const comp = new KSentenceCompressor({ k: 1, scoring: { keywordWeight: 0.5, lengthWeight: 0.3, positionWeight: 0.2 } });
      const messages = [
        { role: 'system', content: '这是系统消息。非常重要。不能压缩。即使是超过 k 句也不能。' },
      ];
      const result = comp.compressMessages(messages);
      expect(result[0].content).toBe(messages[0].content);
    });

    it('压缩 user 和 assistant 消息', () => {
      const comp = new KSentenceCompressor({ k: 1, scoring: { keywordWeight: 0.5, lengthWeight: 0.3, positionWeight: 0.2 } });
      const messages = [
        { role: 'user', content: '第一句普通内容。第二句 throw error 关键信息。第三句无关。' },
      ];
      const result = comp.compressMessages(messages);
      expect(typeof result[0].content).toBe('string');
      if (typeof result[0].content === 'string') {
        expect(result[0].content).toContain('K-sentence');
      }
    });

    it('保留原消息 role 与 metadata', () => {
      const comp = new KSentenceCompressor({ k: 1, scoring: { keywordWeight: 0.5, lengthWeight: 0.3, positionWeight: 0.2 } });
      const messages = [
        { role: 'assistant', content: 'a'.repeat(100) + '。' + 'b'.repeat(100) + '。' + 'c'.repeat(100) + '。', meta: 'test' },
      ];
      const result = comp.compressMessages(messages);
      expect(result[0].role).toBe('assistant');
    });
  });
});
