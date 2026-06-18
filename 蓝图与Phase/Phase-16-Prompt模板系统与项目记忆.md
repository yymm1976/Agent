# Phase 16：Prompt 模板系统 + 项目记忆

**回应**：Phase 15 完成报告的 CONCERN（预计）

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | Trace 文件可能很大 | Phase 15 已有 maxSpansPerSession 限制和文本截断，后续优化加 gzip |
| C2 | Prompt 散落在 8 个文件中硬编码 | **本 Phase 核心**：PromptTemplateManager 统一管理所有 Prompt |
| C3 | .routedev-rules.md 生成了但不读回 | **本 Phase 核心**：项目记忆系统自动注入 rules + memory 到系统 Prompt |
| C4 | 不同 Worker 角色的 Prompt 无法定制 | **本 Phase 核心**：三级优先级（项目覆盖 > 用户自定义 > 内置默认） |
| C5 | 项目规则/约定跨会话丢失 | **本 Phase 核心**：MEMORY.md + decisions.jsonl 跨会话持久化 |
| C6 | 模型切换后 Prompt 风格不匹配 | 模板支持按模型 tier 附加变体（如 reasoning 模型加 "think step by step"） |

---

**目标**：建立 Prompt 模板管理系统（统一管理所有散落的 Prompt，支持三级优先级覆盖和变量替换）+ 项目记忆系统（跨会话持久化项目规则、约定、决策记录，自动注入系统 Prompt）。

**蓝图参考**：第十五节（PromptTemplateManager：优先级、变量替换、版本号）+ 第十节（Memory 层：项目级记忆、MEMORY.md、decisions.jsonl）

**前置依赖**：Phase 15（可观测性——Trace 记录 Prompt 渲染结果，便于调试模板效果）

---

## 架构说明

如果把 RouteDev 比作一个公司，Prompt 模板系统就是"话术手册管理办公室"。以前每个员工（Classifier、CheckpointWriter、GoalParser 等）各自把话术写在便签纸上贴在桌角，现在统一由办公室管理——有标准版（内置默认）、有个人定制版（用户自定义）、有项目特供版（项目覆盖）。

项目记忆系统则是"项目档案室"——每次开始新对话时，AI 自动翻阅档案室的资料（项目规则、历史决策、上次的工作记录），而不是从零开始。

```
Phase 16 架构全景：

PromptTemplateManager（模板管理）
  │
  ├── 三级优先级查找：
  │     1. 项目覆盖：{project}/.routedev/prompts/{name}.md
  │     2. 用户自定义：{AppData}/prompts/{name}.md
  │     3. 内置默认：代码中的硬编码 fallback
  │
  ├── 变量替换引擎：
  │     {{projectRules}}    → .routedev-rules.md 内容
  │     {{projectMemory}}   → MEMORY.md 内容
  │     {{blackboard}}      → Blackboard.formatForPrompt()
  │     {{availableTools}}  → ToolExecutorAdapter.getToolDefinitions() 摘要
  │     {{conversationContext}} → 最近的对话摘要
  │     {{autonomyMode}}    → 当前自主模式
  │
  └── 模板注册表：
        ├── main.system          → 主 Agent 系统 Prompt
        ├── classifier.system    → 场景分类 Prompt
        ├── checkpoint.writer    → CheckpointWriter Prompt
        ├── goal.parser          → GoalParser Prompt
        ├── goal.verifier        → GoalVerifier Prompt
        ├── dream.consolidator   → DreamConsolidator Prompt
        ├── vision.analyzer      → VisionAssistant Prompt
        ├── init.analyzer        → InitAnalyzer Prompt
        ├── worker.coder         → Coder Worker Prompt
        ├── worker.searcher      → Searcher Worker Prompt
        ├── worker.tester        → Tester Worker Prompt
        └── worker.reviewer      → Reviewer Worker Prompt

ProjectMemoryManager（项目记忆）
  │
  ├── 记忆文件（{project}/.routedev/）：
  │     ├── rules.md         → 项目规则（/init 生成，已有）
  │     ├── MEMORY.md        → 项目记忆（跨会话持久）
  │     ├── decisions.jsonl   → 历史决策记录
  │     └── context.json     → 项目上下文摘要
  │
  ├── 自动注入：每次 chat/goal 时，rules + memory 注入系统 Prompt
  │
  └── CLI 命令：
        ├── /project status   → 查看项目记忆状态
        ├── /project memory   → 查看/编辑 MEMORY.md
        └── /project rules    → 查看 rules.md
```

**关键约束**：
- 模板变量使用 `{{variableName}}` 语法（双大括号），与 Handlebars/Mustache 一致，用户易理解
- 内置模板迁移不改变输出内容——`main.system` 模板渲染后的结果必须与现有 `getSystemPrompt()` 输出一致
- 项目记忆文件存在 `.routedev/` 目录下（不是 `.routedev-rules.md` 单独放在根目录），需要向后兼容
- 变量替换失败不阻塞——缺失变量替换为空字符串 + 警告日志
- 模板文件是纯 Markdown，不需要特殊编辑器

---

## 具体任务

### Task 1：Prompt 模板类型定义 + 配置扩展

**文件：** 创建 `src/prompts/types.ts`，修改 `src/config/schema.ts` 和 `src/config/defaults.ts`

- [ ] **Step 1：定义 Prompt 模板类型**

