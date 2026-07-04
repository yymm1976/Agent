import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadUserProfile } from '../../../src/agent/context/user-profile-loader.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('loadUserProfile', () => {
  const tmpDir = path.join(os.tmpdir(), `user-profile-test-${Date.now()}`);

  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, '.routedev'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('加载项目级 user_profile.md', async () => {
    const content = '# User Profile\n- prefers concise answers';
    await fs.writeFile(path.join(tmpDir, '.routedev', 'user_profile.md'), content);
    const profile = await loadUserProfile(tmpDir);
    expect(profile).not.toBeNull();
    expect(profile!.raw).toBe(content);
    expect(profile!.tokens).toBeGreaterThan(0);
    expect(profile!.sourcePath).toContain('user_profile.md');
  });

  it('文件不存在时返回 null', async () => {
    const profile = await loadUserProfile(tmpDir);
    expect(profile).toBeNull();
  });

  it('空文件跳过返回 null', async () => {
    await fs.writeFile(path.join(tmpDir, '.routedev', 'user_profile.md'), '   ');
    const profile = await loadUserProfile(tmpDir);
    expect(profile).toBeNull();
  });

  it('tokens 字段用 tiktoken 精确计数（非 length/4）', async () => {
    // 中文，tiktoken 计数约 4-6，length/4=1
    const content = '你好世界';
    await fs.writeFile(path.join(tmpDir, '.routedev', 'user_profile.md'), content);
    const profile = await loadUserProfile(tmpDir);
    expect(profile!.tokens).toBeGreaterThanOrEqual(4);
  });

  it('sourcePath 字段记录加载来源', async () => {
    const content = '# test';
    await fs.writeFile(path.join(tmpDir, '.routedev', 'user_profile.md'), content);
    const profile = await loadUserProfile(tmpDir);
    expect(profile!.sourcePath).toBe(path.join(tmpDir, '.routedev', 'user_profile.md'));
  });
});
