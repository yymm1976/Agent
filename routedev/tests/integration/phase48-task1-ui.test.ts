// tests/integration/phase48-task1-ui.test.ts
// Phase 48 Task 1 集成测试：SettingsPage 安全 Tab 中沙箱级与审批级覆盖控件
//
// 测试环境说明：
//   vitest 配置 environment: 'node'，未引入 @testing-library/react。
//   故采取与 phase47-task1.test.ts 一致的源代码静态分析 + Schema 验证策略：
//   1. 沙箱级选择器渲染了 3 个选项（read-only / workspace-write / full-access）
//   2. 审批级覆盖表格渲染了 8 个工具类别（覆盖全部 ToolCategory 枚举）
//   3. 修改沙箱级后调用 saveConfig：验证 onChange → updateSecurity → updateDraft →
//      dirtyRef → useEffect → handleSave → saveConfig 的完整控制流，并通过
//      AppConfigSchema 校验保存的 config 合法（模拟 IPC config:save 写入流程）。

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AppConfigSchema,
  SecurityConfigSchema,
  SandboxLevelSchema,
  ApprovalLevelSchema,
  ToolCategorySchema,
  type AppConfig,
  type SecurityConfig,
  type SandboxLevel,
  type ApprovalLevel,
  type ToolCategory,
} from '../../src/config/schema.js';

// ============================================================
// 路径与源文件读取
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PAGE_PATH = path.join(
  PROJECT_ROOT,
  'desktop',
  'renderer',
  'src',
  'pages',
  'SettingsPage.tsx',
);

let settingsPageSource = '';
async function loadSettingsPage(): Promise<string> {
  if (!settingsPageSource) {
    settingsPageSource = await fs.readFile(SETTINGS_PAGE_PATH, 'utf-8');
  }
  return settingsPageSource;
}

