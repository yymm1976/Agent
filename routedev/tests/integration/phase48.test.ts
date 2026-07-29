// tests/integration/phase48.test.ts
// Phase 48 端到端集成测试：验证 Task 1-6 功能接线收尾的协同工作
//
// 测试策略（源代码静态分析方式，与 Phase 47 Task 10 一致）：
//   1. app-init.ts 中 permissionEngine 从 config.security.sandbox 读取并调用 setSandboxLevel（Task 1）
//   2. app-init.ts 中调用 loadProjectDoc（Task 2）
//   3. [已删除] app-init.ts 中创建 ScheduleEngine 实例（Task 3）—— ScheduleEngine 空转引擎已移除
//   4. ProjectMemoryManager 有 setProjectDoc/getProjectDoc 方法（Task 2）
//   5. spawn-agent.ts 有 resolveProfileForSubagent 函数（Task 4 AgentProfileManager 接入）
//   6. [已删除] trace-collector.ts 有 getTrajectoryAggregator 方法（Task 6）—— TrajectoryAggregator 死链清理已移除
//   7. package.json scripts 包含 lint:descriptions（Task 5）
//   8. [已删除] src/cli/exec.ts 不存在（Task 5）—— CLI 退役，exec.ts 与 exec-runner.ts 均已删除
//   9. SettingsPage.tsx 包含沙箱级选择器（SandboxLevel，Task 1 UI）
//  10. [已删除] service-context.ts ServiceContext 接口包含 scheduleEngine 字段（Task 3）

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProjectMemoryManager } from '../../src/memory/project-memory.js';
import {
  resolveProfileForSubagent,
  createChildRegistry,
} from '../../src/tools/builtin/spawn-agent.js';
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
import { createDefaultEngine } from '../../src/tools/permission-engine.js';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APP_INIT_PATH = path.join(PROJECT_ROOT, 'src', 'runtime', 'app-init.ts');
// Phase 78 重构：createDefaultEngine/setSandboxLevel/setApproval 已迁移至 app-init-tools.ts
// 源码静态分析需同时读取两文件，保证迁移后断言仍能命中
const APP_INIT_TOOLS_PATH = path.join(PROJECT_ROOT, 'src', 'runtime', 'app-init-tools.ts');
const PROJECT_MEMORY_PATH = path.join(PROJECT_ROOT, 'src', 'memory', 'project-memory.ts');
const SPAWN_AGENT_PATH = path.join(PROJECT_ROOT, 'src', 'tools', 'builtin', 'spawn-agent.ts');
// Phase 74-G：SANDBOX_LEVEL_OPTIONS / 沙箱级 Select 控件已迁移至 SettingsSecurityTab.tsx
const SETTINGS_SECURITY_TAB_PATH = path.join(
  PROJECT_ROOT,
  'desktop',
  'renderer',
  'src',
  'components',
  'settings',
  'SettingsSecurityTab.tsx',
);
const SETTINGS_PAGE_PATH = path.join(
  PROJECT_ROOT,
  'desktop',
  'renderer',
  'src',
  'pages',
  'SettingsPage.tsx',
);
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

// ============================================================
// 工具函数
// ============================================================

/** 读取文件内容 */
async function readFile(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf-8');
}

/** 读取 app-init.ts + app-init-tools.ts 合并内容（Phase 78 重构后两者均需参与断言） */
async function readAppInitMerged(): Promise<string> {
  const [main, tools] = await Promise.all([
    readFile(APP_INIT_PATH),
    readFile(APP_INIT_TOOLS_PATH),
  ]);
  return main + '\n' + tools;
}

/** 读取 SettingsPage + SettingsSecurityTab 合并内容（Phase 74-G 重构后两者均需参与断言） */
async function readSettingsMerged(): Promise<string> {
  const [page, tab] = await Promise.all([
    readFile(SETTINGS_PAGE_PATH),
    readFile(SETTINGS_SECURITY_TAB_PATH),
  ]);
  return page + '\n' + tab;
}

