// tests/phase36/mcp-codebase-integration.test.ts
// Phase 36 Task 1 + Task 5：codebase-memory-mcp 集成测试
// 验证：MCP 配置 schema、config.example.yaml 完整性、安装脚本存在性、Skill 路由匹配

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MCPConfigSchema,
  MCPServerEntrySchema,
  type MCPConfig,
} from '../../src/config/schema.js';
import { SkillsRouter, type SkillDefinition } from '../../src/plugins/filesystem-discovery.js';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CONFIG_EXAMPLE = path.join(PROJECT_ROOT, 'config.example.yaml');
const SETUP_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'setup-codebase-memory.sh');
const CODEBASE_SKILL_PATH = path.join(
  PROJECT_ROOT,
  '.routedev',
  'skills',
  'codebase-intelligence',
  'SKILL.md',
);

// ============================================================
// 测试用例
// ============================================================

describe('Phase 36 Task 1：codebase-memory-mcp 集成', () => {
  describe('MCP 配置 schema 验证', () => {
    it('codebase-memory 条目应能被 MCPServerEntrySchema 正确解析', () => {
      // 模拟 config.example.yaml 中的 codebase-memory 条目
      const entry = {
        id: 'codebase-memory',
        name: 'Codebase Memory',
        enabled: false,
        config: {
          transport: 'stdio' as const,
          command: 'codebase-memory',
          args: ['--stdio'],
        },
      };
      const parsed = MCPServerEntrySchema.parse(entry);
      expect(parsed.id).toBe('codebase-memory');
      expect(parsed.enabled).toBe(false);
      expect(parsed.config.transport).toBe('stdio');
      expect(parsed.config.command).toBe('codebase-memory');
    });

    it('MCPConfigSchema 应接受包含 codebase-memory 的完整 mcp 配置', () => {
      const mcpConfig: MCPConfig = {
        autoConnect: true,
        servers: [
          {
            id: 'codebase-memory',
            name: 'Codebase Memory',
            enabled: false,
            config: {
              transport: 'stdio',
              command: 'codebase-memory',
              args: ['--stdio'],
            },
          },
        ],
      };
      const parsed = MCPConfigSchema.parse(mcpConfig);
      expect(parsed.servers).toHaveLength(1);
      expect(parsed.servers[0].id).toBe('codebase-memory');
      expect(parsed.autoConnect).toBe(true);
    });
  });

  describe('config.example.yaml 完整性', () => {
    it('应包含 codebase-memory MCP 服务器预配置', async () => {
      const content = await fs.readFile(CONFIG_EXAMPLE, 'utf-8');
      // 验证关键配置项存在
      expect(content).toContain('mcp:');
      expect(content).toContain('codebase-memory');
      expect(content).toContain('Codebase Memory');
      expect(content).toContain('transport: stdio');
      expect(content).toContain('command: codebase-memory');
      // 默认应为 false（需安装后启用）
      expect(content).toMatch(/enabled:\s*false/);
    });

    it('应包含安装脚本提示注释', async () => {
      const content = await fs.readFile(CONFIG_EXAMPLE, 'utf-8');
      expect(content).toContain('setup-codebase-memory.sh');
    });
  });

  describe('安装脚本存在性', () => {
    it('scripts/setup-codebase-memory.sh 应存在', async () => {
      const stat = await fs.stat(SETUP_SCRIPT);
      expect(stat.isFile()).toBe(true);
    });

    it('安装脚本应包含平台检测和二进制下载逻辑', async () => {
      const content = await fs.readFile(SETUP_SCRIPT, 'utf-8');
      // 验证脚本包含关键逻辑
      expect(content).toMatch(/linux|darwin|windows/i);
      expect(content).toMatch(/x64|arm64/i);
      expect(content).toMatch(/download|curl|wget/i);
    });
  });

  describe('codebase-intelligence Skill 路由匹配', () => {
    it('Skill 文件应存在且包含正确的 YAML frontmatter', async () => {
      const content = await fs.readFile(CODEBASE_SKILL_PATH, 'utf-8');
      // 验证 YAML frontmatter 存在
      expect(content.startsWith('---')).toBe(true);
      // 验证关键字段
      expect(content).toContain('description:');
      expect(content).toContain('keywords:');
      // 验证内容包含工具说明
      expect(content).toContain('codegraph_search');
      expect(content).toContain('codegraph_callers');
      expect(content).toContain('codegraph_callees');
      expect(content).toContain('codegraph_impact');
      expect(content).toContain('codegraph_explore');
    });

    it('SkillsRouter 应能根据代码分析任务描述路由到 codebase-intelligence', () => {
      const router = new SkillsRouter();
      const skill: SkillDefinition = {
        name: 'codebase-intelligence',
        description: '代码结构、调用链、影响分析、死代码、依赖关系、codegraph、callers、callees、impact、explore、重构、代码审查、代码导航',
        routingKeywords: [
          '代码结构', '调用链', '影响分析', '死代码', '依赖关系',
          'codegraph', 'callers', 'callees', 'impact', 'explore',
          '重构', '代码审查', '代码导航', '函数调用', '模块依赖',
        ],
        content: 'skill body',
        sourcePath: CODEBASE_SKILL_PATH,
      };
      router.register(skill);

      // 任务描述包含路由关键词
      const matched = router.route('分析 filterContext 函数的调用链和影响范围', 3);
      expect(matched.length).toBeGreaterThanOrEqual(1);
      expect(matched[0].name).toBe('codebase-intelligence');
    });

    it('SkillsRouter 不应匹配无关任务描述', () => {
      const router = new SkillsRouter();
      const skill: SkillDefinition = {
        name: 'codebase-intelligence',
        description: '代码结构、调用链、影响分析',
        routingKeywords: ['codegraph', 'callers', 'callees', 'impact', 'explore', '重构'],
        content: '',
        sourcePath: '',
      };
      router.register(skill);

      // 无关任务不应匹配
      const matched = router.route('今天天气真好，适合散步', 3);
      expect(matched.length).toBe(0);
    });
  });
});
