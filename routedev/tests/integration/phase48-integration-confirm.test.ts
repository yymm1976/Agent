// tests/integration/phase48-integration-confirm.test.ts
// Phase 50 Task 5：Phase 48 模块接入确认测试
//
// 确认 cite/import/macros/mcp 四模块在生产路径（app-init.ts）中接入
// 测试策略：
//   1. 验证配置开关存在且默认值正确
//   2. 验证各模块类可被实例化（接入点可用）
//   3. 验证配置开关可禁用模块
//   4. 验证模块间的协作（如 CiteResolver 解析引用、MacroManager 加载宏）

import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { CiteResolver } from '../../src/cite/resolver.js';
import { MacroManager } from '../../src/macros/manager.js';
import { ClaudePluginImporter } from '../../src/import/claude-plugin-importer.js';
import { CodexInstructionImporter } from '../../src/import/codex-importer.js';
import { ClaudeMCPBridge } from '../../src/mcp/claude-bridge.js';

// ============================================================
// 测试
// ============================================================

describe('Phase 50 Task 5：Phase 48 模块接入确认', () => {
  describe('配置开关', () => {
    it('phase48Integration 配置存在且默认全部启用', () => {
      // 解析空配置，应使用默认值
      const config = AppConfigSchema.parse({});

      expect(config.phase48Integration).toBeDefined();
      expect(config.phase48Integration.citeEnabled).toBe(true);
      expect(config.phase48Integration.importEnabled).toBe(true);
      expect(config.phase48Integration.macrosEnabled).toBe(true);
      expect(config.phase48Integration.mcpBridgeEnabled).toBe(true);
    });

    it('所有模块可通过配置开关禁用', () => {
      const config = AppConfigSchema.parse({
        phase48Integration: {
          citeEnabled: false,
          importEnabled: false,
          macrosEnabled: false,
          mcpBridgeEnabled: false,
        },
      });

      expect(config.phase48Integration.citeEnabled).toBe(false);
      expect(config.phase48Integration.importEnabled).toBe(false);
      expect(config.phase48Integration.macrosEnabled).toBe(false);
      expect(config.phase48Integration.mcpBridgeEnabled).toBe(false);
    });
  });

  describe('cite 引用系统：CiteResolver 可被实例化并解析引用', () => {
    it('CiteResolver 实例化成功并解析 text 引用注入上下文', async () => {
      const resolver = new CiteResolver({
        config: { enabled: true, maxTextCiteLength: 2000 },
      });

      const result = await resolver.resolve({
        items: [
          {
            id: 'cite-1',
            type: 'text',
            source: 'text-source',
            content: '这是被引用的文本内容',
            label: '文本引用',
          },
        ],
      });

      // 验证注入的上下文包含引用文本
      expect(result.injectedContext).toContain('引用上下文');
      expect(result.injectedContext).toContain('这是被引用的文本内容');
      // text 引用不产生 preflight
      expect(result.preflightTools.length).toBe(0);
    });
  });

  describe('import 外部生态导入：导入器可被调用', () => {
    it('ClaudePluginImporter 和 CodexInstructionImporter 可被实例化', () => {
      const pluginImporter = new ClaudePluginImporter();
      const codexImporter = new CodexInstructionImporter();

      expect(pluginImporter).toBeInstanceOf(ClaudePluginImporter);
      expect(codexImporter).toBeInstanceOf(CodexInstructionImporter);

      // 验证关键方法存在
      expect(typeof pluginImporter.importFromPath).toBe('function');
      expect(typeof codexImporter.scan).toBe('function');
      expect(typeof codexImporter.import).toBe('function');
    });

    it('CodexInstructionImporter.scan 在无 .codex 目录时返回 found=false', async () => {
      const importer = new CodexInstructionImporter();
      // 使用一个不存在的路径
      const result = await importer.scan('/nonexistent/path/for/test');

      expect(result.found).toBe(false);
      expect(result.files.length).toBe(0);
    });
  });

  describe('macros 宏系统：MacroManager `!` 触发器工作', () => {
    it('MacroManager 实例化并加载内置宏，支持 `!` 触发器搜索', async () => {
      const macroManager = new MacroManager(
        { enabled: true, dir: '.routedev/macros' },
        process.cwd(),
      );

      // 加载宏（含内置宏）
      await macroManager.loadAll();

      // 验证有内置宏可用（`!` 触发器搜索应返回结果）
      const allMacros = macroManager.listMacros();
      expect(allMacros.length).toBeGreaterThan(0);

      // 验证 searchMacros 可被调用（`!` 触发器补全接口）
      const searchResult = macroManager.searchMacros('');
      expect(Array.isArray(searchResult)).toBe(true);
    });
  });

  describe('mcp 桥接：ClaudeMCPBridge 可加载配置', () => {
    it('ClaudeMCPBridge 实例化并可调用 importFromClaudeConfig', async () => {
      const bridge = new ClaudeMCPBridge();

      // 验证实例方法存在
      expect(typeof bridge.importFromClaudeConfig).toBe('function');

      // 调用导入（不存在的文件应返回空 servers，不抛异常）
      const result = await bridge.importFromClaudeConfig('/nonexistent/.mcp.json');

      expect(result).toBeDefined();
      expect(result.servers).toBeDefined();
      expect(Array.isArray(result.servers)).toBe(true);
      // 文件不存在时 servers 为空
      expect(result.servers.length).toBe(0);
    });
  });
});