// ============================================================
// 1. app-init.ts 中 permissionEngine 从 config.security.sandbox 读取并调用 setSandboxLevel（Task 1）
// ============================================================
describe('Phase 48 E2E - Task 1: permissionEngine 接线 config.security.sandbox', () => {
  it('app-init.ts 包含 createDefaultEngine 创建 permissionEngine', async () => {
    const content = await readAppInitMerged();
    expect(content).toContain('createDefaultEngine');
    expect(content).toContain('permissionEngine');
  });

  it('app-init.ts 从 config.security.sandbox 读取并调用 setSandboxLevel', async () => {
    const content = await readAppInitMerged();
    // Phase 48 Task 1：从配置应用沙箱级
    expect(content).toContain('config.security?.sandbox');
    expect(content).toContain('permissionEngine.setSandboxLevel');
  });

  it('app-init.ts 从 config.security.approval 读取并调用 setApproval', async () => {
    const content = await readAppInitMerged();
    expect(content).toContain('config.security?.approval');
    expect(content).toContain('permissionEngine.setApproval');
  });

  it('createDefaultEngine + setSandboxLevel 在交互模式下生效', () => {
    // 验证 createDefaultEngine 返回的实例支持 setSandboxLevel
    const engine = createDefaultEngine();
    expect(typeof engine.setSandboxLevel).toBe('function');
    expect(typeof engine.setApproval).toBe('function');
    // 切换沙箱级不抛错
    engine.setSandboxLevel('read-only');
    engine.setApproval('write', 'never-ask');
  });
});

// ============================================================
// 2. app-init.ts 中调用 loadProjectDoc（Task 2）
// ============================================================
describe('Phase 48 E2E - Task 2: app-init.ts 调用 loadProjectDoc', () => {
  // G-F027：loadProjectDoc 已从 app-init 移除（无消费方，数据流断裂）
  // 这两个测试仅验证历史接线，跳过以反映当前架构
  it.skip('app-init.ts 导入 loadProjectDoc', async () => {
    const content = await readFile(APP_INIT_PATH);
    expect(content).toMatch(/import.*loadProjectDoc.*from.*'\.\.\/memory\/project-memory\.js'/);
  });

  it.skip('app-init.ts 调用 loadProjectDoc 并将结果注入 projectMemory', async () => {
    const content = await readFile(APP_INIT_PATH);
    // Phase 48 Task 2：接线 loadProjectDoc
    expect(content).toContain('loadProjectDoc(cwd');
    // 注入到 projectMemory 供 system prompt 使用
    expect(content).toContain('projectMemory.setProjectDoc');
  });
});

// ============================================================
// 4. ProjectMemoryManager 有 setProjectDoc/getProjectDoc 方法（Task 2）
// ============================================================
describe('Phase 48 E2E - Task 2: ProjectMemoryManager setProjectDoc/getProjectDoc', () => {
  it('ProjectMemoryManager.prototype 上存在 setProjectDoc 和 getProjectDoc 方法', () => {
    expect(typeof ProjectMemoryManager.prototype.setProjectDoc).toBe('function');
    expect(typeof ProjectMemoryManager.prototype.getProjectDoc).toBe('function');
  });

  it('setProjectDoc/getProjectDoc 读写一致', () => {
    const mgr = new ProjectMemoryManager(process.cwd(), {
      enabled: false,
      maxMemorySize: 65536,
      maxDecisions: 100,
      autoInject: false,
    });
    expect(mgr.getProjectDoc()).toBeNull();
    mgr.setProjectDoc('# AGENTS\n\n这是项目文档');
    expect(mgr.getProjectDoc()).toBe('# AGENTS\n\n这是项目文档');
  });

  it('project-memory.ts 源代码包含 setProjectDoc/getProjectDoc 定义', async () => {
    const content = await readFile(PROJECT_MEMORY_PATH);
    expect(content).toContain('setProjectDoc(doc: string)');
    expect(content).toContain('getProjectDoc()');
  });
});

