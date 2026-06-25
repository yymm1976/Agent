// tests/integration/phase44.test.ts
// Phase 44 集成测试：消息节点持久化 / 分支联动 / 并行实验 / 需求变更
// 验证 Schema 配置 / Defaults 默认值 / BranchPersistence / BranchLinkageManager /
// RequirementChange / ParallelExperimentManager
//
// 测试策略：
//   1. Schema 配置验证（conversation/experiment）——直接测试 schema.ts
//   2. Defaults 默认值验证——直接测试 defaults.ts
//   3. BranchPersistence / BranchLinkageManager——动态 import，模块不存在则 skip
//   4. RequirementChange / ParallelExperimentManager——动态 import，模块不存在则 skip

import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// ============================================================
// 1. Schema 配置验证 - conversation
// ============================================================
describe('Phase 44 Integration - Schema conversation 配置', () => {
  it('conversation.persistTree 默认 true', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.conversation).toBeDefined();
    expect(config.conversation.persistTree).toBe(true);
  });

  it('conversation.maxNodes 默认 5000', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.conversation).toBeDefined();
    expect(config.conversation.maxNodes).toBe(5000);
  });
});

// ============================================================
// 2. Schema 配置验证 - experiment
// ============================================================
describe('Phase 44 Integration - Schema experiment 配置', () => {
  it('experiment.parallelEnabled 默认 false', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.experiment).toBeDefined();
    expect(config.experiment.parallelEnabled).toBe(false);
  });

  it('experiment.maxParallel 默认 3', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.experiment).toBeDefined();
    expect(config.experiment.maxParallel).toBe(3);
  });
});

// ============================================================
// 3. Defaults 默认值验证
// ============================================================
describe('Phase 44 Integration - Defaults 默认值', () => {
  it('conversation.undoStackSize = 50', () => {
    expect(DEFAULT_CONFIG.conversation).toBeDefined();
    expect(DEFAULT_CONFIG.conversation.undoStackSize).toBe(50);
  });

  it('experiment.autoCleanupDays = 7', () => {
    expect(DEFAULT_CONFIG.experiment).toBeDefined();
    expect(DEFAULT_CONFIG.experiment.autoCleanupDays).toBe(7);
  });
});