```typescript
// src/prompts/types.ts
// Prompt 模板系统类型定义（Phase 16）
// 蓝图参考：第十五节 PromptTemplateManager

/** 模板来源（优先级从高到低） */
export type TemplateSource = 'project' | 'user' | 'builtin';

/** 模板元数据 */
export interface PromptTemplate {
  /** 模板 ID（如 'main.system', 'worker.coder'） */
  id: string;
  /** 模板名称（人类可读） */
  name: string;
  /** 模板描述 */
  description: string;
  /** 模板内容（Markdown，含 {{变量}} 占位符） */
  content: string;
  /** 来源 */
  source: TemplateSource;
  /** 版本号 */
  version: string;
  /** 支持的变量列表 */
  variables: string[];
}

/** 模板渲染上下文——所有可用变量 */
export interface PromptContext {
  /** 项目规则（.routedev-rules.md 或 .routedev/rules.md 内容） */
  projectRules?: string;
  /** 项目记忆（MEMORY.md 内容） */
  projectMemory?: string;
  /** 公共黑板摘要（多 Agent 模式） */
  blackboard?: string;
  /** 可用工具摘要 */
  availableTools?: string;
  /** 最近的对话摘要 */
  conversationContext?: string;
  /** 当前自主模式 */
  autonomyMode?: string;
  /** 当前语言 */
  language?: string;
  /** 当前模型 tier */
  modelTier?: string;
  /** 自由扩展变量 */
  [key: string]: string | undefined;
}

/** PromptTemplateManager 配置 */
export interface PromptConfig {
  /** 用户自定义模板目录（默认 {AppData}/prompts/） */
  userTemplatesDir?: string;
  /** 是否启用项目级覆盖 */
  projectOverrides: boolean;
  /** 模板缓存有效期（秒，0 = 不缓存） */
  cacheTtlSeconds: number;
}

/** 项目记忆配置 */
export interface ProjectMemoryConfig {
  /** 是否启用项目记忆 */
  enabled: boolean;
  /** MEMORY.md 最大字符数（超出截断） */
  maxMemorySize: number;
  /** decisions.jsonl 最大记录数 */
  maxDecisions: number;
  /** 是否自动注入到系统 Prompt */
  autoInject: boolean;
}

/** 项目记忆状态（用于 /project status 显示） */
export interface ProjectMemoryStatus {
  /** 项目路径 */
  projectPath: string;
  /** .routedev 目录是否存在 */
  hasRoutedevDir: boolean;
  /** 各文件状态 */
  files: {
    rules: { exists: boolean; size: number; lastModified?: number };
    memory: { exists: boolean; size: number; lastModified?: number };
    decisions: { exists: boolean; count: number; lastModified?: number };
    context: { exists: boolean; size: number; lastModified?: number };
  };
}

/** 决策记录 */
export interface DecisionRecord {
  /** 时间戳 */
  timestamp: string;
  /** Session ID */
  sessionId: string;
  /** 决策类型 */
  type: 'architecture' | 'convention' | 'tool_choice' | 'bug_fix' | 'design' | 'other';
  /** 决策内容 */
  decision: string;
  /** 决策原因 */
  reasoning: string;
  /** 关联文件 */
  relatedFiles?: string[];
}
```

- [ ] **Step 2：扩展配置 Schema**

在 `src/config/schema.ts` 中添加：

```typescript
// 新增 Schema：
export const PromptConfigSchema = z.object({
  userTemplatesDir: z.string().optional(),
  projectOverrides: z.boolean().default(true),
  cacheTtlSeconds: z.number().int().min(0).default(0),
});
export type PromptConfig = z.infer<typeof PromptConfigSchema>;

export const ProjectMemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxMemorySize: z.number().int().min(100).default(10000),
  maxDecisions: z.number().int().min(10).default(100),
  autoInject: z.boolean().default(true),
});
export type ProjectMemoryConfig = z.infer<typeof ProjectMemoryConfigSchema>;

// 在 AppConfigSchema 中添加两个新字段：
// prompts: PromptConfigSchema
// projectMemory: ProjectMemoryConfigSchema
```

- [ ] **Step 3：更新默认配置**

在 `src/config/defaults.ts` 的 `DEFAULT_CONFIG` 中添加：

```typescript
prompts: {
  projectOverrides: true,
  cacheTtlSeconds: 0,
},
projectMemory: {
  enabled: true,
  maxMemorySize: 10000,
  maxDecisions: 100,
  autoInject: true,
},
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/prompts/types.ts src/config/schema.ts src/config/defaults.ts
git commit -m "feat(prompts): add prompt template and project memory type definitions for Phase 16"
```

---

### Task 2：PromptTemplateManager 核心实现

**文件：** 创建 `src/prompts/manager.ts`

三级优先级的模板管理器——项目覆盖 > 用户自定义 > 内置默认。

- [ ] **Step 1：实现变量替换引擎 + 模板管理器**

