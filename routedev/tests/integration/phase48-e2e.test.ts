// tests/integration/phase48-e2e.test.ts
// Phase 48 端到端集成测试：验证 Task 1-5 模块协同工作
//
// 蓝图 6.1 节定义的 5 个端到端场景：
//   1. 引用 + Anthropic Skill 联动：@unit-test + file 引用 → CiteResolver 注入 skill prompt + 生成 read_file preflight
//   2. Codex Instructions + Macro 联动：.codex/instructions.md 导入 + !daily-standup 宏引用
//   3. MCP 桥接 + 工具引用联动：从 Claude Code 导入 MCP server + #<serverId_toolName> 工具引用
//   4. 引用持久化端到端：CiteManager 序列化/反序列化 + 切换分支后引用仍可见
//   5. 消息引用版本失效端到端：引用 message A → 编辑 A → 引用标记 outdated → 更新到最新版本
//
// 测试策略：
//   - 不依赖真实 LLM 调用，只验证模块协作的数据流正确性
//   - 使用 os.tmpdir() 创建临时项目根目录
//   - 每个场景独立 setup/teardown，互不干扰

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CiteManager } from '../../src/cite/manager.js';
import { CiteResolver } from '../../src/cite/resolver.js';
import type { CiteItem, MessageNodeInfo } from '../../src/cite/types.js';
import { AnthropicSkillsLoader } from '../../src/import/anthropic-skills-loader.js';
import { CodexInstructionImporter } from '../../src/import/codex-importer.js';
import { ClaudeMCPBridge } from '../../src/mcp/claude-bridge.js';
import { MacroManager } from '../../src/macros/manager.js';
import type { MacroConfig } from '../../src/macros/types.js';

// ============================================================
// 测试辅助
// ============================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase48-e2e-'));
});