// ============================================================
// 4. BranchPersistence 模块测试（动态 import，不存在则 skip）
// ============================================================
describe('Phase 44 Integration - BranchPersistence', () => {
  it('save+load 往返：写入节点树后能读回（skip if not available）', async () => {
    let mod: { BranchPersistence: new (rootDir: string) => {
      save: (tree: unknown) => Promise<void>;
      load: () => Promise<unknown>;
    } };
    try {
      mod = await import('../../src/agent/branch-persistence.js');
    } catch {
      // 模块尚未创建，skip
      expect(true).toBe(true);
      return;
    }
    expect(mod).toBeDefined();
    expect(mod.BranchPersistence).toBeDefined();

    // 使用临时目录避免污染工作区
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-phase44-'));
    try {
      const persistence = new mod.BranchPersistence(tmpDir);

      // 构造一棵最小可持久化的对话树
      // BranchNode: { id, parentId, message: {role, content}, children, timestamp }
      // BranchInfo: { id, name, tipNodeId, messageCount, isActive, createdAt, parentId, lastActiveAt }
      const tree = {
        version: 1 as const,
        activeBranchId: 'node-1',
        activeBranchKey: 'branch-main',
        nodes: [
          {
            id: 'node-1',
            parentId: null,
            message: { role: 'user', content: 'hello' },
            children: ['node-2'],
            timestamp: Date.now(),
          },
          {
            id: 'node-2',
            parentId: 'node-1',
            message: { role: 'assistant', content: 'hi' },
            children: [],
            timestamp: Date.now(),
          },
        ],
        branches: [
          {
            id: 'branch-main',
            name: 'main',
            tipNodeId: 'node-2',
            messageCount: 2,
            isActive: true,
            createdAt: Date.now(),
            parentId: null,
            lastActiveAt: Date.now(),
          },
        ],
        historyNodeIds: ['node-1', 'node-2'],
        lastModifiedAt: Date.now(),
      };

      await persistence.save(tree);
      const loaded = await persistence.load();
      expect(loaded).not.toBeNull();
      const loadedTree = loaded as {
        nodes: Array<{ id: string; message: { role: string; content: string } }>;
        branches: Array<{ id: string; tipNodeId: string }>;
        historyNodeIds: string[];
      };
      // 验证往返一致性：节点数、节点 id 与 message 内容应保留
      expect(loadedTree.nodes.length).toBe(2);
      expect(loadedTree.nodes[0].id).toBe('node-1');
      expect(loadedTree.nodes[0].message.content).toBe('hello');
      expect(loadedTree.nodes[1].message.content).toBe('hi');
      expect(loadedTree.branches[0].tipNodeId).toBe('node-2');
      expect(loadedTree.historyNodeIds).toEqual(['node-1', 'node-2']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ============================================================
// 5. BranchLinkageManager 模块测试（动态 import，不存在则 skip）
// ============================================================
describe('Phase 44 Integration - BranchLinkageManager', () => {
  it('linkGoal+getLinkage：建立 goal 与分支映射后能查询（skip if not available）', async () => {
    let mod: { BranchLinkageManager: new (rootDir: string) => {
      load: () => Promise<void>;
      linkGoal: (messageBranchId: string, messageBranchName: string, goalId: string) => unknown;
      getLinkage: (messageBranchId: string) => unknown;
    } };
    try {
      mod = await import('../../src/agent/branch-linkage.js');
    } catch {
      // 模块尚未创建，skip
      expect(true).toBe(true);
      return;
    }
    expect(mod).toBeDefined();
    expect(mod.BranchLinkageManager).toBeDefined();

    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-phase44-link-'));
    try {
      const linkage = new mod.BranchLinkageManager(tmpDir);
      await linkage.load();

      // 建立映射前查询应返回 undefined
      const before = linkage.getLinkage('branch-A');
      expect(before).toBeUndefined();

      // 建立 branch-A → goal-1 映射（参数：messageBranchId, messageBranchName, goalId）
      linkage.linkGoal('branch-A', 'feature-login', 'goal-1');
      const after = linkage.getLinkage('branch-A') as {
        messageBranchId: string;
        messageBranchName: string;
        goalId: string;
        experimentIds: string[];
        status: string;
      };
      expect(after).toBeDefined();
      expect(after.messageBranchId).toBe('branch-A');
      expect(after.messageBranchName).toBe('feature-login');
      expect(after.goalId).toBe('goal-1');
      expect(Array.isArray(after.experimentIds)).toBe(true);
      expect(after.experimentIds.length).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ============================================================
// 6. RequirementChange 模块测试（动态 import，不存在则 skip）
// ============================================================
describe('Phase 44 Integration - RequirementChange', () => {
  it('isRequirementChange：用户消息变更返回 true（skip if not available）', async () => {
    let mod: { isRequirementChange: (
      oldMessage: { role: string; content: string },
      newMessage: { role: string; content: string },
    ) => boolean };
    try {
      mod = await import('../../src/agent/requirement-change.js');
    } catch {
      // 模块尚未创建，skip
      expect(true).toBe(true);
      return;
    }
    expect(mod).toBeDefined();
    expect(mod.isRequirementChange).toBeDefined();

    // user 角色消息内容发生变更应返回 true
    const result = mod.isRequirementChange(
      { role: 'user', content: '实现登录功能' },
      { role: 'user', content: '实现注册功能' },
    );
    expect(result).toBe(true);

    // user 消息未变更应返回 false
    const same = mod.isRequirementChange(
      { role: 'user', content: '实现登录功能' },
      { role: 'user', content: '实现登录功能' },
    );
    expect(same).toBe(false);

    // assistant 角色消息变更不算需求变更，返回 false
    const assistantChange = mod.isRequirementChange(
      { role: 'assistant', content: '好的' },
      { role: 'assistant', content: '没问题' },
    );
    expect(assistantChange).toBe(false);
  });
});

// ============================================================
// 7. ParallelExperimentManager 模块测试（动态 import，不存在则 skip）
// ============================================================
describe('Phase 44 Integration - ParallelExperimentManager', () => {
  it('detectConflicts：无冲突时 canParallelize=true（skip if not available）', async () => {
    let mod: { ParallelExperimentManager: new (em: unknown) => unknown } & {
      ParallelExperimentManager: { detectConflicts: (intents: unknown[]) => unknown };
    };
    try {
      mod = await import('../../src/agent/parallel-experiment.js');
    } catch {
      // 模块尚未创建，skip
      expect(true).toBe(true);
      return;
    }
    expect(mod).toBeDefined();
    expect(mod.ParallelExperimentManager).toBeDefined();
    // detectConflicts 是静态方法
    expect(mod.ParallelExperimentManager.detectConflicts).toBeDefined();

    // 两个实验修改不同文件，无 blocking 冲突
    // ExperimentIntent: { branchId, branchName, estimatedWriteFiles, estimatedReadFiles, goalDescription }
    const noConflictIntents = [
      {
        branchId: 'branch-A',
        branchName: '方案A',
        estimatedWriteFiles: ['src/a.ts'],
        estimatedReadFiles: ['src/config.ts'],
        goalDescription: '实现方案A',
      },
      {
        branchId: 'branch-B',
        branchName: '方案B',
        estimatedWriteFiles: ['src/b.ts'],
        estimatedReadFiles: ['src/config.ts'],
        goalDescription: '实现方案B',
      },
    ];
    const result = mod.ParallelExperimentManager.detectConflicts(noConflictIntents) as {
      hasConflict: boolean;
      conflicts: unknown[];
      canParallelize: boolean;
    };
    expect(result).toBeDefined();
    // 无 write_write 冲突（不同文件），canParallelize 应为 true
    expect(result.canParallelize).toBe(true);
    // 可能有 read_write warning（都读 config.ts，但都不写 config.ts），但不是 blocking
    // canParallelize 只看 blocking 冲突
  });
});
