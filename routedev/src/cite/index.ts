// src/cite/index.ts
// 引用系统统一导出
//
// 对外暴露：
//   - 类型：CiteType / CiteItem / CiteTag / CiteResolution / CiteConfig / SessionContext / MessageNodeInfo / PreflightToolCall
//   - 管理器：CiteManager + 工厂函数
//   - 解析器：CiteResolver + 依赖注入接口
//
// 来源：Phase 48 Task 1 蓝图 1.1-1.8

// ============================================================
// 类型
// ============================================================
export type {
  CiteType,
  CiteStatus,
  CiteOrigin,
  CiteItem,
  CiteTag,
  CiteResolution,
  CiteConfig,
  PreflightToolCall,
  SessionContext,
  MessageNodeInfo,
} from './types.js';

// ============================================================
// CiteManager
// ============================================================
export {
  CiteManager,
  CiteLimitExceededError,
  DuplicateCiteError,
  generateCiteId,
  createCiteItem,
  getTagStyle,
  getStatusBadge,
} from './manager.js';

// ============================================================
// CiteResolver
// ============================================================
export {
  CiteResolver,
  DEFAULT_CITE_CONFIG,
  DEFAULT_SENSITIVE_PATTERNS,
} from './resolver.js';
export type { CiteResolverDeps } from './resolver.js';