afterEach(async () => {
  // Windows 下可能存在文件锁，重试删除
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

/** 创建临时项目根目录下的子目录 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/** 写入文件（自动创建父目录） */
async function writeFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

// ============================================================
// 场景 1：引用 + Anthropic Skill 联动
// ============================================================

describe('Phase 48 E2E — 场景 1：引用 + Anthropic Skill 联动', () => {
  it('用户 @unit-test 引用 Skill + file 引用 → CiteResolver 注入 skill prompt 并生成 read_file preflight', async () => {
    // --- 准备项目结构 ---
    // anthropic_skills/unit-test/SKILL.md
    const skillContent = `---
name: unit-test
description: 当需要为指定代码生成单元测试时使用此 Skill
version: 1.0.0
author: anthropic
tags: [test]
---
## 单元测试流程
1. 读取目标代码
2. 分析导出接口
3. 生成测试用例`;
    await writeFile(
      path.join(tempDir, 'anthropic_skills', 'unit-test', 'SKILL.md'),
      skillContent,
    );

    // 待测试的源文件
    const sourceFile = path.join(tempDir, 'src', 'calc.ts');
    await writeFile(sourceFile, 'export function add(a: number, b: number) { return a + b; }');

    // --- 步骤 1：扫描加载 Anthropic Skill ---
    const loader = new AnthropicSkillsLoader();
    // scan() 直接返回 LoadedSkill[]（不是 {loaded, errors}，那是 load() 的返回）
    const loadedSkills = await loader.scan(tempDir);
    expect(loadedSkills).toHaveLength(1);
    expect(loadedSkills[0]!.name).toBe('unit-test');
    expect(loadedSkills[0]!.origin).toBe('anthropic-skills');

    // --- 步骤 2：用户构造引用（@unit-test Skill + file 引用） ---
    const citeManager = new CiteManager();
    const skillItem: CiteItem = {
      id: 'cite-skill-1',
      type: 'skill',
      source: 'unit-test',
      label: 'unit-test',
      content: loadedSkills[0]!.content,
      createdAt: Date.now(),
      origin: 'trigger',
    };
    const fileItem: CiteItem = {
      id: 'cite-file-1',
      type: 'file',
      source: 'src/calc.ts',
      label: 'src/calc.ts',
      createdAt: Date.now(),
      origin: 'drag',
    };
    citeManager.add(skillItem);
    citeManager.add(fileItem);
    expect(citeManager.list()).toHaveLength(2);

    // --- 步骤 3：CiteResolver 解析引用 ---
    // 依赖注入：readSkillOrMacro 返回 SKILL.md 原文
    const resolver = new CiteResolver({
      deps: {
        readSkillOrMacro: async (name) => {
          if (name === 'unit-test') {
            return skillContent;
          }
          return null;
        },
      },
    });

    const resolution = await resolver.resolve({
      items: citeManager.list(),
      autoRunPreflight: true,
      sessionContext: { projectRoot: tempDir },
    });

    // --- 验证：skill prompt 被注入 ---
    expect(resolution.skillPrompts.length).toBeGreaterThan(0);
    expect(resolution.skillPrompts[0]).toContain('单元测试流程');

    // --- 验证：file 引用生成 read_file preflight ---
    const readFileCall = resolution.preflightTools.find((t) => t.name === 'read_file');
    expect(readFileCall).toBeDefined();
    expect(readFileCall!.citeItemId).toBe('cite-file-1');

    // --- 验证：injectedContext 包含引用上下文 ---
    expect(resolution.injectedContext).toContain('引用上下文');
    expect(resolution.blocked).toHaveLength(0);
  });
});

// ============================================================
// 场景 2：Codex Instructions + Macro 联动
// ============================================================

describe('Phase 48 E2E — 场景 2：Codex Instructions + Macro 联动', () => {
  it('.codex/instructions.md 导入为项目记忆 + !daily-standup 宏引用', async () => {
    // --- 准备项目结构 ---
    const codexContent = `# 项目规范

## 编码规范
- 所有函数必须有 TypeScript 类型标注
- 禁止使用 any

## 测试规范
- 测试覆盖率 >= 80%`;
    await writeFile(
      path.join(tempDir, '.codex', 'instructions.md'),
      codexContent,
    );

    // 创建 macros 目录
    const macrosDir = path.join(tempDir, '.routedev', 'macros');
    await ensureDir(macrosDir);

    // --- 步骤 1：扫描 Codex Instructions ---
    const codexImporter = new CodexInstructionImporter();
    const scanResult = await codexImporter.scan(tempDir);
    expect(scanResult.found).toBe(true);
    // 路径分隔符跨平台：用 path.join 而非硬编码正斜杠
    expect(scanResult.files).toContain(path.join('.codex', 'instructions.md'));
    expect(scanResult.content).toContain('编码规范');

    // --- 步骤 2：导入为项目记忆模式 ---
    const importResult = await codexImporter.import({
      projectRoot: tempDir,
      mode: 'project_memory',
      memoryTag: 'codex-instruction',
    });
    expect(importResult.mode).toBe('project_memory');
    expect(importResult.memoryEntries).toBeDefined();
    expect(importResult.memoryEntries!.length).toBeGreaterThan(0);

    // 验证每段记忆都打了 codex-instruction 标签
    for (const entry of importResult.memoryEntries!) {
      expect(entry.tag).toBe('codex-instruction');
    }

    // --- 步骤 3：加载 MacroManager，引用 daily-standup 宏 ---
    const macroConfig: MacroConfig = { enabled: true, dir: '.routedev/macros' };
    const macroManager = new MacroManager(macroConfig, tempDir);
    await macroManager.loadAll();

    const dailyStandup = macroManager.getMacro('daily-standup');
    expect(dailyStandup).toBeDefined();
    expect(dailyStandup!.metadata.name).toBe('daily-standup');

    // --- 步骤 4：CiteResolver 解析 macro 引用 ---
    const macroItem: CiteItem = {
      id: 'cite-macro-1',
      type: 'macro',
      source: 'daily-standup',
      label: 'daily-standup',
      createdAt: Date.now(),
      origin: 'trigger',
    };

    const resolver = new CiteResolver({
      deps: {
        readSkillOrMacro: async (name, kind) => {
          if (kind === 'macro' && name === 'daily-standup') {
            const macro = macroManager.getMacro('daily-standup');
            if (!macro) return null;
            // 构造 MACRO.md 原文（frontmatter + content）
            const frontmatter = `---
name: ${macro.metadata.name}
description: ${macro.metadata.description ?? ''}
---
`;
            return frontmatter + (macro.content ?? '');
          }
          return null;
        },
      },
    });

    const resolution = await resolver.resolve({
      items: [macroItem],
      autoRunPreflight: false,
      sessionContext: { projectRoot: tempDir },
    });

    // --- 验证：macro prompt 被注入 ---
    expect(resolution.macroPrompts.length).toBeGreaterThan(0);

    // --- 验证：Codex instructions 的内容可作为项目记忆与 Macro 协同 ---
    // 实际场景中，project_memory 会通过 ProjectMemoryManager.appendMemory 写入；
    // 这里验证导入产出的 memoryEntries 内容确实包含 Codex 规范
    const allMemoryContent = importResult.memoryEntries!.map((e) => e.content).join('\n');
    expect(allMemoryContent).toContain('编码规范');
  });
});

// ============================================================
// 场景 3：MCP 桥接 + 工具引用联动
// ============================================================

describe('Phase 48 E2E — 场景 3：MCP 桥接 + 工具引用联动', () => {
  it('从 Claude Code 导入 MCP server + #<serverId_toolName> 工具引用生成 allowedTools', async () => {
    // --- 准备 .mcp.json 配置 ---
    const mcpConfig = {
      'db-server': {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
      'web-server': {
        type: 'http',
        url: 'https://mcp.example.com/api',
      },
    };
    const mcpConfigPath = path.join(tempDir, '.mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // --- 步骤 1：ClaudeMCPBridge 导入 ---
    const bridge = new ClaudeMCPBridge();
    const importResult = await bridge.importFromClaudeConfig(mcpConfigPath, {
      origin: 'claude-code',
      defaultLifecycle: 'per-session',
    });

    expect(importResult.servers).toHaveLength(2);
    expect(importResult.failed).toHaveLength(0);

    const dbServer = importResult.servers.find((s) => s.id === 'db-server');
    expect(dbServer).toBeDefined();
    expect(dbServer!.config.transport).toBe('stdio');
    expect(dbServer!.origin).toBe('claude-code');

    const webServer = importResult.servers.find((s) => s.id === 'web-server');
    expect(webServer).toBeDefined();
    expect(webServer!.config.transport).toBe('http');

    // --- 步骤 2：用户构造 #db-server_query 工具引用 ---
    const toolItem: CiteItem = {
      id: 'cite-tool-1',
      type: 'tool',
      source: 'db-server_query',
      label: 'db-server_query',
      createdAt: Date.now(),
      origin: 'trigger',
    };

    // --- 步骤 3：CiteResolver 解析 tool 引用 → 生成 allowedTools 白名单 ---
    const resolver = new CiteResolver();
    const resolution = await resolver.resolve({
      items: [toolItem],
      autoRunPreflight: false,
      sessionContext: { projectRoot: tempDir },
    });

    // --- 验证：allowedTools 包含引用的工具 ---
    expect(resolution.allowedTools).toBeDefined();
    expect(resolution.allowedTools).toContain('db-server_query');
  });
});

// ============================================================
// 场景 4：引用持久化端到端
// ============================================================

describe('Phase 48 E2E — 场景 4：引用持久化端到端', () => {
  it('CiteManager 序列化引用 → 切换分支 → 反序列化后引用仍可见', () => {
    // --- 步骤 1：用户构造 file + text 引用 ---
    const citeManager = new CiteManager();
    const fileItem: CiteItem = {
      id: 'cite-file-1',
      type: 'file',
      source: 'src/index.ts',
      label: 'src/index.ts',
      createdAt: Date.now(),
      origin: 'drag',
    };
    const textItem: CiteItem = {
      id: 'cite-text-1',
      type: 'text',
      source: 'user-selection',
      label: 'BranchManager 已经具备...',
      content: 'BranchManager 已经具备消息节点树',
      createdAt: Date.now(),
      origin: 'user-select',
    };
    citeManager.add(fileItem);
    citeManager.add(textItem);
    expect(citeManager.list()).toHaveLength(2);

    // --- 步骤 2：序列化为 JSON（模拟发送时持久化到消息对象） ---
    const serialized = citeManager.toJSON();
    expect(serialized).toHaveLength(2);
    const jsonStr = JSON.stringify(serialized);

    // --- 步骤 3：切换分支（清空当前输入框引用） ---
    citeManager.clear();
    expect(citeManager.list()).toHaveLength(0);

    // --- 步骤 4：从消息历史反序列化引用（模拟切回原分支后渲染消息气泡） ---
    const restoredItems: CiteItem[] = JSON.parse(jsonStr);
    expect(restoredItems).toHaveLength(2);

    const restoredFile = restoredItems.find((i) => i.type === 'file');
    expect(restoredFile).toBeDefined();
    expect(restoredFile!.source).toBe('src/index.ts');

    const restoredText = restoredItems.find((i) => i.type === 'text');
    expect(restoredText).toBeDefined();
    expect(restoredText!.content).toContain('BranchManager');

    // --- 步骤 5：formatForUI 可正确渲染反序列化后的引用 ---
    const restoredManager = new CiteManager();
    for (const item of restoredItems) {
      restoredManager.add(item);
    }
    const tags = restoredManager.formatForUI();
    expect(tags).toHaveLength(2);
    expect(tags.some((t) => t.type === 'file')).toBe(true);
    expect(tags.some((t) => t.type === 'text')).toBe(true);
  });
});

// ============================================================
// 场景 5：消息引用版本失效端到端
// ============================================================

describe('Phase 48 E2E — 场景 5：消息引用版本失效端到端', () => {
  it('引用 message A → 编辑 A → 引用标记 outdated → 更新到最新版本', async () => {
    // --- 准备：模拟消息节点 A 的初始状态 ---
    let nodeA: MessageNodeInfo = {
      nodeId: 'node-a',
      version: 1,
      branchId: 'main',
      deleted: false,
      content: '原始消息 A 的内容',
    };

    // --- 步骤 1：用户发送消息 B，引用消息 A（记录 targetVersion=1） ---
    const messageCiteItem: CiteItem = {
      id: 'cite-msg-1',
      type: 'message',
      source: 'node-a',
      label: '原始消息 A...',
      targetVersion: 1,
      targetBranchId: 'main',
      createdAt: Date.now(),
      origin: 'user-select',
    };

    // --- 步骤 2：CiteResolver 解析（版本一致 → 正常注入） ---
    const resolver = new CiteResolver({
      deps: {
        messageNodeProvider: async (nodeId) => {
          if (nodeId === 'node-a') return nodeA;
          return null;
        },
      },
    });

    const resolution1 = await resolver.resolve({
      items: [messageCiteItem],
      autoRunPreflight: false,
      sessionContext: { currentBranchId: 'main', projectRoot: tempDir },
    });

    // 验证：版本一致，注入了 A 的内容
    expect(resolution1.injectedContext).toContain('原始消息 A 的内容');
    expect(resolution1.blocked).toHaveLength(0);

    // --- 步骤 3：用户编辑消息 A（version 自增至 2） ---
    nodeA = {
      ...nodeA,
      version: 2,
      content: '编辑后的消息 A 内容',
    };

    // --- 步骤 4：再次解析引用（版本不一致 → 标记 outdated） ---
    const resolution2 = await resolver.resolve({
      items: [messageCiteItem],
      autoRunPreflight: false,
      sessionContext: { currentBranchId: 'main', projectRoot: tempDir },
    });

    // 验证：引用状态标记为 outdated（检查 status 字段更稳定，blockedReason 是中文）
    const outdatedItem = resolution2.blocked.find(
      (b) => b.id === 'cite-msg-1' && b.status === 'outdated',
    );
    expect(outdatedItem).toBeDefined();

    // --- 步骤 5：用户选择"更新到最新版本" → 修改 targetVersion 为 2 ---
    const updatedCiteItem: CiteItem = {
      ...messageCiteItem,
      targetVersion: 2,
      label: '编辑后的消息 A...',
    };

    // --- 步骤 6：再次解析（版本一致 → 注入最新内容） ---
    const resolution3 = await resolver.resolve({
      items: [updatedCiteItem],
      autoRunPreflight: false,
      sessionContext: { currentBranchId: 'main', projectRoot: tempDir },
    });

    // 验证：注入的是编辑后的内容
    expect(resolution3.injectedContext).toContain('编辑后的消息 A 内容');
    expect(resolution3.blocked).toHaveLength(0);
  });

  it('引用的 message 在分支隔离时标记 unreachable', async () => {
    const nodeA: MessageNodeInfo = {
      nodeId: 'node-a',
      version: 1,
      branchId: 'feature-branch',
      deleted: false,
      content: 'feature 分支的消息',
    };

    const messageCiteItem: CiteItem = {
      id: 'cite-msg-2',
      type: 'message',
      source: 'node-a',
      label: 'feature 分支的消息...',
      targetVersion: 1,
      targetBranchId: 'feature-branch',
      createdAt: Date.now(),
      origin: 'user-select',
    };

    const resolver = new CiteResolver({
      deps: {
        messageNodeProvider: async (nodeId) => {
          if (nodeId === 'node-a') return nodeA;
          return null;
        },
      },
    });

    // 当前在 main 分支，引用指向 feature-branch → unreachable
    const resolution = await resolver.resolve({
      items: [messageCiteItem],
      autoRunPreflight: false,
      sessionContext: { currentBranchId: 'main', projectRoot: tempDir },
    });

    const unreachableItem = resolution.blocked.find(
      (b) => b.id === 'cite-msg-2' && b.status === 'unreachable',
    );
    expect(unreachableItem).toBeDefined();
  });

  it('引用的 message 被删除后标记 deleted 且不注入上下文', async () => {
    const nodeA: MessageNodeInfo = {
      nodeId: 'node-a',
      version: 1,
      branchId: 'main',
      deleted: true, // 已删除
      content: 'should not be injected',
    };

    const messageCiteItem: CiteItem = {
      id: 'cite-msg-3',
      type: 'message',
      source: 'node-a',
      label: '已删除的消息...',
      targetVersion: 1,
      targetBranchId: 'main',
      createdAt: Date.now(),
      origin: 'user-select',
    };

    const resolver = new CiteResolver({
      deps: {
        messageNodeProvider: async (nodeId) => {
          if (nodeId === 'node-a') return nodeA;
          return null;
        },
      },
    });

    const resolution = await resolver.resolve({
      items: [messageCiteItem],
      autoRunPreflight: false,
      sessionContext: { currentBranchId: 'main', projectRoot: tempDir },
    });

    // 验证：标记 deleted 且不注入内容（检查 status 字段更稳定）
    const deletedItem = resolution.blocked.find(
      (b) => b.id === 'cite-msg-3' && b.status === 'deleted',
    );
    expect(deletedItem).toBeDefined();
    expect(resolution.injectedContext).not.toContain('should not be injected');
  });
});
