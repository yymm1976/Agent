// tests/cli/completion.test.ts

import { describe, it, expect } from 'vitest';
import { createCompleter, COMMAND_COMPLETIONS } from '../../src/cli/completion.js';

describe('createCompleter', () => {
  it('completes command names', () => {
    const completer = createCompleter();
    const [hits] = completer('/he');
    expect(hits).toContain('/help');
  });

  it('completes subcommands', () => {
    const completer = createCompleter();
    const [hits] = completer('/memory sh');
    expect(hits).toContain('/memory show');
  });

  it('returns empty for non-command input', () => {
    const completer = createCompleter();
    const [hits, line] = completer('hello');
    expect(hits).toEqual([]);
    expect(line).toBe('hello');
  });

  it('returns all known commands when line is /', () => {
    const completer = createCompleter(COMMAND_COMPLETIONS);
    const [hits] = completer('/');
    expect(hits.length).toBeGreaterThan(5);
    expect(hits).toContain('/status');
  });
});