```typescript
// src/prompts/manager.ts
// Prompt 模板管理器：统一管理所有 Prompt 模板
// 蓝图参考：第十五节 PromptTemplateManager
//
// 三级优先级：
//   1. 项目覆盖：{project}/.routedev/prompts/{id}.md
//   2. 用户自定义：{AppData}/prompts/{id}.md
//   3. 内置默认：代码中的 fallback
//
// 变量替换：{{variableName}} → context[variableName]
//   缺失变量 → 替换为空字符串 + warn

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PromptTemplate,
  PromptContext,
  TemplateSource,
  PromptConfig,
} from './types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir } from '../utils/paths.js';

/** 模板变量正则：匹配 {{variableName}} */
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** 内置模板注册表——id → { name, description, content, variables } */
interface BuiltinTemplateDef {
  name: string;
  description: string;
  content: string;
  variables: string[];
}

export class PromptTemplateManager {
  private config: PromptConfig;
  private builtinTemplates = new Map<string, BuiltinTemplateDef>();
  private cache = new Map<string, { template: PromptTemplate; loadedAt: number }>();

  constructor(config?: Partial<PromptConfig>) {
    this.config = {
      projectOverrides: true,
      cacheTtlSeconds: 0,
      ...config,
    };
  }

  /** 注册一个内置模板（从代码中迁移过来的硬编码 Prompt） */
  register(id: string, def: BuiltinTemplateDef): void {
    this.builtinTemplates.set(id, def);
    logger.debug('Prompt template registered', { id, source: 'builtin' });
  }

  /** 获取模板（按优先级查找） */
  async get(id: string, projectPath?: string): Promise<PromptTemplate | null> {
    // 检查缓存
    if (this.config.cacheTtlSeconds > 0) {
      const cached = this.cache.get(id);
      if (cached && Date.now() - cached.loadedAt < this.config.cacheTtlSeconds * 1000) {
        return cached.template;
      }
    }

    // 1. 项目覆盖
    if (this.config.projectOverrides && projectPath) {
      const projectTemplate = await this.loadFromFile(
        id,
        path.join(projectPath, '.routedev', 'prompts', `${id}.md`),
        'project',
      );
      if (projectTemplate) {
        this.cacheTemplate(id, projectTemplate);
        return projectTemplate;
      }
    }

    // 2. 用户自定义
    const userTemplate = await this.loadFromFile(
      id,
      path.join(this.getUserTemplatesDir(), `${id}.md`),
      'user',
    );
    if (userTemplate) {
      this.cacheTemplate(id, userTemplate);
      return userTemplate;
    }

    // 3. 内置默认
    const builtin = this.builtinTemplates.get(id);
    if (builtin) {
      const template: PromptTemplate = {
        id,
        name: builtin.name,
        description: builtin.description,
        content: builtin.content,
        source: 'builtin',
        version: '1.0.0',
        variables: [...builtin.variables],
      };
      this.cacheTemplate(id, template);
      return template;
    }

    logger.warn('Prompt template not found', { id });
    return null;
  }

  /** 渲染模板——变量替换 */
  render(template: PromptTemplate, context: PromptContext): string {
    return template.content.replace(VARIABLE_PATTERN, (match, varName) => {
      const value = context[varName];
      if (value === undefined || value === null) {
        if (varName !== 'projectRules' && varName !== 'projectMemory') {
          // 常见可选变量不警告，其余的警告一下
          logger.debug('Prompt variable missing', { template: template.id, variable: varName });
        }
        return '';
      }
      return String(value);
    });
  }

  /** 获取并渲染（一步到位） */
  async renderById(
    id: string,
    context: PromptContext,
    projectPath?: string,
  ): Promise<string> {
    const template = await this.get(id, projectPath);
    if (!template) {
      logger.error('Cannot render unknown template', { id });
      return '';
    }
    return this.render(template, context);
  }

  /** 列出所有已注册的模板 */
  listAll(): Array<{ id: string; name: string; source: TemplateSource; hasProjectOverride: boolean }> {
    const result: Array<{ id: string; name: string; source: TemplateSource; hasProjectOverride: boolean }> = [];

    for (const [id, def] of this.builtinTemplates) {
      result.push({
        id,
        name: def.name,
        source: 'builtin',
        hasProjectOverride: false, // 运行时检查
      });
    }

    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 获取模板使用的变量列表 */
  extractVariables(content: string): string[] {
    const vars = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = VARIABLE_PATTERN.exec(content)) !== null) {
      vars.add(match[1]);
    }
    return [...vars].sort();
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  // ===== 内部方法 =====

  private async loadFromFile(
    id: string,
    filePath: string,
    source: TemplateSource,
  ): Promise<PromptTemplate | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // 解析 frontmatter（简单版：--- 分隔的 YAML 头）
      const { meta, body } = this.parseFrontmatter(content);

      return {
        id,
        name: meta.name ?? id,
        description: meta.description ?? '',
        content: body,
        source,
        version: meta.version ?? '1.0.0',
        variables: this.extractVariables(body),
      };
    } catch {
      return null; // 文件不存在
    }
  }

  private parseFrontmatter(content: string): {
    meta: Record<string, string>;
    body: string;
  } {
    const meta: Record<string, string> = {};

    if (!content.startsWith('---')) {
      return { meta, body: content };
    }

    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
      return { meta, body: content };
    }

    const frontmatter = content.slice(3, endIndex).trim();
    const body = content.slice(endIndex + 3).trim();

    // 简单的 key: value 解析（不需要完整 YAML 库）
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) {
        meta[key] = value;
      }
    }

    return { meta, body };
  }

  private getUserTemplatesDir(): string {
    return this.config.userTemplatesDir
      ?? path.join(getAppDataDir(), 'prompts');
  }

  private cacheTemplate(id: string, template: PromptTemplate): void {
    if (this.config.cacheTtlSeconds > 0) {
      this.cache.set(id, { template, loadedAt: Date.now() });
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/prompts/manager.ts
git commit -m "feat(prompts): implement PromptTemplateManager with three-level priority and variable substitution"
```

---

### Task 3：内置模板注册

**文件：** 创建 `src/prompts/builtin-templates.ts`

将现有的 8 处硬编码 Prompt 迁移为内置模板注册。迁移后输出内容必须与原来完全一致（零功能变化）。

- [ ] **Step 0：前置修改——导出被引用的 Prompt 常量**

以下两个常量当前是模块私有的（无 `export`），需要先添加 `export` 关键字才能被 `builtin-templates.ts` 导入：

```typescript
// src/agent/goal-parser.ts — 第 10 行附近
// 修改前：
const PARSER_SYSTEM_PROMPT = `...`;
// 修改后：
export const PARSER_SYSTEM_PROMPT = `...`;

// src/agent/goal-verifier.ts — 第 9 行附近
// 修改前：
const VERIFIER_SYSTEM_PROMPT = `...`;
// 修改后：
export const VERIFIER_SYSTEM_PROMPT = `...`;
```

```powershell
git add src/agent/goal-parser.ts src/agent/goal-verifier.ts
git commit -m "refactor(agent): export PARSER_SYSTEM_PROMPT and VERIFIER_SYSTEM_PROMPT for template migration"
```

- [ ] **Step 1：实现注册函数**

