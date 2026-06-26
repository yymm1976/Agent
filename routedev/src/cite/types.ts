// src/cite/types.ts
// 引用系统数据结构
//
// 设计目标：
//   1. 定义 8 种引用类型（file/folder/text/skill/tool/macro/url/message）
//   2. 提供 CiteItem（引用项）、CiteTag（UI 标签）、CiteResolution（解析结果）、CiteConfig（配置）
//   3. 前后端共用同一套类型，确保一致性与可序列化
//
// 来源：Phase 48 Task 1 蓝图

// ============================================================
// 基础类型
// ============================================================

/** 引用类型：8 种 */
export type CiteType = 'file' | 'folder' | 'text' | 'skill' | 'tool' | 'macro' | 'url' | 'message';

/** 引用当前状态：正常 / 过期 / 不可见 / 已删除 */
export type CiteStatus = 'ok' | 'outdated' | 'unreachable' | 'deleted';

/** 引用来源标注 */
export type CiteOrigin = 'user-select' | 'trigger' | 'drag' | 'paste' | 'imported';

// ============================================================
// 引用项
// ============================================================

/**
 * 引用项：用户在输入框引用的某个对象
 *
 * - file/folder 类型不存内容，由后端 CiteResolver 通过 read_file/list_directory 读取
 * - text/url/message 类型可在 content 字段中携带原文，供后端直接注入
 * - message 类型保存 targetVersion + targetBranchId，用于校验节点是否被编辑/分支隔离
 */
export interface CiteItem {
  /** 唯一 ID（前端生成，发送时透传给后端） */
  id: string;
  /** 引用类型 */
  type: CiteType;
  /** 来源标识：文件路径 / Skill 名 / 消息节点 ID / URL 等 */
  source: string;
  /** 标签上显示的摘要文本 */
  label: string;
  /** 引用的完整内容（text/url/message 类型可选；file/folder 不存） */
  content?: string;
  /** 行号范围（file/message/symbol 类型） */
  range?: { start: number; end: number };
  /** 消息引用专用：目标节点版本戳（应对节点编辑） */
  targetVersion?: number;
  /** 消息引用专用：目标节点所在分支 ID（应对分支隔离） */
  targetBranchId?: string;
  /** 引用当前状态 */
  status?: CiteStatus;
  /** 是否被安全策略阻挡 */
  blocked?: boolean;
  /** 阻挡原因 */
  blockedReason?: string;
  /** 引用生成时间（毫秒时间戳） */
  createdAt: number;
  /** 来源标注 */
  origin: CiteOrigin;
}

// ============================================================
// UI 标签数据
// ============================================================

/**
 * UI 标签数据：CiteManager.formatForUI 返回
 *
 * 标签胶囊样式：图标 + 名称 + 类型徽章 + × 删除
 */
export interface CiteTag {
  /** 对应 CiteItem.id */
  id: string;
  /** 引用类型 */
  type: CiteType;
  /** 截断后的显示文本 */
  label: string;
  /** 完整文本（悬浮显示，未截断时与 label 相同） */
  fullLabel?: string;
  /** 标签背景色（CSS 颜色值或类名） */
  color: string;
  /** 标签图标（emoji 或图标名） */
  icon: string;
  /** 引用当前状态（message 引用专用于显示过期徽章） */
  status?: CiteStatus;
  /** 是否被安全策略阻挡（用于显示红色 blocked 徽章） */
  blocked?: boolean;
  /** 是否可删除（始终为 true，预留扩展） */
  removable: boolean;
}

// ============================================================
// 解析结果
// ============================================================

/** Preflight 工具调用描述（不实际执行，仅生成调用规范） */
export interface PreflightToolCall {
  /** 工具名（如 read_file / list_directory / web_fetch） */
  name: string;
  /** 工具参数 */
  args: unknown;
  /** 关联的 CiteItem.id，便于回溯 */
  citeItemId: string;
}

/**
 * 引用解析结果：CiteResolver.resolve 返回
 *
 * injectedContext 注入到 user message 前；
 * preflightTools 由调用方按需自动执行；
 * skillPrompts / macroPrompts 追加到本次 system prompt；
 * allowedTools 作为本次请求的工具白名单（tool 引用触发）。
 */
export interface CiteResolution {
  /** 注入到 user message 前面的引用摘要（Markdown 字符串） */
  injectedContext: string;
  /** 需要自动调用的工具（read_file / list_directory / web_fetch 等） */
  preflightTools: PreflightToolCall[];
  /** 本次请求可用的 Skill 追加提示 */
  skillPrompts: string[];
  /** 本次请求可用的 Macro 追加提示 */
  macroPrompts: string[];
  /** 本次请求允许使用的工具白名单（Tool 引用触发） */
  allowedTools?: string[];
  /** 被安全策略阻挡的引用列表 */
  blocked: CiteItem[];
}

// ============================================================
// 配置
// ============================================================

/**
 * 引用系统配置
 *
 * 对应 config.cite 字段，控制启用状态、标签上限、文本截断、preflight token 预算等
 */
export interface CiteConfig {
  /** 是否启用引用系统 */
  enabled: boolean;
  /** 单次最多引用标签数（1-20） */
  maxTags: number;
  /** text 引用最大字符数（100-10000） */
  maxTextCiteLength: number;
  /** preflight 工具调用结果的 token 上限（1000-50000） */
  maxPreflightTokens: number;
  /** 是否自动执行 preflight 工具（关闭时仅生成调用描述，由用户确认） */
  autoRunPreflight: boolean;
}

// ============================================================
// 会话上下文（CiteResolver 使用）
// ============================================================

/**
 * 会话上下文：CiteResolver 解析时需要的运行时信息
 *
 * 该接口设计为可注入，便于单元测试与跨环境使用
 */
export interface SessionContext {
  /** 当前分支 ID（用于校验 message 引用是否在可见分支上） */
  currentBranchId?: string;
  /** 当前项目根目录（用于解析相对路径） */
  projectRoot?: string;
  /** 敏感文件路径模式（glob，命中即标记 blocked） */
  sensitivePatterns?: string[];
}

/**
 * 消息节点查询结果：CiteResolver 解析 message 引用时通过 messageNodeProvider 获取
 */
export interface MessageNodeInfo {
  /** 节点 ID */
  nodeId: string;
  /** 节点当前版本戳（每次编辑自增） */
  version: number;
  /** 节点所在分支 ID */
  branchId: string;
  /** 节点是否已被删除（软删除或归档） */
  deleted: boolean;
  /** 节点消息内容（用于注入到上下文） */
  content: string;
}
