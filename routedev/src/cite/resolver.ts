// src/cite/resolver.ts
// CiteResolver：后端引用解析器
//
// 设计目标（蓝图 1.8）：
//   1. 检查每个引用是否被安全策略阻挡（敏感文件路径模式匹配）
//   2. message 引用：校验 targetVersion 与 targetBranchId，处理 outdated/unreachable/deleted
//   3. file/folder 引用：生成 read_file / list_directory 的 preflight 工具调用
//   4. url 引用：生成 web_fetch 的 preflight 工具调用
//   5. skill/macro 引用：读取 SKILL.md/MACRO.md 提取 system prompt
//   6. text 引用：收集原文，截断到 maxTextCiteLength
//   7. tool 引用：生成 allowedTools 白名单
//   8. 组装 injectedContext 字符串
//
// 关键约束：
//   - preflight 工具调用不真正执行，只生成调用描述
//   - 敏感文件检查简化为路径模式匹配（minimatch 风格）
//   - skill/macro 通过依赖注入的 provider 读取，便于测试

import { SkillMdParser } from '../skills/skill-md-parser.js';
import { logger } from '../utils/logger.js';
import type {
  CiteConfig,
  CiteItem,
  CiteResolution,
  MessageNodeInfo,
  PreflightToolCall,
  SessionContext,
} from './types.js';

// ============================================================
// 默认配置与敏感模式
// ============================================================

/** 默认配置（与 config/schema.ts 中 CiteConfigSchema 一致） */
export const DEFAULT_CITE_CONFIG: CiteConfig = {
  enabled: true,
  maxTags: 10,
  maxTextCiteLength: 2000,
  maxPreflightTokens: 8000,
  autoRunPreflight: true,
};

/** 默认敏感文件路径模式（与 config/defaults.ts permissionProfile.filesystem 一致） */
export const DEFAULT_SENSITIVE_PATTERNS: string[] = [
  '**/*.env',
  '**/.env*',
  '**/credentials.json',
  '**/credentials.yaml',
  '**/credentials.yml',
  '**/*.key',
  '**/*.pem',
  '**/*.p12',
  '**/*.pfx',
  '**/.ssh/**',
  '**/.aws/credentials',
  '**/.gcp/**',
  '**/secrets/**',
  '**/.secret',
];

// ============================================================
// 依赖注入接口
// ============================================================

/**
 * CiteResolver 依赖注入
 *
 * 所有外部读取（Skill/Macro 文件、消息节点、文本截断等）通过该接口注入
 * 便于单元测试与跨环境运行
 */
export interface CiteResolverDeps {
  /**
   * 读取 Skill/Macro 的 Markdown 内容（含 frontmatter）
   * @param name Skill/Macro 名称
   * @param kind 'skill' | 'macro'，默认 'skill'
   * @returns Markdown 内容；不存在时返回 null
   */
  readSkillOrMacro?: (name: string, kind?: 'skill' | 'macro') => Promise<string | null>;

  /**
   * 查询消息节点信息（用于 message 引用校验）
   * @param nodeId 节点 ID
   * @returns 节点信息；不存在时返回 null
   */
  messageNodeProvider?: (nodeId: string) => Promise<MessageNodeInfo | null>;
}

// ============================================================
// CiteResolver
// ============================================================

/**
 * 引用解析器
 *
 * 使用方式：
 *   const resolver = new CiteResolver({ config, deps });
 *   const resolution = await resolver.resolve({ items, autoRunPreflight, sessionContext });
 */
export class CiteResolver {
  private readonly config: CiteConfig;
  private readonly deps: CiteResolverDeps;

  constructor(
    options: { config?: Partial<CiteConfig>; deps?: CiteResolverDeps } = {},
  ) {
    this.config = { ...DEFAULT_CITE_CONFIG, ...(options.config ?? {}) };
    this.deps = options.deps ?? {};
  }

  // ============================================================
  // 入口
  // ============================================================