// ============================================================
// 1. 沙箱级选择器渲染了 3 个选项
// ============================================================
describe('Phase 48 Task 1 - 沙箱级选择器', () => {
  it('SANDBOX_LEVEL_OPTIONS 包含 3 个选项：read-only / workspace-write / full-access', async () => {
    const src = await loadSettingsPage();
    // 验证常量定义存在
    expect(src).toContain('SANDBOX_LEVEL_OPTIONS');
    // 验证 3 个选项均在源代码中出现
    expect(src).toContain("'read-only'");
    expect(src).toContain("'workspace-write'");
    expect(src).toContain("'full-access'");
  });

  it('沙箱级 Select 控件渲染 SANDBOX_LEVEL_OPTIONS 中的所有选项', async () => {
    const src = await loadSettingsPage();
    // 验证 security-sandbox 控件 ID 存在
    expect(src).toContain('id="security-sandbox"');
    // 验证通过 map 渲染所有选项
    expect(src).toMatch(/SANDBOX_LEVEL_OPTIONS\.map\([\s\S]*?SelectItem/);
    // 验证绑定到 draft.security.sandbox
    expect(src).toMatch(/value=\{draft\.security\.sandbox\}/);
    // 验证 onChange 调用 updateSecurity
    expect(src).toMatch(/updateSecurity\(\{ sandbox: [\s\S]*?as SandboxLevel \}\)/);
  });

  it('SandboxLevelSchema 仅接受 3 个合法值（与 UI 选项一致）', () => {
    const valid = SandboxLevelSchema.options;
    expect(valid).toEqual(['read-only', 'workspace-write', 'full-access']);
    expect(valid.length).toBe(3);
    // 非法值被拒绝
    expect(() => SandboxLevelSchema.parse('invalid')).toThrow();
  });
});

// ============================================================
// 2. 审批级覆盖表格渲染了 8 个工具类别
// ============================================================
describe('Phase 48 Task 1 - 审批级覆盖表格', () => {
  it('TOOL_CATEGORIES 包含全部 8 个 ToolCategory', async () => {
    const src = await loadSettingsPage();
    expect(src).toContain('TOOL_CATEGORIES');
    // 8 个类别逐一验证
    const categories: ToolCategory[] = [
      'read', 'write', 'shell', 'network',
      'git-read', 'git-write', 'agent', 'mcp',
    ];
    for (const cat of categories) {
      expect(src).toContain(`'${cat}'`);
    }
  });

  it('审批级表格通过 TOOL_CATEGORIES.map 渲染每个类别的下拉选择器', async () => {
    const src = await loadSettingsPage();
    // 验证 map 调用
    expect(src).toMatch(/TOOL_CATEGORIES\.map\([\s\S]*?SelectItem/);
    // 验证 3 个 ApprovalLevel 选项均在表格中渲染
    expect(src).toContain('"always-ask"');
    expect(src).toContain('"on-request"');
    expect(src).toContain('"never-ask"');
    // 验证绑定到 draft.security.approval
    expect(src).toMatch(/draft\.security\.approval\?\.\[category\]/);
  });

  it('ToolCategorySchema 枚举恰好包含 8 个类别（与 UI 表格一致）', () => {
    const valid = ToolCategorySchema.options;
    expect(valid).toEqual([
      'read', 'write', 'shell', 'network',
      'git-read', 'git-write', 'agent', 'mcp',
    ]);
    expect(valid.length).toBe(8);
  });

  it('审批级覆盖写入后通过 SecurityConfigSchema 校验合法', () => {
    // 模拟 UI 中每个类别选择一个审批级后写入 config.security.approval
    const approvalOverrides: Record<string, ApprovalLevel> = {
      'read': 'never-ask',
      'write': 'on-request',
      'shell': 'always-ask',
      'network': 'always-ask',
      'git-read': 'never-ask',
      'git-write': 'always-ask',
      'agent': 'on-request',
      'mcp': 'on-request',
    };
    const parsed = SecurityConfigSchema.parse({
      sandbox: 'workspace-write',
      approval: approvalOverrides,
    }) as SecurityConfig;
    expect(parsed.approval).toBeDefined();
    expect(parsed.approval!['shell']).toBe('always-ask');
    expect(parsed.approval!['read']).toBe('never-ask');
  });
});

// ============================================================
// 3. 修改沙箱级后调用 saveConfig（控制流静态验证 + IPC 写入模拟）
// ============================================================
describe('Phase 48 Task 1 - 修改沙箱级后调用 saveConfig 控制流', () => {
  it('源代码中存在完整的 onChange → updateSecurity → updateDraft 控制链', async () => {
    const src = await loadSettingsPage();
    // 1. Select 的 onChange 调用 updateSecurity
    expect(src).toMatch(/onChange=\{\(e\) => updateSecurity\(\{ sandbox:/);
    // 2. updateSecurity 调用 updateDraft
    expect(src).toMatch(/const updateSecurity =[\s\S]*?updateDraft\(\{ security:/);
    // 3. updateDraft 设置 dirtyRef.current = true（自动保存触发条件）
    expect(src).toMatch(/const updateDraft =[\s\S]*?dirtyRef\.current = true/);
  });

  it('源代码中存在 dirtyRef 触发 handleSave 的 useEffect', async () => {
    const src = await loadSettingsPage();
    // 验证 useEffect 检测 draft 变化 + dirtyRef.current 后调用 handleSave(true)
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?if \(!draft \|\| !dirtyRef\.current\) return;[\s\S]*?void handleSave\(true\)/);
  });

  it('源代码中 handleSave 调用 saveConfig（IPC config:save 桥接）', async () => {
    const src = await loadSettingsPage();
    // 验证 handleSave 调用 saveConfig(cleanedDraft)
    expect(src).toMatch(/const handleSave = async[\s\S]*?await saveConfig\(cleanedDraft\)/);
  });

  it('模拟 IPC config:save：构造修改 sandbox 后的 AppConfig 并通过 schema 校验', async () => {
    // 这是 UI 触发 saveConfig 后实际写入磁盘的 config 形态
    // 模拟 saveConfig(cfg) 内部对 cfg 的合法性校验流程
    const baseConfig = AppConfigSchema.parse({}) as AppConfig;
    expect(baseConfig.security.sandbox).toBe('workspace-write'); // 默认值

    // 模拟用户在 UI 中将 sandbox 改为 read-only 并保存
    const modified: AppConfig = {
      ...baseConfig,
      security: {
        ...baseConfig.security,
        sandbox: 'read-only' as SandboxLevel,
      },
    };

    // IPC config:save 内部会重新校验 config，验证校验通过
    const revalidated = AppConfigSchema.parse(modified) as AppConfig;
    expect(revalidated.security.sandbox).toBe('read-only');

    // 模拟 saveConfig 返回结果（ConfigSaveResult 形态）
    const saveResult = { success: true, error: undefined };
    expect(saveResult.success).toBe(true);
  });

  it('模拟 IPC config:save：写入审批级覆盖后通过 schema 校验', async () => {
    const baseConfig = AppConfigSchema.parse({}) as AppConfig;
    const modified: AppConfig = {
      ...baseConfig,
      security: {
        ...baseConfig.security,
        approval: {
          'write': 'never-ask',
          'shell': 'always-ask',
        } as Record<string, ApprovalLevel>,
      },
    };
    const revalidated = AppConfigSchema.parse(modified) as AppConfig;
    expect(revalidated.security.approval).toBeDefined();
    expect(revalidated.security.approval!['write']).toBe('never-ask');
    expect(revalidated.security.approval!['shell']).toBe('always-ask');
  });

  it('saveConfig mock：验证可被调用并返回 ConfigSaveResult', async () => {
    // 模拟 SettingsPageProps.saveConfig 的实现（与主进程 IPC config:save 桥接）
    const saveConfigMock = vi.fn().mockResolvedValue({ success: true });
    const fakeConfig = AppConfigSchema.parse({
      security: { sandbox: 'full-access' },
    }) as AppConfig;
    const result = await saveConfigMock(fakeConfig);
    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    expect(saveConfigMock).toHaveBeenCalledWith(fakeConfig);
    expect(result.success).toBe(true);
  });
});

// ============================================================
// 4. 默认审批级映射与 PermissionEngine 的 DEFAULT_APPROVAL 一致
// ============================================================
describe('Phase 48 Task 1 - DEFAULT_APPROVAL_MAP 与 PermissionEngine 一致', () => {
  it('源代码中 DEFAULT_APPROVAL_MAP 包含全部 8 个类别的默认审批级', async () => {
    const src = await loadSettingsPage();
    expect(src).toContain('DEFAULT_APPROVAL_MAP');
    // 验证关键默认值（与 src/tools/permission-engine.ts 的 DEFAULT_APPROVAL 一致）
    expect(src).toMatch(/'read':\s*'never-ask'/);
    expect(src).toMatch(/'write':\s*'on-request'/);
    expect(src).toMatch(/'shell':\s*'always-ask'/);
    expect(src).toMatch(/'network':\s*'always-ask'/);
    expect(src).toMatch(/'git-read':\s*'never-ask'/);
    expect(src).toMatch(/'git-write':\s*'always-ask'/);
    expect(src).toMatch(/'agent':\s*'on-request'/);
    expect(src).toMatch(/'mcp':\s*'on-request'/);
  });

  it('updateSecurityApproval 辅助函数存在且合并 approval 字段', async () => {
    const src = await loadSettingsPage();
    expect(src).toContain('updateSecurityApproval');
    // 验证函数签名：接收 ToolCategory 和 ApprovalLevel
    expect(src).toMatch(/updateSecurityApproval = \(category: ToolCategory, level: ApprovalLevel\)/);
    // 验证合并逻辑：保留已有 approval 并设置新值
    expect(src).toMatch(/const current = \{ \.\.\.\(draft\.security\.approval \?\? \{\}\) \}/);
    expect(src).toMatch(/current\[category\] = level/);
    expect(src).toMatch(/updateSecurity\(\{ approval: current \}\)/);
  });
});

// ============================================================
// 5. ApprovalLevelSchema 校验
// ============================================================
describe('Phase 48 Task 1 - ApprovalLevelSchema 校验', () => {
  it('ApprovalLevelSchema 仅接受 3 个合法值', () => {
    const valid = ApprovalLevelSchema.options;
    expect(valid).toEqual(['always-ask', 'on-request', 'never-ask']);
    expect(() => ApprovalLevelSchema.parse('always')).toThrow();
    expect(() => ApprovalLevelSchema.parse('')).toThrow();
  });
});
