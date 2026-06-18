// tests/cli/args.test.ts

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('defaults to interactive mode', () => {
    const args = parseArgs([]);
    expect(args.command).toBeUndefined();
    expect(args.version).toBe(false);
    expect(args.help).toBe(false);
  });

  it('parses serve subcommand', () => {
    const args = parseArgs(['serve']);
    expect(args.command).toBe('serve');
  });

  it('parses port override', () => {
    const args = parseArgs(['serve', '--port', '3000']);
    expect(args.port).toBe(3000);
  });

  it('parses short flags', () => {
    const args = parseArgs(['-p', '8080', '-c', './cfg.yaml']);
    expect(args.port).toBe(8080);
    expect(args.configPath).toBe('./cfg.yaml');
  });

  it('parses version and help', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('parses no-color and log-level', () => {
    const args = parseArgs(['--no-color', '--log-level', 'debug']);
    expect(args.noColor).toBe(true);
    expect(args.logLevel).toBe('debug');
  });

  it('throws on invalid port', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow('Invalid port');
  });
});