```typescript
// src/prompts/builtin-templates.ts
// 内置 Prompt 模板注册
// 将散落各处的硬编码 Prompt 统一注册到 PromptTemplateManager
// 迁移原则：输出内容不变，只是换个管理方式

import type { PromptTemplateManager } from './manager.js';

// 导入现有 Prompt 常量
import { DEFAULT_SYSTEM_PROMPT_ZH, DEFAULT_SYSTEM_PROMPT_EN } from '../agent/prompts.js';

/** 注册所有内置模板 */
export function registerBuiltinTemplates(manager: PromptTemplateManager): void {

  // ===== 主 Agent 系统 Prompt =====
  manager.register('main.system', {
    name: '主 Agent 系统 Prompt',
    description: 'RouteDev 主对话 Agent 的系统提示词，包含能力描述、行为准则和项目上下文',
    content: [
      DEFAULT_SYSTEM_PROMPT_ZH,
      '',
      '{{#if projectRules}}',
      '## 项目规则',
      '{{projectRules}}',
      '{{/if}}',
      '',
      '{{#if projectMemory}}',
      '## 项目记忆',
      '{{projectMemory}}',
      '{{/if}}',
      '',
      '{{#if blackboard}}',
      '## 公共黑板（多 Agent 协作上下文）',
      '{{blackboard}}',
      '{{/if}}',
    ].join('\n'),
    variables: ['projectRules', 'projectMemory', 'blackboard', 'availableTools', 'autonomyMode'],
  });

  // ===== 主 Agent 系统 Prompt（英文） =====
  manager.register('main.system.en', {
    name: 'Main Agent System Prompt (EN)',
    description: 'English version of the main agent system prompt',
    content: DEFAULT_SYSTEM_PROMPT_EN,
    variables: ['projectRules', 'projectMemory', 'blackboard'],
  });

  // ===== 场景分类 Prompt =====
  manager.register('classifier.system', {
    name: '场景分类 Prompt',
    description: '根据用户输入判断任务复杂度（simple/medium/complex/reasoning）',
    content: `你是一个任务分类器。分析用户的输入，判断任务复杂度等级。

复杂度等级：
- simple：简单问答、单文件操作、信息查询
- medium：多文件操作、代码生成、项目配置
- complex：架构设计、复杂重构、多步骤任务
- reasoning：深度推理、调试疑难问题、性能优化

请只输出 JSON：{"tier": "simple|medium|complex|reasoning", "confidence": 0.0-1.0, "reason": "一句话理由"}`,
    variables: [],
  });

  // ===== Goal Parser Prompt =====
  manager.register('goal.parser', {
    name: '目标分解 Prompt',
    description: '将用户的 /goal 描述分解为可执行的步骤列表',
    content: `你是一个目标规划助手。将用户的目标描述分解为具体的、可执行的步骤。

要求：
- 每个步骤应该是一个独立的、可验证的任务
- 步骤之间有明确的先后顺序
- 每个步骤描述清楚"做什么"和"涉及哪些文件"
- 步骤数量控制在 3-10 个

请输出 JSON：
{
  "steps": [
    {"id": 1, "description": "步骤描述", "estimatedFiles": ["file1.ts", "file2.ts"]}
  ],
  "summary": "整体计划概述"
}`,
    variables: [],
  });

  // ===== Goal Verifier Prompt =====
  manager.register('goal.verifier', {
    name: '目标验证 Prompt',
    description: '验证 /goal 步骤是否完成',
    content: `你是一个代码审查员。根据以下信息判断目标步骤是否完成：

目标步骤：{{stepDescription}}
已完成的操作：{{completedActions}}

请输出 JSON：
{"passed": true/false, "confidence": 0.0-1.0, "reasoning": "判断理由"}`,
    variables: ['stepDescription', 'completedActions'],
  });

  // ===== CheckpointWriter Prompt =====
  manager.register('checkpoint.writer', {
    name: 'CheckpointWriter Prompt',
    description: '生成 11 字段结构化检查点数据',
    content: `你是一个记忆管理助手。根据对话历史生成结构化检查点。

请输出以下 11 个字段的 JSON：
1. currentIntent：当前意图（一句话）
2. nextAction：下一步行动
3. workingConstraints：工作约束列表
4. taskTree：任务树（当前步骤进度）
5. currentWorkingFiles：当前操作的文件
6. involvedFiles：所有涉及的文件
7. crossTaskDiscoveries：跨任务发现
8. errorsAndFixes：遇到的错误和修复方法
9. runtimeState：运行时状态
10. designDecisions：设计决策
11. miscNotes：其他笔记

