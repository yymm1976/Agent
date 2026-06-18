// tests/config/watcher.test.ts
// Phase 26 Task 9：ConfigWatcher 测试覆盖

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigWatcher } from '../../src/config/watcher.js';

describe('ConfigWatcher', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-watcher-'));
    configPath = path.join(tempDir, 'config.yaml');
    await fs.writeFile(configPath, 'test: value\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('应在配置文件变更时触发 reload 事件', async () => {
    const watcher = new ConfigWatcher(configPath);
    let reloadFired = false;
    watcher.on('reload', () => { reloadFired = true; });

    watcher.start();
    // 等待 watcher 初始化
    await new Promise(r => setTimeout(r, 200));

    // 修改文件
    await fs.writeFile(configPath, 'test: new_value\n', 'utf-8');

    // 等待 debounce + fs.watch 触发
    await new Promise(r => setTimeout(r, 1000));

    watcher.stop();
    expect(reloadFired).toBe(true);
  });

  it('应在文件不存在时不崩溃', () => {
    const watcher = new ConfigWatcher(path.join(tempDir, 'nonexistent.yaml'));
    expect(() => watcher.start()).not.toThrow();
    watcher.stop();
  });

  it('stop 后应停止监听', async () => {
    const watcher = new ConfigWatcher(configPath);
    let reloadCount = 0;
    watcher.on('reload', () => { reloadCount++; });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));
    watcher.stop();

    const countAfterStop = reloadCount;
    await fs.writeFile(configPath, 'test: another\n', 'utf-8');
    await new Promise(r => setTimeout(r, 1000));

    expect(reloadCount).toBe(countAfterStop);
  });
});
