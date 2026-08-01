// tests/workspace/boundary.test.ts
// Phase 97 Part D：权限引擎工作区路径边界集成测试
//
// 覆盖验收标准：
//   1. 注入 pathBoundaryResolver 后，越界文件类工具被确定性 deny
//   2. 范围内文件类工具行为不变（走原规则判定）
//   3. 未注入 resolver 时行为不变（向后兼容）

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PermissionEngine, createDefaultEngine } from '../../src/tools/permission-engine.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import type { Workspace } from '../../src/workspace/types.js';

async function buildBoundaryEngine(): Promise<{ engine: PermissionEngine; workspace: WorkspaceManager }> {
  const engine = createDefaultEngine();
  const workspace = new WorkspaceManager();
  const root = path.join(os.tmpdir(), 'ws-boundary-proj');
  const ws: Workspace = {
    id: 'ws-boundary',
    slug: 'boundary',
    projectRoot: root,
    attachedDirectories: [],
    attachedFiles: [],
    enabledSkills: [],
    enabledMcpServers: [],
  };
  workspace.addWorkspace(ws);
  workspace.setActiveWorkspace('ws-boundary');
  engine.setPathBoundaryResolver((absPath) => ({
    allowed: workspace.isPathAllowed(workspace.getActiveWorkspaceId(), absPath),
  }));
  return { engine, workspace };
}

describe('workspace boundary（工作区路径边界）', () => {
  it('越界文件读取被确定性 deny', async () => {
    const { engine } = await buildBoundaryEngine();
    const outside = path.join(os.tmpdir(), 'elsewhere', 'secret.txt');
    const result = engine.check('file_read', { path: outside }, 'semi');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('工作区边界拒绝');
  });

  it('范围内文件读取不受边界拦截', async () => {
    const { engine } = await buildBoundaryEngine();
    const inside = path.join(os.tmpdir(), 'ws-boundary-proj', 'src', 'a.ts');
    const result = engine.check('file_read', { path: inside }, 'semi');
    // 只读工具默认 auto，不应被边界拦截
    expect(result.decision).not.toBe('deny');
  });

  it('未注入 resolver 时行为不变（向后兼容）', () => {
    const engine = createDefaultEngine();
    const outside = path.join(os.tmpdir(), 'elsewhere', 'secret.txt');
    const result = engine.check('file_read', { path: outside }, 'semi');
    // 未注入边界：走原 auto 规则，不 deny
    expect(result.decision).not.toBe('deny');
  });
});
