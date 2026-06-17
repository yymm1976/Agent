// src/prompts/manager.ts
// Prompt 模板管理器：统一管理所有 Prompt 模板
//
// 三级优先级：
//   1. 项目覆盖：{project}/.routedev/prompts/{id}.md
//   2. 用户自定义：{AppData}/prompts/{id}.md
//   3. 内置默认：代码中的 fallback

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PromptTemplate,
  PromptContext,
  PromptConfig,
  TemplateSource,
} from './types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir } from '../utils/paths.js';

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

interface BuiltinTemplateDef {
  name: string;
  description: string;
  content: string;
  variables: string[];
}

const BUILTIN_TEMPLATES: Record<string, BuiltinTemplateDef> = {
  'main.system': {
    name: '主 Agent 系统提示',
    description: 'CLI 主模式下的系统提示词',
    content: `你是 RouteDev，一个专业、严谨的 AI 编程助手。

## 工作环境
- 语言：{{language}}
- 自主模式：{{autonomyMode}}

## 项目上下文
{{projectRules}}

## 项目记忆
{{projectMemory}}

## 协作上下文（多 Agent 模式）
{{blackboard}}

## 可用工具
{{availableTools}}

## 最近对话
{{conversationContext}}

请遵循以下原则：
1. 直接、简洁地回答问题
2. 涉及代码改动时，先解释思路，再动手
3. 危险操作前主动询问用户确认
4. 保持回复在合理长度内`,
    variables: ['language', 'autonomyMode', 'projectRules', 'projectMemory', 'blackboard', 'availableTools', 'conversationContext'],
  },

  'classifier.system': {
    name: '场景分类器提示',
    description: '把用户问题分类为 simple/medium/complex/reasoning',
    content: `你是任务复杂度分类器。分析用户输入并判断其复杂度。

输出 JSON：{ "tier": "simple"|"medium"|"complex"|"reasoning", "confidence": 0-1, "reasoning": "简短原因" }

判断标准：
- simple: 单行问答、参数查询、简单解释
- medium: 多步任务、需要代码搜索
- complex: 多文件改动、架构设计
- reasoning: 算法设计、复杂调试、数学证明`,
    variables: [],
  },

  'checkpoint.writer': {
    name: 'Checkpoint 写入器提示',
    description: '生成结构化的检查点摘要',
    content: `基于以下对话历史，生成结构化的检查点。

输出格式（JSON）：
{
  "summary": "对话主题摘要",
  "keyDecisions": ["决策1", "决策2"],
  "modifiedFiles": ["文件1", "文件2"],
  "nextSteps": ["后续步骤"]
}

要求：
- 简洁（每项 ≤ 50 字）
- 保留重要的技术决策
- 不要丢失修改过的文件路径

{{projectRules}}`,
    variables: ['projectRules'],
  },

  'goal.parser': {
    name: '目标分解器提示',
    description: '把用户的高层目标分解为可执行步骤',
    content: `把以下目标分解为可执行的步骤列表：

目标：{{goal}}

输出 JSON：
{
  "steps": [
    { "id": 1, "description": "第一步描述" },
    ...
  ],
  "verificationCriteria": "完成标准"
}`,
    variables: ['goal'],
  },

  'worker.coder': {
    name: 'Coder Worker 提示',
    description: '编码 Worker 的角色提示',
    content: `你是一个编码专家。专注于编写高质量、可维护的代码。

## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

## 已知信息
{{projectFacts}}

要求：
- 遵循项目已有代码风格
- 编写测试用例
- 完成后给出修改文件清单`,
    variables: ['task', 'blackboard', 'projectFacts'],
  },

  'worker.tester': {
    name: 'Tester Worker 提示',
    description: '测试 Worker 的角色提示',
    content: `你是一个测试专家。专注于编写全面的测试用例。

## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

要求：
- 覆盖正常路径和边界情况
- 测试应可独立运行
- 使用项目已有的测试框架`,
    variables: ['task', 'blackboard'],
  },
};

/** 默认模板版本号 */
const DEFAULT_VERSION = '1.0.0';

export class PromptTemplateManager {
  private config: PromptConfig;
  private builtinTemplates = new Map<string, BuiltinTemplateDef>();
  private cache = new Map<string, { template: PromptTemplate; loadedAt: number }>();
  private projectPath?: string;