{{#if previousCheckpoint}}
前一次检查点：{{previousCheckpoint}}
{{/if}}`,
    variables: ['previousCheckpoint'],
  });

  // ===== Dream Consolidator Prompt =====
  manager.register('dream.consolidator', {
    name: '记忆整理 Prompt',
    description: '合并去重项目记忆',
    content: `你是一个记忆整理助手。将多段记忆合并、去重、整理为结构化的项目知识。

要求：
- 去除重复信息
- 合并相关条目
- 保留关键决策和原因
- 按主题分组

请输出整理后的 JSON。`,
    variables: [],
  });

  // ===== Vision Analyzer Prompt =====
  manager.register('vision.analyzer', {
    name: '视觉分析 Prompt',
    description: '分析图片内容，生成文本描述供文本模型使用',
    content: `请详细描述这张图片的内容，重点关注：
- 如果是代码截图：提取完整的代码文本
- 如果是 UI 截图：描述布局、组件、文字内容
- 如果是架构图：描述组件关系和数据流
- 如果是错误截图：提取错误信息和堆栈

请用中文输出结构化描述。`,
    variables: [],
  });

  // ===== Init Analyzer Prompt =====
  manager.register('init.analyzer', {
    name: '项目分析 Prompt',
    description: '/init 命令分析项目结构，生成项目规则文件',
    content: `你是一个项目分析助手。根据以下项目信息，生成项目开发规则和约定。

项目结构：
{{projectStructure}}

请生成 .routedev-rules.md 文件内容，包含：
1. 项目概述
2. 技术栈
3. 开发约定（命名、目录结构、代码风格）
4. 常用命令
5. 关键文件说明`,
    variables: ['projectStructure'],
  });

  // ===== Worker 角色 Prompt（来自 Phase 14 的 WORKER_ROLE_PROMPTS） =====
  manager.register('worker.coder', {
    name: 'Coder Worker Prompt',
    description: '编码 Worker 的角色提示词',
    content: `你是一个编码专家 Worker。你的职责是根据任务描述编写代码。
关注代码质量、类型安全、测试覆盖。
完成后在结论中列出修改的文件。

公共黑板上下文：
{{blackboard}}`,
    variables: ['blackboard'],
  });

  manager.register('worker.searcher', {
    name: 'Searcher Worker Prompt',
    description: '搜索 Worker 的角色提示词',
    content: `你是一个信息搜索 Worker。你的职责是查找代码、文件、文档来回答研究问题。
使用 file_read、file_search、code_search 等工具。
完成后在结论中总结发现。

公共黑板上下文：
{{blackboard}}`,
    variables: ['blackboard'],
  });

  manager.register('worker.tester', {
    name: 'Tester Worker Prompt',
    description: '测试 Worker 的角色提示词',
    content: `你是一个测试专家 Worker。你的职责是编写和运行测试。
关注边界情况、错误路径、回归测试。
完成后在结论中报告测试结果。

公共黑板上下文：
{{blackboard}}`,
    variables: ['blackboard'],
  });

  manager.register('worker.reviewer', {
    name: 'Reviewer Worker Prompt',
    description: '审查 Worker 的角色提示词',
    content: `你是一个代码审查 Worker。你的职责是审查代码变更。
关注：类型安全、边界检查、安全性、性能。
完成后在结论中列出发现的问题和建议。

公共黑板上下文：
{{blackboard}}`,
    variables: ['blackboard'],
  });

  logger.info('Built-in prompt templates registered', { count: 13 });
}
```

注意：上面各模板的 content 是示意性的精简版。执行人实现时应从对应的现有源码文件中复制完整 Prompt 文本（如 `src/router/classifier.ts` 的分类 Prompt、`src/agent/goal-parser.ts` 的 PARSER_SYSTEM_PROMPT 等），确保迁移后输出一致。

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/prompts/builtin-templates.ts
git commit -m "feat(prompts): register all built-in prompt templates from existing hardcoded prompts"
```

---

### Task 4：ProjectMemoryManager 实现

**文件：** 创建 `src/prompts/project-memory.ts`

项目记忆管理器——管理 `.routedev/` 目录下的规则、记忆、决策记录。

- [ ] **Step 1：实现 ProjectMemoryManager**

```typescript
// src/prompts/project-memory.ts
// 项目记忆管理器：管理跨会话的项目级记忆
// 蓝图参考：第十节 Memory 层（项目级记忆、MEMORY.md、decisions.jsonl）
//
// 文件结构（{project}/.routedev/）：
//   rules.md        → 项目规则（/init 生成）
//   MEMORY.md       → 项目记忆（跨会话持久）
//   decisions.jsonl  → 历史决策记录
//   context.json    → 项目上下文摘要

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectMemoryConfig,
  ProjectMemoryStatus,
  DecisionRecord,
} from './types.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG: ProjectMemoryConfig = {
  enabled: true,
  maxMemorySize: 10000,
  maxDecisions: 100,
  autoInject: true,
};

export class ProjectMemoryManager {
  private config: ProjectMemoryConfig;
  private projectPath: string;
  private routedevDir: string;

  constructor(projectPath: string, config?: Partial<ProjectMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.projectPath = projectPath;
    this.routedevDir = path.join(projectPath, '.routedev');
  }