  /**
   * 解析引用列表
   *
   * 流程：
   *   1. 初始化 resolution（injectedContext / preflightTools / skillPrompts / macroPrompts / blocked）
   *   2. 遍历每个 item，按 type 分发到对应处理器
   *   3. 处理器返回贡献的上下文片段（已格式化的字符串）+ preflight 工具调用
   *   4. 拼接所有上下文片段为 injectedContext
   *
   * @returns CiteResolution（包含 injectedContext、preflight、prompts、allowedTools、blocked）
   */
  async resolve(options: {
    items: CiteItem[];
    autoRunPreflight?: boolean;
    sessionContext?: SessionContext;
  }): Promise<CiteResolution> {
    const { items, sessionContext = {} } = options;
    const autoRunPreflight = options.autoRunPreflight ?? this.config.autoRunPreflight;

    const preflightTools: PreflightToolCall[] = [];
    const skillPrompts: string[] = [];
    const macroPrompts: string[] = [];
    const blocked: CiteItem[] = [];
    const contextChunks: string[] = [];
    const allowedToolsSet = new Set<string>();
    let hasToolCite = false;

    // 敏感模式：优先使用 sessionContext 提供的，否则用默认
    const sensitivePatterns = sessionContext.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;

    for (const item of items) {
      // 步骤 1：敏感文件检查（仅对 file/folder 类型）
      if (
        (item.type === 'file' || item.type === 'folder') &&
        this.isSensitivePath(item.source, sensitivePatterns)
      ) {
        const blockedItem: CiteItem = {
          ...item,
          blocked: true,
          blockedReason: `路径匹配敏感文件模式：${item.source}`,
          status: 'ok',
        };
        blocked.push(blockedItem);
        contextChunks.push(this.formatBlockedContext(blockedItem));
        continue;
      }

      // 步骤 2：按类型分发
      const contribution = await this.resolveItem(item, sessionContext, autoRunPreflight);

      // 收集 preflight
      if (contribution.preflight) {
        preflightTools.push(...contribution.preflight);
      }
      // 收集 skill prompts
      if (contribution.skillPrompt) {
        skillPrompts.push(contribution.skillPrompt);
      }
      // 收集 macro prompts
      if (contribution.macroPrompt) {
        macroPrompts.push(contribution.macroPrompt);
      }
      // 收集 allowedTools
      if (contribution.allowedTool) {
        allowedToolsSet.add(contribution.allowedTool);
        hasToolCite = true;
      }
      // 收集 blocked
      if (contribution.blocked) {
        blocked.push(contribution.blocked);
        if (contribution.context) contextChunks.push(contribution.context);
        continue;
      }
      // 收集上下文片段
      if (contribution.context) {
        contextChunks.push(contribution.context);
      }
    }

    // 组装 injectedContext
    const injectedContext = this.assembleInjectedContext(contextChunks);

    const resolution: CiteResolution = {
      injectedContext,
      preflightTools,
      skillPrompts,
      macroPrompts,
      blocked,
    };
    if (hasToolCite) {
      resolution.allowedTools = Array.from(allowedToolsSet);
    }
    return resolution;
  }

  // ============================================================
  // 单个引用解析
  // ============================================================

  /**
   * 解析单个引用项
   *
   * @returns 该引用对 resolution 的贡献（上下文片段、preflight、prompts 等）
   */
  private async resolveItem(
    item: CiteItem,
    sessionContext: SessionContext,
    _autoRunPreflight: boolean,
  ): Promise<ItemContribution> {
    switch (item.type) {
      case 'file':
        return this.resolveFileCite(item);
      case 'folder':
        return this.resolveFolderCite(item);
      case 'text':
        return this.resolveTextCite(item);
      case 'skill':
        return this.resolveSkillCite(item);
      case 'macro':
        return this.resolveMacroCite(item);
      case 'url':
        return this.resolveUrlCite(item);
      case 'tool':
        return this.resolveToolCite(item);
      case 'message':
        return this.resolveMessageCite(item, sessionContext);
      default:
        logger.warn(`CiteResolver: 未知引用类型 ${(item as CiteItem).type}`, { itemId: item.id });
        return {};
    }
  }

  // ============================================================
  // file 引用：生成 read_file preflight
  // ============================================================

  private resolveFileCite(item: CiteItem): ItemContribution {
    const args: Record<string, unknown> = { path: item.source };
    if (item.range) {
      args.startLine = item.range.start;
      args.endLine = item.range.end;
    }
    const preflight: PreflightToolCall = {
      name: 'read_file',
      args,
      citeItemId: item.id,
    };
    return {
      preflight: [preflight],
      context: this.formatFileContext(item),
    };
  }

  // ============================================================
  // folder 引用：生成 list_directory preflight
  // ============================================================

