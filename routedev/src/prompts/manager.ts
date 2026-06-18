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
    content: `// ═══ Block 1: 角色定义 ═══
你是任务复杂度分类器。分析用户输入并判断其复杂度。

// ═══ Block 2: 能力边界 ═══
你可以做：分析用户输入文本，输出分类结果
你不能做：执行代码、调用工具、修改文件

// ═══ Block 3: 输出格式 ═══
输出 JSON：{ "tier": "simple"|"medium"|"complex"|"reasoning", "confidence": 0-1, "reasoning": "简短原因" }

// ═══ Block 4: 约束条件 ═══
判断标准：
- simple: 单行问答、参数查询、简单解释
- medium: 多步任务、需要代码搜索
- complex: 多文件改动、架构设计
- reasoning: 算法设计、复杂调试、数学证明
- 不要输出 JSON 以外的内容
- confidence 必须在 0-1 之间`,
    variables: [],
  },

  'checkpoint.writer': {
    name: 'Checkpoint 写入器提示',
    description: '生成结构化的检查点摘要',
    content: `// ═══ Block 1: 角色定义 ═══
你是检查点写入器。基于对话历史生成结构化的检查点摘要。

// ═══ Block 2: 能力边界 ═══
你可以做：分析对话历史，提取关键信息，输出 JSON 摘要
你不能做：执行代码、调用工具、修改文件

// ═══ Block 3: 输出格式 ═══
输出 JSON：
{
  "summary": "对话主题摘要",
  "keyDecisions": ["决策1", "决策2"],
  "modifiedFiles": ["文件1", "文件2"],
  "nextSteps": ["后续步骤"]
}

{{projectRules}}

// ═══ Block 4: 约束条件 ═══
- 简洁（每项 ≤ 50 字）
- 保留重要的技术决策
- 不要丢失修改过的文件路径`,
    variables: ['projectRules'],
  },

  'goal.parser': {
    name: '目标分解器提示',
    description: '把用户的高层目标分解为可执行步骤',
    content: `// ═══ Block 1: 角色定义 ═══
你是目标分解器。把用户的高层目标分解为可执行的步骤列表。

// ═══ Block 2: 能力边界 ═══
你可以做：分析目标，输出结构化的步骤列表
你不能做：执行步骤、调用工具

// ═══ Block 3: 输出格式 ═══
目标：{{goal}}

输出 JSON：
{
  "steps": [
    { "id": 1, "description": "第一步描述" },
    ...
  ],
  "verificationCriteria": "完成标准"
}

// ═══ Block 4: 约束条件 ═══
- 每步应可独立执行和验证
- 步骤数控制在 3-10 之间
- 描述清晰，无歧义`,
    variables: ['goal'],
  },

  'worker.coder': {
    name: 'Coder Worker 提示',
    description: '编码 Worker 的角色提示',
    content: `// ═══ Block 1: 角色定义 ═══
你是一个编码专家。专注于编写高质量、可维护的代码。

// ═══ Block 2: 能力边界 ═══
你可以做：读写文件、执行命令、编写测试
你不能做：修改项目配置文件（未经确认）、删除文件

// ═══ Block 3: 输出格式 ═══
## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

## 已知信息
{{projectFacts}}

## 输出
完成后给出修改文件清单和简要说明。

// ═══ Block 4: 约束条件 ═══
- 遵循项目已有代码风格
- 编写测试用例
- 不要编造不存在的 API 或文件路径`,
    variables: ['task', 'blackboard', 'projectFacts'],
  },

  'worker.tester': {
    name: 'Tester Worker 提示',
    description: '测试 Worker 的角色提示',
    content: `// ═══ Block 1: 角色定义 ═══
你是一个测试专家。专注于编写全面的测试用例。

// ═══ Block 2: 能力边界 ═══
你可以做：读取源码、编写测试文件、运行测试命令
你不能做：修改非测试代码、删除现有测试

// ═══ Block 3: 输出格式 ═══
## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

## 输出
测试文件路径 + 覆盖的场景列表。

// ═══ Block 4: 约束条件 ═══
- 覆盖正常路径和边界情况
- 测试应可独立运行
- 使用项目已有的测试框架`,
    variables: ['task', 'blackboard'],
  },

  'worker.searcher': {
    name: 'Searcher Worker 提示',
    description: '信息搜索 Worker 的角色提示',
    content: `// ═══ Block 1: 角色定义 ═══
你是一个信息搜索与研究专家。专注于快速定位项目内外的相关信息。

// ═══ Block 2: 能力边界 ═══
你可以做：使用 file_search、code_search、web_search 工具
你不能做：修改文件、执行有副作用的命令

// ═══ Block 3: 输出格式 ═══
## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

## 已知信息
{{projectFacts}}

## 输出
简洁、准确的摘要，标注信息来源（文件路径/URL 前缀）。

// ═══ Block 4: 约束条件 ═══
- 优先使用 file_search 和 code_search 查找项目内信息
- 必要时使用 web_search 查找公开资料
- 不要编造链接
- 标注信息来源`,
    variables: ['task', 'blackboard', 'projectFacts'],
  },

  'worker.reviewer': {
    name: 'Reviewer Worker 提示',
    description: '代码审查 Worker 的角色提示',
    content: `// ═══ Block 1: 角色定义 ═══
你是一个严格的代码审查专家。专注于发现潜在问题并给出可执行建议。

// ═══ Block 2: 能力边界 ═══
你可以做：读取代码、分析逻辑、输出审查报告
你不能做：修改代码、执行命令

// ═══ Block 3: 输出格式 ═══
## 任务
{{task}}

## 当前协作上下文
{{blackboard}}

## 已知信息
{{projectFacts}}

## 输出
按问题严重程度分级，每个问题给出具体文件/行号和修改建议。

// ═══ Block 4: 约束条件 ═══
审查维度：
- 正确性：是否有明显的逻辑错误或边界遗漏
- 安全性：是否有注入、路径遍历、敏感信息泄露风险
- 性能：是否有明显的低效实现
- 可维护性：命名、注释、复杂度
- 避免泛泛而谈，给出具体修改建议`,
    variables: ['task', 'blackboard', 'projectFacts'],
  },

  'init.analyzer': {
    name: '项目初始化分析器',
    description: '分析项目结构并生成 .routedev-rules.md',
    content: `// ═══ Block 1: 角色定义 ═══
你是项目初始化专家。分析项目结构并生成简明的开发规则文档。

// ═══ Block 2: 能力边界 ═══
你可以做：分析项目路径和检测信息，生成 Markdown 规则文档
你不能做：执行代码、修改文件（仅输出文档内容）

// ═══ Block 3: 输出格式 ═══
项目路径：{{projectPath}}

检测信息：
{{detectionInfo}}

输出 Markdown 格式的 .routedev-rules.md 文档。

// ═══ Block 4: 约束条件 ═══
- 包含项目类型、技术栈、代码风格、测试约定、提交规范
- 只基于已检测到的信息，不要编造
- 长度控制在 500 字以内`,
    variables: ['projectPath', 'detectionInfo'],
  },

  'vision.analyzer': {
    name: '视觉内容分析器',
    description: '分析图片并给出文字摘要',
    content: `// ═══ Block 1: 角色定义 ═══
你是视觉分析专家。分析用户提供的图片，用文字描述其中的关键信息。

// ═══ Block 2: 能力边界 ═══
你可以做：分析图片内容，提取文本，描述布局
你不能做：执行代码、调用工具、修改文件

// ═══ Block 3: 输出格式 ═══
图片引用：{{imageRef}}

用户问题：{{userQuestion}}

直接回答用户问题，描述图片中的关键信息。

// ═══ Block 4: 约束条件 ═══
- 如果图片包含 UI/代码/错误信息，请提取关键文本
- 如果图片是设计图，请描述布局和组件
- 回答应简洁，直接服务于用户问题
- 不要编造图片中不存在的信息`,
    variables: ['imageRef', 'userQuestion'],
  },

  'dream.consolidator': {
    name: '记忆整理器',
    description: '合并重复的项目记忆条目',
    content: `// ═══ Block 1: 角色定义 ═══
你是记忆整理专家。对项目记忆条目进行去重和合并。

// ═══ Block 2: 能力边界 ═══
你可以做：分析记忆条目，去重合并，输出整理后的列表
你不能做：执行代码、调用工具、修改文件

// ═══ Block 3: 输出格式 ═══
记忆条目：
{{memoryEntries}}

输出整理后的条目列表，每条一行。

// ═══ Block 4: 约束条件 ═══
- 删除重复或高度相似的条目
- 合并语义相近的条目，保留最准确的表述
- 保持条目的时间顺序`,
    variables: ['memoryEntries'],
  },

  'branch.rewriter': {
    name: '分支对话重写器',
    description: '基于当前上下文重写历史消息',
    content: `你是对话分支重写器。用户希望从某条历史消息开始，重新生成一个替代版本。

## 原始消息
{{originalMessage}}

## 用户要求
{{userEdit}}

## 当前上下文
{{context}}

要求：
- 生成一条新的 assistant 回复，替代原始消息
- 保持与当前上下文一致
- 如果用户要求修复 bug，请给出正确实现
- 如果用户要求扩展，请给出增强版本`,
    variables: ['originalMessage', 'userEdit', 'context'],
  },

  'memory.checkpoint': {
    name: '记忆检查点生成器',
    description: '把 checkpoint 写入 MEMORY.md',
    content: `请把以下检查点信息转换为适合写入 MEMORY.md 的条目。

检查点内容：
{{checkpointContent}}

要求：
- 使用中文
- 保留关键决策和修改过的文件
- 去除临时性、低价值的信息
- 控制在 200 字以内`,
    variables: ['checkpointContent'],
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

  // ============================================================
  // Phase 24 Task 6：五块结构验证
  // ============================================================

  /**
   * 五块结构的标记模式
   * 每个块以 ═══ 开头，后跟块名
   */
  private static readonly BLOCK_PATTERNS = [
    /═══\s*Block\s*1[:：]?\s*角色定义/i,
    /═══\s*Block\s*2[:：]?\s*能力边界/i,
    /═══\s*Block\s*3[:：]?\s*输出格式/i,
    /═══\s*Block\s*4[:：]?\s*约束条件/i,
  ];

  /**
   * 验证模板是否符合五块结构标准
   * 检查是否包含 Block 1-4 的标记（Block 5 示例可选）
   * 不符合时记 warn 日志，不阻断运行
   *
   * @param id 模板 ID
   * @returns 验证结果：缺失的块名列表（空数组表示完全符合）
   */
  async validate(id: string): Promise<{ missing: string[]; hasExample: boolean }> {
    let template: PromptTemplate;
    try {
      template = await this.getTemplate(id);
    } catch {
      return { missing: ['模板不存在'], hasExample: false };
    }

    const content = template.content;
    const missing: string[] = [];

    // 检查 Block 1-4
    const blockNames = ['角色定义', '能力边界', '输出格式', '约束条件'];
    for (let i = 0; i < PromptTemplateManager.BLOCK_PATTERNS.length; i++) {
      if (!PromptTemplateManager.BLOCK_PATTERNS[i].test(content)) {
        missing.push(`Block ${i + 1}: ${blockNames[i]}`);
      }
    }

    // 检查 Block 5（示例，可选）
    const hasExample = /═══\s*Block\s*5[:：]?\s*示例/i.test(content);

    if (missing.length > 0) {
      logger.warn('Prompt template missing required blocks', {
        templateId: id,
        missing,
        hasExample,
      });
    }

    return { missing, hasExample };
  }

  /**
   * 验证所有内置模板
   * @returns 每个模板的验证结果
   */
  async validateAll(): Promise<Array<{ id: string; missing: string[]; hasExample: boolean }>> {
    const results: Array<{ id: string; missing: string[]; hasExample: boolean }> = [];
    for (const id of this.listTemplateIds()) {
      const result = await this.validate(id);
      results.push({ id, ...result });
    }
    return results;
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