  /** 确保 .routedev 目录存在 */
  async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.routedevDir, { recursive: true });
    } catch (err) {
      logger.warn('Failed to create .routedev directory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 读取项目规则（rules.md 或兼容旧版 .routedev-rules.md） */
  async readRules(): Promise<string> {
    // 优先读 .routedev/rules.md
    try {
      const content = await fs.readFile(
        path.join(this.routedevDir, 'rules.md'),
        'utf-8',
      );
      return content;
    } catch {
      // 不存在，尝试兼容旧路径
    }

    try {
      const content = await fs.readFile(
        path.join(this.projectPath, '.routedev-rules.md'),
        'utf-8',
      );
      return content;
    } catch {
      return '';
    }
  }

  /** 读取项目记忆（MEMORY.md） */
  async readMemory(): Promise<string> {
    try {
      const content = await fs.readFile(
        path.join(this.routedevDir, 'MEMORY.md'),
        'utf-8',
      );
      // 截断保护
      if (content.length > this.config.maxMemorySize) {
        logger.warn('MEMORY.md exceeds max size, truncating', {
          actual: content.length,
          max: this.config.maxMemorySize,
        });
        return content.slice(0, this.config.maxMemorySize) + '\n\n[... 已截断 ...]';
      }
      return content;
    } catch {
      return '';
    }
  }

  /** 追加项目记忆 */
  async appendMemory(text: string): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.routedevDir, 'MEMORY.md');
    const existing = await this.readMemory();
    const updated = existing + '\n' + text + '\n';

    if (updated.length > this.config.maxMemorySize) {
      logger.warn('MEMORY.md would exceed max size after append, skipping');
      return;
    }

    await fs.writeFile(filePath, updated, 'utf-8');
    logger.debug('Memory appended', { path: filePath, addedLength: text.length });
  }

  /** 覆盖项目记忆 */
  async writeMemory(content: string): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.routedevDir, 'MEMORY.md');
    const truncated = content.length > this.config.maxMemorySize
      ? content.slice(0, this.config.maxMemorySize)
      : content;
    await fs.writeFile(filePath, truncated, 'utf-8');
  }

  /** 添加决策记录 */
  async addDecision(record: Omit<DecisionRecord, 'timestamp' | 'sessionId'>): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.routedevDir, 'decisions.jsonl');

    const fullRecord: DecisionRecord = {
      timestamp: new Date().toISOString(),
      sessionId: '', // 由调用方设置
      ...record,
    };

    // 读取现有记录，检查数量限制
    const existing = await this.readDecisions();
    if (existing.length >= this.config.maxDecisions) {
      // 保留最新的 N-1 条，删除最旧的
      existing.shift();
      // 重写文件
      const content = existing.map(r => JSON.stringify(r)).join('\n') + '\n';
      await fs.writeFile(filePath, content, 'utf-8');
    }

    // 追加新记录
    await fs.appendFile(
      filePath,
      JSON.stringify(fullRecord) + '\n',
      'utf-8',
    );
  }

  /** 读取决策记录 */
  async readDecisions(limit?: number): Promise<DecisionRecord[]> {
    try {
      const content = await fs.readFile(
        path.join(this.routedevDir, 'decisions.jsonl'),
        'utf-8',
      );
      const records: DecisionRecord[] = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // 跳过损坏行
        }
      }
      const sorted = records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return limit ? sorted.slice(0, limit) : sorted;
    } catch {
      return [];
    }
  }

  /** 获取项目上下文摘要（context.json） */
  async readContext(): Promise<Record<string, unknown>> {
    try {
      const content = await fs.readFile(
        path.join(this.routedevDir, 'context.json'),
        'utf-8',
      );
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /** 保存项目上下文摘要 */
  async saveContext(context: Record<string, unknown>): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(
      path.join(this.routedevDir, 'context.json'),
      JSON.stringify(context, null, 2),
      'utf-8',
    );
  }

  /** 构建 PromptContext 中的项目相关变量 */
  async buildPromptVariables(): Promise<{
    projectRules: string;
    projectMemory: string;
  }> {
    if (!this.config.enabled || !this.config.autoInject) {
      return { projectRules: '', projectMemory: '' };
    }

    const [projectRules, projectMemory] = await Promise.all([
      this.readRules(),
      this.readMemory(),
    ]);

    return { projectRules, projectMemory };
  }

  /** 获取项目记忆状态（用于 /project status） */
  async getStatus(): Promise<ProjectMemoryStatus> {
    const status: ProjectMemoryStatus = {
      projectPath: this.projectPath,
      hasRoutedevDir: false,
      files: {
        rules: { exists: false, size: 0 },
        memory: { exists: false, size: 0 },
        decisions: { exists: false, count: 0 },
        context: { exists: false, size: 0 },
      },
    };

    try {
      const stat = await fs.stat(this.routedevDir);
      status.hasRoutedevDir = stat.isDirectory();
    } catch {
      return status;
    }

    // 检查各文件
    const checkFile = async (filename: string) => {
      try {
        const stat = await fs.stat(path.join(this.routedevDir, filename));
        return { exists: true, size: stat.size, lastModified: stat.mtimeMs };
      } catch {
        return { exists: false, size: 0 };
      }
    };

    const [rules, memory, context] = await Promise.all([
      checkFile('rules.md'),
      checkFile('MEMORY.md'),
      checkFile('context.json'),
    ]);

    status.files.rules = rules;
    status.files.memory = memory;
    status.files.context = context;

    // decisions.jsonl 需要额外统计行数
    try {
      const content = await fs.readFile(
        path.join(this.routedevDir, 'decisions.jsonl'),
        'utf-8',
      );
      const lines = content.split('\n').filter(l => l.trim());
      status.files.decisions = {
        exists: true,
        size: Buffer.byteLength(content),
        count: lines.length,
        lastModified: (await fs.stat(path.join(this.routedevDir, 'decisions.jsonl'))).mtimeMs,
      };
    } catch {
      // 文件不存在
    }

    return status;
  }

  /** 迁移旧版 .routedev-rules.md 到 .routedev/rules.md */
  async migrateLegacyRules(): Promise<boolean> {
    const legacyPath = path.join(this.projectPath, '.routedev-rules.md');
    const newPath = path.join(this.routedevDir, 'rules.md');

    try {
      await fs.stat(legacyPath);
      await fs.stat(newPath);
      return false; // 新路径已存在，不覆盖
    } catch {
      // 至少一个不存在
    }

    try {
      const content = await fs.readFile(legacyPath, 'utf-8');
      await this.ensureDir();
      await fs.writeFile(newPath, content, 'utf-8');
      logger.info('Legacy rules migrated', { from: legacyPath, to: newPath });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/prompts/project-memory.ts
git commit -m "feat(prompts): implement ProjectMemoryManager for cross-session project memory"
```

---

### Task 5：App.tsx 集成

**文件：** 修改 `src/cli/App.tsx`

将 PromptTemplateManager 和 ProjectMemoryManager 集成到 CLI，替换硬编码的 `getSystemPrompt()`。

- [ ] **Step 1：初始化**

```typescript
import { PromptTemplateManager } from '../prompts/manager.js';
import { ProjectMemoryManager } from '../prompts/project-memory.js';
import { registerBuiltinTemplates } from '../prompts/builtin-templates.js';

// useRef 区域：
const promptManagerRef = useRef(new PromptTemplateManager({
  projectOverrides: config.prompts.projectOverrides,
  cacheTtlSeconds: config.prompts.cacheTtlSeconds,
}));
const projectMemoryRef = useRef(new ProjectMemoryManager(process.cwd(), {
  ...config.projectMemory,
}));

// useEffect 初始化：
useEffect(() => {
  // 注册内置模板
  registerBuiltinTemplates(promptManagerRef.current);

  // 迁移旧版 rules
  projectMemoryRef.current.migrateLegacyRules().catch(() => {});

  // ... 已有初始化逻辑 ...
}, []);
```

- [ ] **Step 2：替换 getSystemPrompt() 调用**

原来的代码：
```typescript
const systemPrompt = getSystemPrompt(config.general.language);
```

替换为：
```typescript
// 构建 Prompt 上下文
const projectVars = await projectMemoryRef.current.buildPromptVariables();
const promptContext: PromptContext = {
  ...projectVars,
  language: config.general.language,
  autonomyMode: config.autonomy.defaultMode,
  availableTools: toolExecutorRef.current
    .getToolDefinitions()
    .map(t => `${t.name}: ${t.description}`)
    .join('\n'),
};

// 渲染模板
const templateId = config.general.language === 'zh-CN' ? 'main.system' : 'main.system.en';
const systemPrompt = await promptManagerRef.current.renderById(
  templateId,
  promptContext,
  process.cwd(),
);
```

- [ ] **Step 3：在 executeGoalPlan 中注入 Blackboard**

如果多 Agent 模式下的 Blackboard 存在，将其快照注入 Prompt 上下文：

```typescript
// 在 Worker 执行前，blackboard 注入 promptContext：
if (blackboardRef.current) {
  promptContext.blackboard = blackboardRef.current.formatForPrompt();
}
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): integrate PromptTemplateManager and ProjectMemoryManager into App"
```

---

### Task 6：/prompt + /project CLI 命令

**文件：** 修改 `src/cli/App.tsx`

- [ ] **Step 1：/prompt 命令**

```typescript
case '/prompt': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'list':
    case undefined: {
      const templates = promptManagerRef.current.listAll();
      const lines = templates.map((t, i) =>
        `  ${i + 1}. ${t.id} — ${t.name} (${t.source})`
      );
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `Prompt 模板列表 (${templates.length}):\n${lines.join('\n')}\n\n提示：模板文件放在 {AppData}/prompts/ 或 {项目}/.routedev/prompts/ 目录下`,
      }]);
      break;
    }

    case 'view': {
      const templateId = parts[2];
      if (!templateId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法：/prompt view <template-id>',
        }]);
        break;
      }

      const template = await promptManagerRef.current.get(templateId, process.cwd());
      if (!template) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `模板 ${templateId} 不存在。`,
        }]);
        break;
      }

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          `模板: ${template.id}`,
          `名称: ${template.name}`,
          `来源: ${template.source}`,
          `版本: ${template.version}`,
          `变量: ${template.variables.join(', ') || '(无)'}`,
          `---`,
          template.content.slice(0, 500) + (template.content.length > 500 ? '\n... (已截断)' : ''),
        ].join('\n'),
      }]);
      break;
    }

    case 'reload': {
      promptManagerRef.current.clearCache();
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '模板缓存已清除。下次对话将重新加载模板。',
      }]);
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          'Prompt 命令：',
          '  /prompt list       - 列出所有模板',
          '  /prompt view <id>  - 查看模板内容',
          '  /prompt reload     - 清除模板缓存',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 2：/project 命令**