  private resolveFolderCite(item: CiteItem): ItemContribution {
    const preflight: PreflightToolCall = {
      name: 'list_directory',
      args: { path: item.source },
      citeItemId: item.id,
    };
    return {
      preflight: [preflight],
      context: this.formatFolderContext(item),
    };
  }

  // ============================================================
  // text 引用：截断到 maxTextCiteLength
  // ============================================================

  private resolveTextCite(item: CiteItem): ItemContribution {
    const raw = item.content ?? item.label ?? '';
    const truncated = this.truncateText(raw, this.config.maxTextCiteLength);
    return {
      context: this.formatTextContext(item, truncated, raw.length > truncated.length),
    };
  }

  // ============================================================
  // skill 引用：读取 SKILL.md 提取 system prompt
  // ============================================================

  private async resolveSkillCite(item: CiteItem): Promise<ItemContribution> {
    if (!this.deps.readSkillOrMacro) {
      return { context: this.formatSkillFallbackContext(item) };
    }
    try {
      const md = await this.deps.readSkillOrMacro(item.source, 'skill');
      if (!md) {
        return { context: this.formatSkillNotFoundContext(item) };
      }
      const parsed = SkillMdParser.parse(md);
      const prompt = parsed.content || '';
      return {
        skillPrompt: prompt,
        context: this.formatSkillContext(item, parsed.metadata.name, prompt),
      };
    } catch (err) {
      logger.warn('CiteResolver: skill 引用解析失败', {
        itemId: item.id,
        source: item.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return { context: this.formatSkillNotFoundContext(item) };
    }
  }

  // ============================================================
  // macro 引用：读取 MACRO.md 提取 system prompt
  // ============================================================

  private async resolveMacroCite(item: CiteItem): Promise<ItemContribution> {
    if (!this.deps.readSkillOrMacro) {
      return { context: this.formatMacroFallbackContext(item) };
    }
    try {
      const md = await this.deps.readSkillOrMacro(item.source, 'macro');
      if (!md) {
        return { context: this.formatMacroNotFoundContext(item) };
      }
      const parsed = SkillMdParser.parse(md);
      const prompt = parsed.content || '';
      return {
        macroPrompt: prompt,
        context: this.formatMacroContext(item, parsed.metadata.name, prompt),
      };
    } catch (err) {
      logger.warn('CiteResolver: macro 引用解析失败', {
        itemId: item.id,
        source: item.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return { context: this.formatMacroNotFoundContext(item) };
    }
  }

  // ============================================================
  // url 引用：生成 web_fetch preflight
  // ============================================================

  private resolveUrlCite(item: CiteItem): ItemContribution {
    const preflight: PreflightToolCall = {
      name: 'web_fetch',
      args: { url: item.source },
      citeItemId: item.id,
    };
    return {
      preflight: [preflight],
      context: this.formatUrlContext(item),
    };
  }

  // ============================================================
  // tool 引用：生成 allowedTools 白名单
  // ============================================================

  private resolveToolCite(item: CiteItem): ItemContribution {
    return {
      allowedTool: item.source,
      context: this.formatToolContext(item),
    };
  }

  // ============================================================
  // message 引用：校验版本与分支，处理 outdated/unreachable/deleted
  // ============================================================

  private async resolveMessageCite(
    item: CiteItem,
    sessionContext: SessionContext,
  ): Promise<ItemContribution> {
    if (!this.deps.messageNodeProvider) {
      return { context: this.formatMessageNoProviderContext(item) };
    }

    let node: MessageNodeInfo | null;
    try {
      node = await this.deps.messageNodeProvider(item.source);
    } catch (err) {
      logger.warn('CiteResolver: message 节点查询失败', {
        itemId: item.id,
        source: item.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return { context: this.formatMessageNotFoundContext(item) };
    }

    // 节点不存在或已删除
    if (!node) {
      const blockedItem: CiteItem = {
        ...item,
        status: 'deleted',
        blocked: true,
        blockedReason: '目标消息节点不存在',
      };
      return {
        blocked: blockedItem,
        context: this.formatMessageDeletedContext(item),
      };
    }
    if (node.deleted) {
      const blockedItem: CiteItem = {
        ...item,
        status: 'deleted',
        blocked: true,
        blockedReason: '目标消息已被删除',
      };
      return {
        blocked: blockedItem,
        context: this.formatMessageDeletedContext(item),
      };
    }

    // 分支隔离检查
    if (
      item.targetBranchId &&
      sessionContext.currentBranchId &&
      item.targetBranchId !== sessionContext.currentBranchId
    ) {
      const blockedItem: CiteItem = {
        ...item,
        status: 'unreachable',
        blocked: true,
        blockedReason: `目标消息在分支 ${item.targetBranchId}，当前分支 ${sessionContext.currentBranchId}`,
      };
      return {
        blocked: blockedItem,
        context: this.formatMessageUnreachableContext(item),
      };
    }

    // 版本校验：targetVersion 与当前不一致则标记 outdated
    if (
      typeof item.targetVersion === 'number' &&
      typeof node.version === 'number' &&
      item.targetVersion !== node.version
    ) {
      const blockedItem: CiteItem = {
        ...item,
        status: 'outdated',
        blocked: true,
        blockedReason: `目标消息已被编辑（引用版本 ${item.targetVersion}，当前版本 ${node.version}）`,
      };
      return {
        blocked: blockedItem,
        context: this.formatMessageOutdatedContext(item, node),
      };
    }

    // 正常情况：注入消息内容
    return {
      context: this.formatMessageOkContext(item, node),
    };
  }

  // ============================================================
  // 上下文片段格式化
  // ============================================================

  private formatBlockedContext(item: CiteItem): string {
    return `🚫 阻挡 [${item.type}] ${item.label}\n   原因：${item.blockedReason ?? '路径匹配敏感文件模式'}`;
  }

  private formatFileContext(item: CiteItem): string {
    const range = item.range ? ` (行 ${item.range.start}-${item.range.end})` : '';
    return `📎 文件 [${item.source}]${range}\n   <将自动调用 read_file 读取内容>`;
  }

  private formatFolderContext(item: CiteItem): string {
    return `📁 文件夹 [${item.source}]\n   <将自动调用 list_directory 列出文件树>`;
  }

  private formatTextContext(item: CiteItem, truncated: string, wasTruncated: boolean): string {
    const note = wasTruncated ? `\n   <已截断到 ${this.config.maxTextCiteLength} 字符>` : '';
    return `💬 用户引用的文本:\n"${truncated}"${note}`;
  }

  private formatSkillContext(item: CiteItem, name: string, prompt: string): string {
    const preview = this.truncateText(prompt, 200);
    return `⚡ 技能 [${name}] 已激活\n   来源：${item.source}\n   预览：${preview}`;
  }

  private formatSkillFallbackContext(item: CiteItem): string {
    return `⚡ 技能 [${item.source}] 已引用（未提供 skill 内容读取器，跳过 prompt 提取）`;
  }

  private formatSkillNotFoundContext(item: CiteItem): string {
    return `⚡ 技能 [${item.source}] 未找到（可能未安装或已删除）`;
  }

  private formatMacroContext(item: CiteItem, name: string, prompt: string): string {
    const preview = this.truncateText(prompt, 200);
    return `📋 宏 [${name}] 已激活\n   来源：${item.source}\n   预览：${preview}`;
  }

  private formatMacroFallbackContext(item: CiteItem): string {
    return `📋 宏 [${item.source}] 已引用（未提供 macro 内容读取器，跳过 prompt 提取）`;
  }

  private formatMacroNotFoundContext(item: CiteItem): string {
    return `📋 宏 [${item.source}] 未找到（可能未安装或已删除）`;
  }

  private formatUrlContext(item: CiteItem): string {
    return `🔗 链接 [${item.source}]\n   <将自动调用 web_fetch 抓取网页摘要>`;
  }

  private formatToolContext(item: CiteItem): string {
    return `🔧 工具 [${item.source}] 已加入白名单\n   本次请求仅允许使用该工具`;
  }

  private formatMessageOkContext(item: CiteItem, node: MessageNodeInfo): string {
    const content = this.truncateText(node.content, this.config.maxTextCiteLength);
    return `📨 引用消息 [节点 ${item.source}]\n   版本：${node.version}，分支：${node.branchId}\n   内容："${content}"`;
  }

  private formatMessageOutdatedContext(item: CiteItem, node: MessageNodeInfo): string {
    return `📨 引用消息 [节点 ${item.source}] 已过期\n   引用版本：${item.targetVersion}，当前版本：${node.version}\n   提示：该消息已被编辑，请用户决定是否更新引用`;
  }

  private formatMessageUnreachableContext(item: CiteItem): string {
    return `📨 引用消息 [节点 ${item.source}] 分支不可见\n   目标分支：${item.targetBranchId}，当前分支不同\n   提示：切换到目标分支或更新引用`;
  }

  private formatMessageDeletedContext(item: CiteItem): string {
    return `📨 引用消息 [节点 ${item.source}] 已删除\n   引用已失效，不再注入上下文`;
  }

  private formatMessageNoProviderContext(item: CiteItem): string {
    return `📨 引用消息 [节点 ${item.source}]（未提供节点查询器，跳过版本校验）`;
  }

  private formatMessageNotFoundContext(item: CiteItem): string {
    return `📨 引用消息 [节点 ${item.source}] 未找到`;
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 组装最终 injectedContext
   *
   * 格式：
   *   ---
   *   引用上下文:
   *   <chunk1>
   *
   *   <chunk2>
   *   ...
   */
  private assembleInjectedContext(chunks: string[]): string {
    if (chunks.length === 0) return '';
    const body = chunks.join('\n\n');
    return `---\n引用上下文:\n${body}`;
  }

  /** 截断文本到指定长度，超出时追加省略号 */
  private truncateText(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)) + '…';
  }

  /**
   * 敏感文件路径模式匹配
   *
   * 简化实现：支持 * / ** 通配符
   *   - ** 匹配任意多级目录
   *   - * 匹配除路径分隔符外的任意字符
   *
   * @param path 待检查的路径
   * @param patterns glob 模式数组
   */
  private isSensitivePath(path: string, patterns: string[]): boolean {
    if (!path || patterns.length === 0) return false;
    const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
    for (const pattern of patterns) {
      const regex = this.globToRegex(pattern);
      if (regex.test(normalizedPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 将 glob 模式转换为正则表达式（简化版，支持 * / ** / ?）
   *
   * 替换顺序很重要：使用占位符隔离后续插入的非捕获组与跨目录通配语法，
   * 避免 * → [^/]* 和 ? → [^/] 替换破坏已插入的 regex 语法
   * （否则插入的 . 或 ? 等元字符会被错误替换）。
   *
   * @param pattern glob 模式（支持 ** 多级目录、* 单层通配、? 单字符）
   */
  private globToRegex(pattern: string): RegExp {
    // 1. 规范化：反斜杠转正斜杠，小写化（路径匹配大小写不敏感）
    // 2. 转义正则特殊字符（注意：* 和 ? 不在此列，它们是 glob 通配符）
    let regexStr = pattern
      .replace(/\\/g, '/')
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // 3. 先处理 ? → [^/]（必须在插入 (?:...)? 之前完成，否则会破坏插入的 ? 语法）
    regexStr = regexStr.replace(/\?/g, '[^/]');
    // 4. **/ → 占位符 \x00（minimatch 语义：**/ 可匹配零层目录，故 .env 能命中 **/*.env）
    regexStr = regexStr.replace(/\*\*\//g, '\x00');
    // 5. 残留的 ** → 占位符 \x01（避免后续 * 替换破坏 .* 语法）
    regexStr = regexStr.replace(/\*\*/g, '\x01');
    // 6. * → [^/]*（匹配除路径分隔符外的任意字符）
    regexStr = regexStr.replace(/\*/g, '[^/]*');
    // 7. 还原占位符：\x00 → (?:.*/)?（零层或多层目录前缀）；\x01 → .*（跨目录匹配）
    regexStr = regexStr
      .replace(/\x00/g, '(?:.*/)?')
      .replace(/\x01/g, '.*');
    // 8. 锚定：(^|/) 允许从路径任意目录段开始匹配；$ 确保完整匹配到路径末尾
    return new RegExp(`(^|/)${regexStr}$`);
  }
}

// ============================================================
// 内部类型
// ============================================================

/** 单个引用解析后的贡献 */
interface ItemContribution {
  /** 注入到 injectedContext 的片段 */
  context?: string;
  /** preflight 工具调用 */
  preflight?: PreflightToolCall[];
  /** skill prompt */
  skillPrompt?: string;
  /** macro prompt */
  macroPrompt?: string;
  /** allowedTools 白名单中的工具名 */
  allowedTool?: string;
  /** 被阻挡的引用（message 失效 / 节点删除等） */
  blocked?: CiteItem;
}
