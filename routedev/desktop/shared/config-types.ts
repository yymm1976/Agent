// desktop/shared/config-types.ts
// G-026: 配置类型中转层
// 统一 desktop/ 层对 src/config/schema 的类型导入，避免 deep import 破坏模块边界
// desktop/ 下所有文件应从此文件导入配置类型，而非直接 import src/config/schema

// re-export 所有被 desktop/ 实际使用的类型（type-only）
export type {
  AppConfig,
  ProviderConfig,
  ModelConfig,
  RouterRule,
  SecurityConfig,
  MCPServerEntryConfig,
  PermissionProfile,
  FilesystemPermissionRule,
  ExecutionConfig,
  ApprovalLevel,
  ToolCategory,
  AutonomyMode,
  ConfigLayeringConfig,
  DelegationPolicyConfig,
  Phase52IntegrationConfig,
  Phase53IntegrationConfig,
  ResultSchemaConfig,
  ReviewerPolicyConfig,
  SandboxLevel,
  PacksConfig,
} from '../../src/config/schema.js';

// re-export 被 desktop/ 实际使用的常量（值）
export {
  AppConfigSchema,
} from '../../src/config/schema.js';