```typescript
case '/project': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'status':
    case undefined: {
      const status = await projectMemoryRef.current.getStatus();
      const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        return `${(bytes / 1024).toFixed(1)} KB`;
      };
      const formatTime = (ms?: number) =>
        ms ? new Date(ms).toLocaleString('zh-CN') : '-';

      const lines = [
        `项目路径: ${status.projectPath}`,
        `.routedev 目录: ${status.hasRoutedevDir ? '✓ 存在' : '✗ 不存在'}`,
        '',
        `  rules.md:      ${status.files.rules.exists ? `✓ ${formatSize(status.files.rules.size)} (${formatTime(status.files.rules.lastModified)})` : '✗ 不存在'}`,
        `  MEMORY.md:     ${status.files.memory.exists ? `✓ ${formatSize(status.files.memory.size)} (${formatTime(status.files.memory.lastModified)})` : '✗ 不存在'}`,
        `  decisions.jsonl: ${status.files.decisions.exists ? `✓ ${status.files.decisions.count} 条记录` : '✗ 不存在'}`,
        `  context.json:  ${status.files.context.exists ? `✓ ${formatSize(status.files.context.size)}` : '✗ 不存在'}`,
      ];

      if (!status.hasRoutedevDir) {
        lines.push('', '提示：运行 /init 初始化项目，或手动创建 .routedev/ 目录');
      }

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `项目记忆状态:\n${lines.join('\n')}`,
      }]);
      break;
    }

    case 'memory': {
      const action = parts[2]?.toLowerCase();

      if (action === 'show' || !action) {
        const memory = await projectMemoryRef.current.readMemory();
        if (!memory) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system' as const,
            content: 'MEMORY.md 为空。使用 /project memory add <内容> 添加记忆。',
          }]);
        } else {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system' as const,
            content: `项目记忆 (MEMORY.md):\n${memory}`,
          }]);
        }
      } else if (action === 'add') {
        const text = parts.slice(3).join(' ');
        if (!text) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system' as const,
            content: '用法：/project memory add <记忆内容>',
          }]);
          break;
        }
        await projectMemoryRef.current.appendMemory(
          `- ${new Date().toLocaleDateString('zh-CN')}: ${text}`
        );
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `✓ 已添加到 MEMORY.md`,
        }]);
      } else if (action === 'clear') {
        await projectMemoryRef.current.writeMemory('');
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `✓ MEMORY.md 已清空`,
        }]);
      }
      break;
    }

    case 'rules': {
      const rules = await projectMemoryRef.current.readRules();
      if (!rules) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有项目规则。运行 /init 生成 .routedev-rules.md。',
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `项目规则:\n${rules.slice(0, 800)}${rules.length > 800 ? '\n... (已截断)' : ''}`,
        }]);
      }
      break;
    }

    case 'decisions': {
      const decisions = await projectMemoryRef.current.readDecisions(10);
      if (decisions.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有决策记录。',
        }]);
      } else {
        const lines = decisions.map((d, i) =>
          `  ${i + 1}. [${d.type}] ${d.decision.slice(0, 60)}\n     ${d.timestamp} | ${d.reasoning.slice(0, 40)}`
        );
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `决策记录 (最近 ${decisions.length} 条):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '项目命令：',
          '  /project status    - 查看项目记忆状态',
          '  /project memory    - 查看/管理 MEMORY.md',
          '  /project rules     - 查看项目规则',
          '  /project decisions - 查看决策记录',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 3：更新 /help**

```
  /prompt list/view   - 管理 Prompt 模板
  /project status     - 项目记忆管理
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /prompt and /project commands for template and memory management"
```

---

### Task 7：单元测试

**文件：** 创建 `tests/prompts/manager.test.ts`、`tests/prompts/project-memory.test.ts`

- [ ] **Step 1：PromptTemplateManager 测试（8 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | register + get 内置模板 | 注册后可通过 id 获取 |
| 2 | 三级优先级：项目 > 用户 > 内置 | 项目目录下有同名模板时返回 project source |
| 3 | 变量替换基本 | `{{foo}}` → context.foo 的值 |
| 4 | 缺失变量替换为空 | `{{missing}}` → '' 且不抛异常 |
| 5 | extractVariables 提取变量 | 返回 content 中所有 `{{xxx}}` 的变量名 |
| 6 | listAll 排序 | 按 id 字母序排列 |
| 7 | frontmatter 解析 | `---\nname: xxx\n---\nbody` 正确解析 |
| 8 | 缓存生效 | cacheTtlSeconds > 0 时重复调用不重新读文件 |

