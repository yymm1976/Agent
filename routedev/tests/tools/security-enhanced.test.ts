// tests/tools/security-enhanced.test.ts
// 安全增强模块单元测试：SSRF 防护 + symlink 真实路径解析 + 7 层 Bash 安全 + 凭证过滤

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  checkSSRF,
  getMaxRedirectDepth,
  resolveSecurePath,
  checkBashSecurity,
  filterSensitiveFields,
} from '../../src/tools/security-enhanced.js';

// ============================================================
// SSRF 防护
// ============================================================

describe('SSRF 防护 (checkSSRF)', () => {
  it('应放行公网 HTTP/HTTPS URL', async () => {
    const result = await checkSSRF('https://example.com/api');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('');
  });

  it('应拒绝非 HTTP/HTTPS 协议', async () => {
    const fileResult = await checkSSRF('file:///etc/passwd');
    expect(fileResult.allowed).toBe(false);
    expect(fileResult.reason).toContain('不允许的协议');

    const ftpResult = await checkSSRF('ftp://example.com');
    expect(ftpResult.allowed).toBe(false);
  });

  it('应拒绝无效 URL', async () => {
    const result = await checkSSRF('not-a-url');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('无效');
  });

  it('应拒绝回环地址 127.0.0.1', async () => {
    const result = await checkSSRF('http://127.0.0.1:8080');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('IP 地址被禁止');
  });

  it('应拒绝 localhost', async () => {
    const result = await checkSSRF('http://localhost:3000');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝私有网段 10.x', async () => {
    const result = await checkSSRF('http://10.0.0.1');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝私有网段 192.168.x', async () => {
    const result = await checkSSRF('http://192.168.1.1');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝私有网段 172.16-31.x', async () => {
    const result = await checkSSRF('http://172.16.0.1');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝链路本地地址 169.254.x', async () => {
    const result = await checkSSRF('http://169.254.1.1');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝 AWS 元数据端点 169.254.169.254', async () => {
    const result = await checkSSRF('http://169.254.169.254/latest/meta-data/');
    expect(result.allowed).toBe(false);
  });

  it('应拒绝 IPv6 回环 ::1', async () => {
    const result = await checkSSRF('http://[::1]:8080');
    expect(result.allowed).toBe(false);
  });

  it('DNS 解析失败时应拒绝而不是放行', async () => {
    const result = await checkSSRF('http://nonexistent.invalid');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DNS 解析失败');
  });

  it('getMaxRedirectDepth 应返回 5', () => {
    expect(getMaxRedirectDepth()).toBe(5);
  });
});

// ============================================================
// Symlink 真实路径解析
// ============================================================