// ============================================================
// 5. spawn-agent.ts 有 resolveProfileForSubagent 函数（Task 4 AgentProfileManager 接入）
// ============================================================
describe('Phase 48 E2E - Task 4: spawn-agent.ts 接入 AgentProfileManager', () => {
  it('resolveProfileForSubagent 是已导出的函数', () => {
    expect(typeof resolveProfileForSubagent).toBe('function');
  });

  it('createChildRegistry 支持传入 AgentProfileManager（第 3 个可选参数）', async () => {
    expect(typeof createChildRegistry).toBe('function');
    // 通过源代码验证 createChildRegistry 签名包含 profileManager 参数
    const content = await readFile(SPAWN_AGENT_PATH);
    expect(content).toMatch(/export function createChildRegistry\([\s\S]*?profileManager\?:\s*AgentProfileManager/);
  });

  it('spawn-agent.ts 源代码包含 AgentProfileManager 引用', async () => {
    const content = await readFile(SPAWN_AGENT_PATH);
    expect(content).toContain('AgentProfileManager');
    expect(content).toContain('resolveProfileForSubagent');
    expect(content).toContain('profileManager');
  });

  it('resolveProfileForSubagent 未传 profileManager 时返回 null（向后兼容）', () => {
    const profile = resolveProfileForSubagent(undefined, 'reviewer');
    expect(profile).toBeNull();
  });

  it('AgentProfileManager 类可被实例化且包含 loadAll 方法（懒加载支持）', () => {
    const mgr = new AgentProfileManager(process.cwd());
    expect(mgr).toBeInstanceOf(AgentProfileManager);
    expect(typeof mgr.loadAll).toBe('function');
  });
});

// ============================================================
// 7. package.json scripts 包含 lint:descriptions（Task 5）
// ============================================================
describe('Phase 48 E2E - Task 5: package.json scripts 包含 lint:descriptions', () => {
  it('package.json 文件存在且可解析', () => {
    expect(fs.existsSync(PACKAGE_JSON_PATH)).toBe(true);
    const content = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
    const pkg = JSON.parse(content) as { scripts: Record<string, string> };
    expect(pkg.scripts).toBeDefined();
    expect(typeof pkg.scripts).toBe('object');
  });

  it('scripts 中包含 lint:descriptions 条目', () => {
    const content = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
    const pkg = JSON.parse(content) as { scripts: Record<string, string> };
    // 注意：键名包含冒号，必须用方括号访问
    expect(pkg.scripts['lint:descriptions']).toBeDefined();
    expect(pkg.scripts['lint:descriptions']).toContain('lint-descriptions.ts');
  });
});

// ============================================================
// 9. SettingsPage.tsx 包含沙箱级选择器（SandboxLevel，Task 1 UI）
// ============================================================
describe('Phase 48 E2E - Task 1 UI: SettingsPage 沙箱级选择器', () => {
  it('SettingsPage.tsx 导入 SandboxLevel 类型', async () => {
    const content = await readSettingsMerged();
    expect(content).toContain('SandboxLevel');
  });

  it('SettingsPage.tsx 定义 SANDBOX_LEVEL_OPTIONS 常量（3 个选项）', async () => {
    const content = await readSettingsMerged();
    expect(content).toContain('SANDBOX_LEVEL_OPTIONS');
    expect(content).toContain("'read-only'");
    expect(content).toContain("'workspace-write'");
    expect(content).toContain("'full-access'");
  });

  it('SettingsPage.tsx 包含沙箱级 Select 控件', async () => {
    const content = await readSettingsMerged();
    expect(content).toContain('id="security-sandbox"');
    // 控件绑定到 draft.security.sandbox
    expect(content).toMatch(/value=\{draft\.security\.sandbox\}/);
  });
});
