// src/import/index.ts
// 外部生态导入统一导出（Phase 48 Task 2/3）
//
// 对外暴露：
//   - 工具名映射器：mapToolName / mapToolNames / validateSkillTools
//   - Anthropic Skills 加载器：AnthropicSkillsLoader + LoadedSkill/LoadResult 类型
//   - Claude Plugin 导入器：ClaudePluginImporter + 相关类型
//   - Codex Instructions 导入器：CodexInstructionImporter + 相关类型
//
// 来源：Phase 48 Task 2 蓝图 2.1-2.7、Task 3 蓝图 3.1-3.5

// ============================================================
// 工具名映射器
// ============================================================
export {
  mapToolName,
  mapToolNames,
  validateSkillTools,
  reverseMapToolName,
  getToolNameMap,
} from './tool-name-mapper.js';
export type {
  ToolNameMapResult,
  SkillToolsValidation,
} from './tool-name-mapper.js';

// ============================================================
// Anthropic Skills 加载器
// ============================================================
export { AnthropicSkillsLoader } from './anthropic-skills-loader.js';
export type { LoadedSkill, LoadResult } from './anthropic-skills-loader.js';

// ============================================================
// Claude Plugin 导入器
// ============================================================
export { ClaudePluginImporter } from './claude-plugin-importer.js';
export type {
  PluginMetadata,
  ImportedSkill,
  ImportedAgentProfile,
  ImportedMCPRef,
  ImportedHook,
  PluginImportResult,
  ImportFromPathOptions,
} from './claude-plugin-importer.js';

// ============================================================
// Codex Instructions 导入器（Phase 48 Task 3）
// ============================================================
export { CodexInstructionImporter } from './codex-importer.js';
export type {
  CodexScanResult,
  CodexImportResult,
  CodexImportOptions,
} from './codex-importer.js';