  constructor(config?: Partial<PromptConfig>) {
    this.config = {
      projectOverrides: true,
      cacheTtlSeconds: 0,
      ...config,
    };
    for (const [id, def] of Object.entries(BUILTIN_TEMPLATES)) {
      this.builtinTemplates.set(id, def);
    }
  }

  /** 设置项目路径（启用项目级覆盖） */
  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }

  /** 获取模板（三级优先级查找） */
  async getTemplate(id: string): Promise<PromptTemplate> {
    // 检查缓存
    if (this.config.cacheTtlSeconds > 0) {
      const cached = this.cache.get(id);
      if (cached && Date.now() - cached.loadedAt < this.config.cacheTtlSeconds * 1000) {
        return cached.template;
      }
    }

    let template: PromptTemplate | null = null;

    // 1. 项目级覆盖
    if (this.config.projectOverrides && this.projectPath) {
      template = await this.loadFromFile(id, 'project', this.getProjectTemplatesDir());
    }

    // 2. 用户自定义
    if (!template) {
      const userDir = this.config.userTemplatesDir ?? path.join(getAppDataDir(), 'prompts');
      template = await this.loadFromFile(id, 'user', userDir);
    }

    // 3. 内置默认
    if (!template) {
      const builtin = this.builtinTemplates.get(id);
      if (builtin) {
        template = {
          id,
          name: builtin.name,
          description: builtin.description,
          content: builtin.content,
          source: 'builtin',
          version: DEFAULT_VERSION,
          variables: builtin.variables,
        };
      }
    }

    if (!template) {
      throw new Error(`Template not found: ${id}`);
    }

    if (this.config.cacheTtlSeconds > 0) {
      this.cache.set(id, { template, loadedAt: Date.now() });
    }

    return template;
  }

  /** 渲染模板（替换变量） */
  async render(id: string, context: PromptContext): Promise<string> {
    const template = await this.getTemplate(id);
    return this.applyVariables(template.content, context);
  }

  /** 应用变量替换 */
  applyVariables(content: string, context: PromptContext): string {
    return content.replace(VARIABLE_PATTERN, (match, varName: string) => {
      const value = context[varName];
      if (value === undefined) {
        logger.warn('Prompt template: missing variable', { variable: varName });
        return '';
      }
      return value;
    });
  }

  /** 列出所有可用模板 ID */
  listTemplateIds(): string[] {
    return Array.from(this.builtinTemplates.keys());
  }

  /** 列出所有内置模板的元数据 */
  listBuiltinTemplates(): Array<{ id: string; name: string; description: string; variables: string[] }> {
    return Array.from(this.builtinTemplates.entries()).map(([id, def]) => ({
      id,
      name: def.name,
      description: def.description,
      variables: def.variables,
    }));
  }

  /** 检查模板是否存在 */
  async hasTemplate(id: string): Promise<boolean> {
    try {
      await this.getTemplate(id);
      return true;
    } catch {
      return false;
    }
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  // ===== 内部方法 =====

  private getProjectTemplatesDir(): string {
    return path.join(this.projectPath!, '.routedev', 'prompts');
  }

  private async loadFromFile(
    id: string,
    source: TemplateSource,
    dir: string,
  ): Promise<PromptTemplate | null> {
    const filePath = path.join(dir, `${id}.md`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // 从内容中提取变量名
      const variables = this.extractVariables(content);

      return {
        id,
        name: this.parseMetadata(content, 'name') ?? id,
        description: this.parseMetadata(content, 'description') ?? '',
        content: this.stripMetadata(content),
        source,
        version: this.parseMetadata(content, 'version') ?? DEFAULT_VERSION,
        variables,
      };
    } catch {
      return null;
    }
  }

  /** 提取所有 {{variable}} 变量名 */
  private extractVariables(content: string): string[] {
    const matches = new Set<string>();
    const regex = /\{\{(\w+)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      matches.add(match[1]);
    }
    return [...matches];
  }

  /** 解析 frontmatter 中的元数据（YAML-like 简易格式） */
  private parseMetadata(content: string, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'm'));
    return match ? match[1] : null;
  }

  /** 去除 frontmatter 部分 */
  private stripMetadata(content: string): string {
    const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
    return match ? content.slice(match[0].length) : content;
  }
}