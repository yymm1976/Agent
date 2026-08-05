/**
 * ProfileBridge 单元测试
 *
 * 覆盖：
 * - CRUD 映射与 fail-open
 * - 版本 list / get / diff / rollback
 * - diffCurrentWith 组合逻辑
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileBridge } from '../profile-bridge.js';
import type { EngineContext } from '../engine-context.js';
import type { AgentProfile } from '../../../../src/agents/profiles/types.js';

// ── fixtures ─────────────────────────────────────────────

const sampleProfile: AgentProfile = {
  id: 'p1',
  name: 'Executor',
  type: 'agent-profile',
  version: '1.0.0',
  role: 'executor',
  modelId: 'gpt-4o',
  description: 'exec',
  systemPrompt: 'You are executor',
  allowedTools: ['file_write', 'file_edit'],
  forbiddenTools: [],
  canChallenge: false,
  challengeSeverity: 'warning',
  outputFormat: 'code_change',
  boundSkills: [],
  maxTokens: 8000,
  maxSteps: 20,
  isBuiltin: true,
  createdAt: 1000,
  updatedAt: 2000,
};

const versionMeta = {
  versionId: 'v1',
  profileId: 'p1',
  timestamp: 1500,
  source: 'user_edit' as const,
  fieldChanges: [{ field: 'name', before: 'Old', after: 'Executor' }],
  changeSummary: 'rename',
};

function makeCtx(overrides: {
  list?: () => Promise<AgentProfile[]>;
  get?: (id: string) => Promise<AgentProfile | null>;
  saveProfile?: (p: AgentProfile, source?: string) => Promise<void>;
  delete?: (id: string) => Promise<void>;
  duplicate?: (id: string, name: string) => Promise<AgentProfile | string>;
  import?: (path: string) => Promise<AgentProfile | string>;
  rollback?: (id: string, vid: string) => Promise<void>;
  listVersions?: (id: string) => Promise<typeof versionMeta[]>;
  loadVersion?: (
    id: string,
    vid: string,
  ) => Promise<{ meta: typeof versionMeta; snapshot: AgentProfile } | null>;
  diffVersions?: (
    id: string,
    a: string,
    b: string,
  ) => Promise<{ field: string; before: unknown; after: unknown }[]>;
  diffProfiles?: (
    a: AgentProfile,
    b: AgentProfile,
  ) => { field: string; before: unknown; after: unknown }[];
  noManager?: boolean;
} = {}): EngineContext {
  if (overrides.noManager) {
    return { profileManager: null } as unknown as EngineContext;
  }

  const versionManager = {
    listVersions: overrides.listVersions ?? vi.fn(async () => [versionMeta]),
    loadVersion:
      overrides.loadVersion ??
      vi.fn(async () => ({ meta: versionMeta, snapshot: sampleProfile })),
    diffVersions: overrides.diffVersions ?? vi.fn(async () => []),
    diffProfiles:
      overrides.diffProfiles ??
      vi.fn(() => [{ field: 'name', before: 'A', after: 'B' }]),
    diffCurrentWith: vi.fn(async (id: string, current: AgentProfile, versionId: string) => {
      const target = await versionManager.loadVersion(id, versionId);
      return target ? versionManager.diffProfiles(target.snapshot, current) : [];
    }),
  };

  const profileManager = {
    listProfiles: overrides.list ?? vi.fn(async () => [sampleProfile]),
    getProfile: overrides.get ?? vi.fn(async (id: string) => (id === 'p1' ? sampleProfile : null)),
    saveProfile: overrides.saveProfile ?? vi.fn(async () => undefined),
    deleteProfile: overrides.delete ?? vi.fn(async () => undefined),
    duplicateProfile: overrides.duplicate ?? vi.fn(async () => ({ ...sampleProfile, id: 'p2' })),
    importProfile: overrides.import ?? vi.fn(async () => ({ ...sampleProfile, id: 'p3' })),
    rollback: overrides.rollback ?? vi.fn(async () => undefined),
    getVersionManager: vi.fn(() => versionManager),
  };

  return { profileManager } as unknown as EngineContext;
}

// ── tests ────────────────────────────────────────────────

describe('ProfileBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fail-open without manager', () => {
    it('listProfiles returns []', async () => {
      const bridge = new ProfileBridge(makeCtx({ noManager: true }));
      await expect(bridge.listProfiles()).resolves.toEqual([]);
    });

    it('getProfile returns null', async () => {
      const bridge = new ProfileBridge(makeCtx({ noManager: true }));
      await expect(bridge.getProfile('p1')).resolves.toBeNull();
    });

    it('saveProfile returns error result', async () => {
      const bridge = new ProfileBridge(makeCtx({ noManager: true }));
      const r = await bridge.saveProfile({
        id: 'x',
        name: 'n',
        type: 'agent-profile',
        version: '1.0.0',
        role: 'custom',
        modelId: 'm',
        description: '',
        allowedTools: [],
        forbiddenTools: [],
        canChallenge: false,
        challengeSeverity: 'warning',
        outputFormat: 'custom',
        maxTokens: 0,
        maxSteps: 0,
        isBuiltin: false,
        systemPrompt: '',
        boundSkills: [],
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/未初始化|not initialized/i);
    });

    it('listVersions returns []', async () => {
      const bridge = new ProfileBridge(makeCtx({ noManager: true }));
      await expect(bridge.listVersions('p1')).resolves.toEqual([]);
    });

    it('rollbackProfile returns error', async () => {
      const bridge = new ProfileBridge(makeCtx({ noManager: true }));
      const r = await bridge.rollbackProfile('p1', 'v1');
      expect(r.success).toBe(false);
    });
  });

  describe('CRUD mapping', () => {
    it('listProfiles maps to AgentProfileInfo', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const list = await bridge.listProfiles();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'p1',
        name: 'Executor',
        role: 'executor',
        modelId: 'gpt-4o',
        isBuiltin: true,
      });
      // Info 不应强制包含 systemPrompt（Detail 才有）
      expect('systemPrompt' in list[0]).toBe(false);
    });

    it('getProfile maps to AgentProfileDetail with systemPrompt', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const d = await bridge.getProfile('p1');
      expect(d).not.toBeNull();
      expect(d!.systemPrompt).toBe('You are executor');
      expect(d!.boundSkills).toEqual([]);
      expect(d!.version).toBe('1.0.0');
    });

    it('getProfile returns null for missing', async () => {
      const bridge = new ProfileBridge(makeCtx());
      await expect(bridge.getProfile('missing')).resolves.toBeNull();
    });

    it('saveProfile calls mgr.saveProfile with user_edit source', async () => {
      const saveProfile = vi.fn(async (_p: AgentProfile, _source?: string) => undefined);
      const bridge = new ProfileBridge(makeCtx({ saveProfile }));
      const r = await bridge.saveProfile({
        id: 'p1',
        name: 'Executor',
        type: 'agent-profile',
        version: '1.0.0',
        role: 'executor',
        modelId: 'gpt-4o',
        description: 'exec',
        allowedTools: ['file_write'],
        forbiddenTools: [],
        canChallenge: false,
        challengeSeverity: 'warning',
        outputFormat: 'code_change',
        maxTokens: 8000,
        maxSteps: 20,
        isBuiltin: true,
        systemPrompt: 'You are executor',
        boundSkills: [],
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(r.success).toBe(true);
      expect(r.id).toBe('p1');
      expect(saveProfile).toHaveBeenCalledTimes(1);
      expect(saveProfile.mock.calls[0][1]).toBe('user_edit');
    });

    it('deleteProfile success', async () => {
      const del = vi.fn(async () => undefined);
      const bridge = new ProfileBridge(makeCtx({ delete: del }));
      const r = await bridge.deleteProfile('p1');
      expect(r).toEqual({ success: true, id: 'p1' });
      expect(del).toHaveBeenCalledWith('p1');
    });

    it('duplicateProfile returns new id', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const r = await bridge.duplicateProfile('p1', 'Copy');
      expect(r.success).toBe(true);
      expect(r.id).toBe('p2');
    });

    it('importProfile returns new id', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const r = await bridge.importProfile('/tmp/p.json');
      expect(r.success).toBe(true);
      expect(r.id).toBe('p3');
    });

    it('saveProfile surfaces manager errors', async () => {
      const bridge = new ProfileBridge(
        makeCtx({
          saveProfile: vi.fn(async () => {
            throw new Error('validation failed');
          }),
        }),
      );
      const r = await bridge.saveProfile({
        id: 'p1',
        name: 'x',
        type: 'agent-profile',
        version: '1.0.0',
        role: 'custom',
        modelId: 'm',
        description: '',
        allowedTools: [],
        forbiddenTools: [],
        canChallenge: false,
        challengeSeverity: 'warning',
        outputFormat: 'custom',
        maxTokens: 0,
        maxSteps: 0,
        isBuiltin: false,
        systemPrompt: '',
        boundSkills: [],
        createdAt: 1000,
        updatedAt: 1000,
      });
      expect(r.success).toBe(false);
      expect(r.error).toBe('validation failed');
    });
  });

  describe('version management', () => {
    it('listVersions returns meta list', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const list = await bridge.listVersions('p1');
      expect(list).toEqual([versionMeta]);
    });

    it('getVersion maps snapshot via toDetail', async () => {
      const bridge = new ProfileBridge(makeCtx());
      const rec = await bridge.getVersion('p1', 'v1');
      expect(rec).not.toBeNull();
      expect(rec!.meta.versionId).toBe('v1');
      expect(rec!.snapshot.systemPrompt).toBe('You are executor');
      expect(rec!.snapshot.id).toBe('p1');
    });

    it('getVersion returns null when missing', async () => {
      const bridge = new ProfileBridge(
        makeCtx({ loadVersion: vi.fn(async () => null) }),
      );
      await expect(bridge.getVersion('p1', 'vx')).resolves.toBeNull();
    });

    it('diffVersions delegates to VersionManager', async () => {
      const diffs = [{ field: 'modelId', before: 'a', after: 'b' }];
      const diffVersions = vi.fn(async () => diffs);
      const bridge = new ProfileBridge(makeCtx({ diffVersions }));
      const r = await bridge.diffVersions('p1', 'v1', 'v2');
      expect(r).toEqual(diffs);
      expect(diffVersions).toHaveBeenCalledWith('p1', 'v1', 'v2');
    });

    it('diffCurrentWith uses get + loadVersion + diffProfiles', async () => {
      const diffProfiles = vi.fn(() => [
        { field: 'name', before: 'Executor', after: 'Old' },
      ]);
      const bridge = new ProfileBridge(makeCtx({ diffProfiles }));
      const r = await bridge.diffCurrentWith('p1', 'v1');
      expect(r).toHaveLength(1);
      expect(diffProfiles).toHaveBeenCalled();
    });

    it('diffCurrentWith returns [] if current missing', async () => {
      const bridge = new ProfileBridge(
        makeCtx({ get: vi.fn(async () => null) }),
      );
      await expect(bridge.diffCurrentWith('missing', 'v1')).resolves.toEqual([]);
    });

    it('rollbackProfile success', async () => {
      const rollback = vi.fn(async () => undefined);
      const bridge = new ProfileBridge(makeCtx({ rollback }));
      const r = await bridge.rollbackProfile('p1', 'v1');
      expect(r).toEqual({ success: true, id: 'p1' });
      expect(rollback).toHaveBeenCalledWith('p1', 'v1');
    });

    it('rollbackProfile surfaces errors', async () => {
      const bridge = new ProfileBridge(
        makeCtx({
          rollback: vi.fn(async () => {
            throw new Error('version not found');
          }),
        }),
      );
      const r = await bridge.rollbackProfile('p1', 'bad');
      expect(r.success).toBe(false);
      expect(r.error).toBe('version not found');
    });
  });
});
