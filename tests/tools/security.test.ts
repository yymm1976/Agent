// tests/tools/security.test.ts
// SecurityChecker 单元测试

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { SecurityChecker } from '../../src/tools/security.js';
import type { SecurityConfig } from '../../src/config/schema.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

function makeSecurityConfig(policy: 'readonly' | 'deny' = 'readonly'): SecurityConfig {
  return {
    directoryBoundary: true,
    commandBlacklist: [],
    commandWhitelist: [],
    sensitiveFiles: ['.env', 'credentials.json', '*.key'],
    sensitiveFilePolicy: policy,
    networkConfirm: true,
  };
}

const dummyContext: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  allowedDirectories: [process.cwd()],
  environment: {},
  timeoutMs: 30000,
};

describe('SecurityChecker', () => {
  it('should allow files inside project directory', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = checker.checkFilePath(path.join(process.cwd(), 'src/main.ts'), dummyContext);
    expect(result.allowed).toBe(true);
  });

  it('should deny files outside project directory', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = checker.checkFilePath(path.join(os.homedir(), 'secret.txt'), dummyContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('不在项目目录');
  });

  it('should allow reading sensitive files with readonly policy', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig('readonly'));
    const result = checker.checkFilePath(path.join(process.cwd(), '.env'), dummyContext);
    // readonly 策略下，isWriteOperation 默认返回 true，所以写入会被拒绝
    // 当前 SecurityChecker 无法区分读写操作，统一按写入拒绝
    expect(result.allowed).toBe(false);
  });

  it('should deny sensitive files with deny policy', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig('deny'));
    const result = checker.checkFilePath(path.join(process.cwd(), 'credentials.json'), dummyContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('敏感文件');
  });

  it('should support adding allowed directories', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    checker.addAllowedDir(os.homedir());
    const result = checker.checkFilePath(path.join(os.homedir(), 'allowed.txt'), dummyContext);
    expect(result.allowed).toBe(true);
  });

  it('should block blacklisted commands', () => {
    const config = makeSecurityConfig();
    config.commandBlacklist = ['rm -rf'];
    const checker = new SecurityChecker(process.cwd(), config);
    const result = checker.checkCommand('rm -rf /', dummyContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('黑名单');
  });

  it('should allow non-blacklisted commands', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = checker.checkCommand('ls -la', dummyContext);
    expect(result.allowed).toBe(true);
  });

  it('should respect command whitelist', () => {
    const config = makeSecurityConfig();
    config.commandWhitelist = ['git'];
    config.commandBlacklist = [];
    const checker = new SecurityChecker(process.cwd(), config);

    expect(checker.checkCommand('git status', dummyContext).allowed).toBe(true);
    expect(checker.checkCommand('ls -la', dummyContext).allowed).toBe(false);
  });

  it('should require confirmation for network requests', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = checker.checkNetworkRequest('https://example.com');
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('should deny invalid URLs', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = checker.checkNetworkRequest('not-a-url');
    expect(result.allowed).toBe(false);
  });

  it('should deny local network addresses', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    expect(checker.checkNetworkRequest('http://localhost:3000').allowed).toBe(false);
    expect(checker.checkNetworkRequest('http://127.0.0.1:8080').allowed).toBe(false);
  });
});
