// src/prompts/types.ts
// Prompt 模板系统类型定义（Phase 16）

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

/** 模板渲染上下文 */
export interface PromptContext {
  /** 项目规则（.routedev-rules.md） */
  projectRules?: string;
  /** 项目记忆（MEMORY.md 内容） */
  projectMemory?: string;
  /** 公共黑板摘要 */
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
  /** 自由扩展 */
  [key: string]: string | undefined;
}

/** PromptTemplateManager 配置 */
export interface PromptConfig {
  userTemplatesDir?: string;
  projectOverrides: boolean;
  cacheTtlSeconds: number;
}

/** 项目记忆配置 */
export interface ProjectMemoryConfig {
  enabled: boolean;
  maxMemorySize: number;
  maxDecisions: number;
  autoInject: boolean;
}

/** 项目记忆状态 */
export interface ProjectMemoryStatus {
  projectPath: string;
  hasRoutedevDir: boolean;
  files: {
    rules: { exists: boolean; size: number; lastModified?: number };
    memory: { exists: boolean; size: number; lastModified?: number };
    decisions: { exists: boolean; count: number; lastModified?: number };
    context: { exists: boolean; size: number; lastModified?: number };
  };
}

/** 决策记录 */
export interface DecisionRecord {
  timestamp: string;
  sessionId: string;
  type: 'architecture' | 'convention' | 'tool_choice' | 'bug_fix' | 'design' | 'other';
  decision: string;
  reasoning: string;
  relatedFiles?: string[];
}