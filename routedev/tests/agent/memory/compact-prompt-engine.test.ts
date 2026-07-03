import { describe, it, expect, beforeEach } from 'vitest';
import { CompactPromptEngine } from '../../../src/agent/memory/compact-prompt-engine.js';

describe('CompactPromptEngine', () => {
  let engine: CompactPromptEngine;

  beforeEach(() => {
    engine = new CompactPromptEngine();
  });

  describe('getPrompt', () => {
    it('base direction contains NO_TOOLS preamble and base template markers', () => {
      const prompt = engine.getPrompt('base');
      expect(prompt).toContain('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.');
      expect(prompt).toContain('Your task is to create a detailed summary of the conversation so far.');
      expect(prompt).toContain('1. Primary Request and Intent: Capture all of the user');
      expect(prompt).toContain('REMINDER: Do NOT call any tools.');
    });

    it('partial direction contains partial template', () => {
      const prompt = engine.getPrompt('partial');
      expect(prompt).toContain('RECENT portion of the conversation');
      expect(prompt).toContain('earlier retained context');
      expect(prompt).toContain('1. Primary Request and Intent from recent messages');
    });

    it('up_to direction contains up-to template', () => {
      const prompt = engine.getPrompt('up_to');
      expect(prompt).toContain('placed at the start of a continuing session');
      expect(prompt).toContain('8. Work Completed');
      expect(prompt).toContain('9. Context for Continuing Work');
    });

    it('appends custom instructions when provided', () => {
      const custom = 'Focus on summarizing the authentication module.';
      const prompt = engine.getPrompt('base', custom);
      expect(prompt).toContain('Additional Instructions:');
      expect(prompt).toContain(custom);
    });

    it('does not append custom instructions when not provided', () => {
      const prompt = engine.getPrompt('base');
      expect(prompt).not.toContain('Additional Instructions:');
    });

    it('does not append custom instructions when blank string', () => {
      const prompt = engine.getPrompt('base', '   ');
      expect(prompt).not.toContain('Additional Instructions:');
    });

    it('every direction includes both preamble and trailer', () => {
      for (const dir of ['base', 'partial', 'up_to'] as const) {
        const prompt = engine.getPrompt(dir);
        expect(prompt).toContain('CRITICAL: Respond with TEXT ONLY');
        expect(prompt).toContain('REMINDER: Do NOT call any tools');
      }
    });
  });

  describe('formatSummary', () => {
    it('strips <analysis> block', () => {
      const raw = '<analysis>thinking about stuff</analysis>\n<summary>real summary</summary>';
      const result = engine.formatSummary(raw);
      expect(result).not.toContain('<analysis>');
      expect(result).not.toContain('thinking about stuff');
      expect(result).toContain('Summary:');
      expect(result).toContain('real summary');
    });

    it('extracts <summary> content into "Summary:" prefix', () => {
      const raw = '<summary>\n1. Foo\n2. Bar\n</summary>';
      const result = engine.formatSummary(raw);
      expect(result).toContain('Summary:');
      expect(result).toContain('1. Foo');
      expect(result).toContain('2. Bar');
      expect(result).not.toContain('<summary>');
      expect(result).not.toContain('</summary>');
    });

    it('cleans multiple blank lines into single blank line', () => {
      const raw = 'line1\n\n\n\nline2\n\n\n\n\nline3';
      const result = engine.formatSummary(raw);
      expect(result).not.toMatch(/\n\n\n/);
      expect(result).toContain('line1');
      expect(result).toContain('line2');
      expect(result).toContain('line3');
    });

    it('trims leading and trailing whitespace', () => {
      const raw = '  \n\n  some content  \n\n  ';
      const result = engine.formatSummary(raw);
      expect(result).toBe('some content');
    });

    it('handles full realistic output with analysis and summary', () => {
      const raw = [
        '<analysis>',
        'The user asked to build a parser. I created parser.ts and added tests.',
        '</analysis>',
        '',
        '<summary>',
        '1. Primary Request: Build a parser',
        '2. Files: parser.ts, parser.test.ts',
        '</summary>',
      ].join('\n');
      const result = engine.formatSummary(raw);
      expect(result).not.toContain('<analysis>');
      expect(result).not.toContain('<summary>');
      expect(result).toContain('Summary:');
      expect(result).toContain('1. Primary Request: Build a parser');
      expect(result).toContain('2. Files: parser.ts, parser.test.ts');
    });
  });
});