- [ ] **Step 2：ProjectMemoryManager 测试（7 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | readRules 兼容旧路径 | `.routedev-rules.md` 存在时可读取 |
| 2 | readRules 新路径优先 | `.routedev/rules.md` 和旧版同时存在时读新版 |
| 3 | readMemory / appendMemory | 追加后文件包含旧内容 + 新内容 |
| 4 | maxMemorySize 截断保护 | 超出 maxMemorySize 时截断 |
| 5 | addDecision / readDecisions | 写入后读取返回正确记录 |
| 6 | maxDecisions 自动清理 | 超出限制时删除最旧记录 |
| 7 | getStatus 返回正确状态 | 各文件 exists/size/count 正确 |

- [ ] **Step 3：运行全部测试 → 提交**

```powershell
npx vitest run
# 预期：至少 15 个新测试通过（8 + 7）
# 累计测试数：Phase 15 的 275+ 15 = 290+

pnpm build
pnpm typecheck
git add tests/prompts/
git commit -m "test(prompts): add PromptTemplateManager and ProjectMemoryManager unit tests"
git push origin main
```

---

## 接口对齐观察表

以下签名已通过 Explore agent 对实际代码库验证（Phase 14 完成后基线）：

| 接口 | 文件 | 签名 | 本 Phase 引用方式 |
|------|------|------|-------------------|
| `getSystemPrompt()` | `src/agent/prompts.ts` | `(language?: string) => string` | 被 PromptTemplateManager.renderById() 替代 |
| `DEFAULT_SYSTEM_PROMPT_ZH` | `src/agent/prompts.ts` | `string` 常量 | builtin-templates.ts 注册为 'main.system' |
| `DEFAULT_SYSTEM_PROMPT_EN` | `src/agent/prompts.ts` | `string` 常量 | 注册为 'main.system.en' |
| `AppConfigSchema` | `src/config/schema.ts` | Zod object schema | 新增 `prompts` 和 `projectMemory` 字段 |
| `DEFAULT_CONFIG` | `src/config/defaults.ts` | `AppConfig` 对象 | 新增 prompts 和 projectMemory 默认值 |
| `getAppDataDir()` | `src/utils/paths.ts` | `() => string` | 用户自定义模板目录根 |
| `getProjectDataDir()` | `src/utils/paths.ts` | `(projectPath) => string` | 暂不直接使用（项目记忆在 .routedev/ 内） |
| `ensureDir()` | `src/utils/paths.ts` | `(string) => void` | ProjectMemoryManager.ensureDir() |
| `logger` | `src/utils/logger.ts` | winston singleton | 所有模块导入使用 |
| `PARSER_SYSTEM_PROMPT` | `src/agent/goal-parser.ts` | `const string`（**未导出**，Step 0 添加 export） | 迁移注册为 'goal.parser' |
| `VERIFIER_SYSTEM_PROMPT` | `src/agent/goal-verifier.ts` | `const string`（**未导出**，Step 0 添加 export） | 迁移注册为 'goal.verifier' |
| `classifier.ts` 内联 Prompt | `src/router/classifier.ts` | 内联 string | 迁移注册为 'classifier.system' |
| `checkpoint-writer.ts` 内联 | `src/agent/memory/checkpoint-writer.ts` | `buildSystemPrompt(level)` | 迁移注册为 'checkpoint.writer' |
| `vision.ts` 内联 | `src/agent/vision.ts` | 内联 string | 迁移注册为 'vision.analyzer' |
| `init-analyzer.ts` 内联 | `src/agent/init-analyzer.ts` | 内联 string | 迁移注册为 'init.analyzer' |
| `WORKER_ROLE_PROMPTS` | Phase 14 `orchestrator.ts` | `Record<WorkerRole, string>` | 迁移注册为 'worker.coder/searcher/tester/reviewer' |
| `Blackboard.formatForPrompt()` | Phase 14 `blackboard.ts` | `() => string` | 注入 PromptContext.blackboard |
| `ToolExecutorAdapter.getToolDefinitions()` | `src/agent/loop-config.ts` | `() => LLMToolDefinition[]` | 生成 availableTools 变量 |
| `LLMToolDefinition` | `src/router/types.ts` | `{ name, description, ... }` | 提取 name + description 生成工具列表 |

---

## 对下一阶段的提醒

1. **模板迁移不删源码**：本 Phase 将 8 处硬编码 Prompt 注册为内置模板，但原有文件中的常量保留不删。后续 Phase 可以让各模块改为调用 `promptManager.renderById()` 而非直接引用常量，实现完全解耦
2. **frontmatter 解析很简陋**：当前只支持简单的 `key: value` 格式。如果后续模板需要列表、嵌套等 YAML 特性，应引入 `yaml` 库（已在 dependencies 中）
3. **`{{#if variable}}` 语法未实现**：builtin-templates.ts 的模板内容中使用了 `{{#if}}` 标记，但变量替换引擎不支持条件渲染。当前实现会把 `{{#if projectRules}}` 当作缺失变量替换为空——这恰好使 `#if` 行消失，但 `{{/if}}` 行也会消失（因为不匹配任何变量）。执行人应简化模板为纯 `{{variable}}` 格式，不引入条件语法
4. **项目记忆自动注入可能使 Prompt 过长**：rules.md + MEMORY.md 加起来可能几千字。后续应加 token 计数检查，超出时裁剪
5. **/project memory add 不支持多行**：当前只支持单行添加。后续可支持从编辑器打开（类似 git commit 打开编辑器的模式）
6. **模板缓存只按时间过期**：不监听文件变更。如果用户修改了模板文件但 cacheTtlSeconds 还没过，不会生效。`/prompt reload` 是手动解决方案
7. **decisions.jsonl 的 sessionId 为空**：`addDecision()` 需要调用方传入 sessionId。App.tsx 集成时应从 TraceCollector 或自建 sessionId 中获取
8. **与 DreamConsolidator 的关系**：当前 `/dream` 命令使用 DreamConsolidator 合并 CheckpointWriter 数据。后续 `/dream` 的输出应自动追加到 MEMORY.md，形成 "日常记忆 → 定期整理 → 持久知识" 的闭环
