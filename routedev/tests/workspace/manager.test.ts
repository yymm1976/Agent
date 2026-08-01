// tests/workspace/manager.test.ts
// Phase 97 Part D：WorkspaceManager 单元测试
//
// 覆盖验收标准：
//   1. 工作区 CRUD（add/get/list/remove）
//   2. active 工作区切换
//   3. getAllowedRoots：projectRoot + attachedDirectories 去重
//   4. isPathAllowed：范围内 true / 范围外 false / 无 active 时 fail-open true
//   5. 持久化 save/load 往返

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import type { Workspace } from '../../src/workspace/types.js';

function makeWorkspace(overrides?: Partial<Workspace>): Workspace {
  return {
    id: 'ws-1',
    slug: 'demo',
    projectRoot: path.join(os.tmpdir(), 'proj'),
    attachedDirectories: [],
    attachedFiles: [],
    enabledSkills: [],
    enabledMcpServers: [],
    ...overrides,
  };
}

describe('workspace-manager（工作区能力边界）', () => {
  let manager: WorkspaceManager;
  let storageFile: string;

  beforeEach(async () => {
    storageFile = path.join(os.tmpdir(), `routedev-ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    manager = new WorkspaceManager({ storageFile });
    await manager.load();
  });

  it('CRUD：add / get / list / remove', () => {
    manager.addWorkspace(makeWorkspace());
    expect(manager.getWorkspace('ws-1')?.slug).toBe('demo');
    expect(manager.listWorkspaces()).toHaveLength(1);
    manager.removeWorkspace('ws-1');
    expect(manager.getWorkspace('ws-1')).toBeUndefined();
  });

  it('active 工作区切换', () => {
    manager.addWorkspace(makeWorkspace());
    manager.setActiveWorkspace('ws-1');
    expect(manager.getActiveWorkspace()?.id).toBe('ws-1');
    expect(manager.getActiveWorkspaceId()).toBe('ws-1');
    manager.setActiveWorkspace(null);
    expect(manager.getActiveWorkspace()).toBeNull();
  });

  it('getAllowedRoots 合并 projectRoot 与 attachedDirectories 并去重', () => {
    const root = path.join(os.tmpdir(), 'proj');
    const attached = path.join(os.tmpdir(), 'shared');
    manager.addWorkspace(makeWorkspace({
      attachedDirectories: [attached, attached], // 重复路径应去重
      attachedFiles: [path.join(attached, 'api.md')],
    }));
    const roots = manager.getAllowedRoots('ws-1');
    // projectRoot + attached 目录 + attachedFiles 父目录，但 attached 与 attachedFiles 父目录相同 → 去重后 2 个
    expect(roots.length).toBe(2);
    expect(roots).toContain(root);
    expect(roots).toContain(attached);
  });

  it('isPathAllowed：范围内 true / 范围外 false / 无 active fail-open true', () => {
    const root = path.join(os.tmpdir(), 'proj');
    const outside = path.join(os.tmpdir(), 'other');
    manager.addWorkspace(makeWorkspace({ projectRoot: root }));

    // 无 active 工作区 → fail-open
    expect(manager.isPathAllowed(null, path.join(outside, 'x.txt'))).toBe(true);

    manager.setActiveWorkspace('ws-1');
    expect(manager.isPathAllowed('ws-1', path.join(root, 'src', 'a.ts'))).toBe(true);
    expect(manager.isPathAllowed('ws-1', path.join(root, 'src'))).toBe(true);
    // 边界：/proj2 不应被 /proj 前缀误判为在范围内
    expect(manager.isPathAllowed('ws-1', path.join(os.tmpdir(), 'proj2', 'a.ts'))).toBe(false);
    expect(manager.isPathAllowed('ws-1', outside)).toBe(false);
  });

  it('持久化 save/load 往返', async () => {
    manager.addWorkspace(makeWorkspace({ attachedDirectories: [path.join(os.tmpdir(), 'shared')] }));
    manager.setActiveWorkspace('ws-1');
    await manager.save();

    const reloaded = new WorkspaceManager({ storageFile });
    await reloaded.load();
    expect(reloaded.getWorkspace('ws-1')?.slug).toBe('demo');
    expect(reloaded.getActiveWorkspaceId()).toBe('ws-1');
  });

  it('损坏文件 fail-open：load 后从空工作区开始', async () => {
    await fs.writeFile(storageFile, 'not-json{{{', 'utf-8');
    const broken = new WorkspaceManager({ storageFile });
    await broken.load();
    expect(broken.listWorkspaces()).toHaveLength(0);
  });
});
