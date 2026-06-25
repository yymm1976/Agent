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
    // P1-8 后使用 resolveSecurePath，reason 文案为"路径不在允许目录内"
    expect(result.reason).toContain('不在允许目录');
  });

  it('should allow sensitive files with readonly policy but require confirmation', () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig('readonly'));
    const result = checker.checkFilePath(path.join(process.cwd(), '.env'), dummyContext);
    // I16 修复：readonly 策略允许访问但需确认（而非与 deny 行为相同）
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
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
    // 注意：'rm -rf /' 会被 7 层 Bash 安全检查先拦截（reason 含"删除根目录"），
    // 这里用 'rm -rf somefile' 避开 Bash 安全检查，专门验证黑名单功能
    const result = checker.checkCommand('rm -rf somefile', dummyContext);
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

  it('should require confirmation for network requests', async () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = await checker.checkNetworkRequest('https://example.com');
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('should deny invalid URLs', async () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    const result = await checker.checkNetworkRequest('not-a-url');
    expect(result.allowed).toBe(false);
  });

  it('should deny local network addresses', async () => {
    const checker = new SecurityChecker(process.cwd(), makeSecurityConfig());
    expect((await checker.checkNetworkRequest('http://localhost:3000')).allowed).toBe(false);
    expect((await checker.checkNetworkRequest('http://127.0.0.1:8080')).allowed).toBe(false);
  });
});