describe('resolveSecurePath (symlink 防护)', () => {
  let tmpDir: string;
  let allowedDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-sec-'));
    allowedDir = path.join(tmpDir, 'project');
    fs.mkdirSync(allowedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应放行允许目录内的文件', () => {
    const filePath = path.join(allowedDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello');
    const result = resolveSecurePath(filePath, [allowedDir]);
    expect(result.allowed).toBe(true);
  });

  it('应拒绝允许目录外的文件', () => {
    const outsideFile = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(outsideFile, 'hello');
    const result = resolveSecurePath(outsideFile, [allowedDir]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('不在允许目录');
  });

  it('应放行不存在的新文件（新建场景）', () => {
    const newFile = path.join(allowedDir, 'newfile.txt');
    const result = resolveSecurePath(newFile, [allowedDir]);
    expect(result.allowed).toBe(true);
  });

  it('应检测 symlink 逃逸到允许目录外', { skip: process.platform === 'win32' ? 'Windows 创建 symlink 需要管理员权限' : undefined }, () => {
    // 创建允许目录外的目标文件
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const targetFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(targetFile, 'secret');

    // 在允许目录内创建 symlink 指向外部文件
    const symlinkPath = path.join(allowedDir, 'link.txt');
    fs.symlinkSync(targetFile, symlinkPath);

    const result = resolveSecurePath(symlinkPath, [allowedDir]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('符号链接目标逃逸');
  });
});

// ============================================================
// 7 层 Bash 安全检查
// ============================================================

describe('checkBashSecurity (7 层 Bash 安全)', () => {
  it('应放行正常命令', () => {
    const result = checkBashSecurity('ls -la');
    expect(result.allowed).toBe(true);
  });

  it('应放行 git status', () => {
    const result = checkBashSecurity('git status');
    expect(result.allowed).toBe(true);
  });

  // Layer 1: Unicode 格式字符
  it('Layer 1: 应拦截 Unicode 零宽字符', () => {
    const result = checkBashSecurity('ls\u200B -la');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('unicode');
  });

  it('Layer 1: 应拦截方向标记字符', () => {
    const result = checkBashSecurity('ls\u202E -la');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('unicode');
  });

  // Layer 2: 回车注入
  it('Layer 2: 应拦截回车符 \\r', () => {
    const result = checkBashSecurity('ls -la\rrm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('carriage-return');
  });

  // Layer 3: /proc/*/environ
  it('Layer 3: 应拦截 /proc/*/environ 访问', () => {
    const result = checkBashSecurity('cat /proc/1234/environ');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('proc-environ');
  });

  // Layer 4: 危险命令
  it('Layer 4: 应拦截 rm -rf /', () => {
    const result = checkBashSecurity('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('dangerous-command');
    expect(result.reason).toContain('删除根目录');
  });

  it('Layer 4: 应拦截 rm -r -f /', () => {
    const result = checkBashSecurity('rm -r -f /');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('dangerous-command');
    expect(result.reason).toContain('删除根目录');
  });

  it('Layer 4: 应拦截 mkfs', () => {
    const result = checkBashSecurity('mkfs.ext4 /dev/sda1');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('dangerous-command');
  });

  it('Layer 4: 应拦截 dd 写入设备', () => {
    const result = checkBashSecurity('dd if=/dev/zero of=/dev/sda');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('dangerous-command');
  });

  it('Layer 4: 应拦截 fork 炸弹', () => {
    const result = checkBashSecurity(':(){ :|:& };:');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('dangerous-command');
  });

  // Layer 7: 命令复杂度
  it('Layer 7: 超过 50 token 的命令应跳过 Layer 5-6 分析但放行（仍执行 Layer 1-4）', () => {
    const tokens = Array.from({ length: 51 }, (_, i) => `arg${i}`).join(' ');
    const result = checkBashSecurity(`command ${tokens}`);
    // 安全修复：复杂度超限时仍执行 Layer 1-4，仅跳过 Layer 5-6
    // 无危险内容的命令应放行
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// 凭证上下文过滤
// ============================================================

describe('filterSensitiveFields (凭证过滤)', () => {
  it('应过滤对象中的敏感字段', () => {
    const input = {
      name: 'test',
      apiKey: 'sk-1234567890',
      password: 'secret123',
      normalField: 'value',
    };
    const result = filterSensitiveFields(input);
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.name).toBe('test');
    expect(result.normalField).toBe('value');
  });

  it('应过滤嵌套对象中的敏感字段', () => {
    const input = {
      config: {
        token: 'abc123',
        data: 'keep',
      },
    };
    const result = filterSensitiveFields(input);
    expect(result.config.token).toBe('[REDACTED]');
    expect(result.config.data).toBe('keep');
  });

  it('应过滤数组中的敏感字段', () => {
    const input = [
      { name: 'a', secret: 'x' },
      { name: 'b', secret: 'y' },
    ];
    const result = filterSensitiveFields(input);
    expect(result[0].secret).toBe('[REDACTED]');
    expect(result[1].secret).toBe('[REDACTED]');
    expect(result[0].name).toBe('a');
  });

  it('应过滤字符串中的长 token 模式', () => {
    const longToken = 'sk-' + 'a'.repeat(40);
    const result = filterSensitiveFields(`key=${longToken}`);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain(longToken);
  });

  it('应处理 null 和 undefined', () => {
    expect(filterSensitiveFields(null)).toBeNull();
    expect(filterSensitiveFields(undefined)).toBeUndefined();
  });

  it('应处理空对象', () => {
    const result = filterSensitiveFields({});
    expect(result).toEqual({});
  });
});
