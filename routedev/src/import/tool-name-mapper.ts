// src/import/tool-name-mapper.ts
// Claude Code 遗留命令工具名 → RouteDev 工具名映射器
//
// 设计目标：
//   1. 把 Claude Code 的 legacy command 工具调用翻译为 RouteDev 工具
//   2. 陷阱 #132：未映射工具不能静默失败，必须分类返回 unmapped
//   3. validateSkillTools：对 Skill 中声明的工具名做校验，未映射者生成 warning
//
// 来源：Phase 48 Task 2 蓝图 2.5

// ============================================================
// 工具名映射表
// ============================================================

/**
 * Claude Code legacy command 工具名 → RouteDev 工具名
 *
 * 仅覆盖 Claude Code 遗留 slash command 中常见的工具调用名，
 * 不包含 MCP 工具（MCP 工具名在 .mcp.json 中独立声明，由 ClaudeMCPBridge 处理）
 */
const TOOL_NAME_MAP: Record<string, string> = {
  Read: 'read_file',
  Glob: 'list_directory',
  Grep: 'search_code',
  Write: 'file_write',
  Edit: 'file_edit',
  Bash: 'execute_command',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
};

// ============================================================
// 单名映射
// ============================================================

/**
 * 把单个 Claude Code 工具名翻译为 RouteDev 工具名
 *
 * @param name Claude Code 工具名（如 'Read'）
 * @returns 映射到的 RouteDev 工具名；未映射时返回 null（陷阱 #132）
 */
export function mapToolName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  // 大小写敏感：Claude Code 工具名首字母大写，RouteDev 工具名全小写带下划线
  return TOOL_NAME_MAP[name] ?? null;
}

// ============================================================
// 批量映射
// ============================================================

/** 批量映射结果 */
export interface ToolNameMapResult {
  /** 成功映射的工具名（RouteDev 名） */
  mapped: string[];
  /** 未能映射的原始工具名（陷阱 #132：调用方必须处理，不能静默丢弃） */
  unmapped: string[];
}

/**
 * 批量翻译工具名
 *
 * 陷阱 #132：未映射的工具名收集到 unmapped 数组，调用方需据此生成警告或禁用对应 Skill
 *
 * @param names Claude Code 工具名列表
 * @returns mapped（RouteDev 工具名）+ unmapped（无法映射的原始名）
 */
export function mapToolNames(names: string[]): ToolNameMapResult {
  const mapped: string[] = [];
  const unmapped: string[] = [];

  if (!Array.isArray(names)) return { mapped, unmapped };

  // 去重：同一工具名多次出现只保留一次
  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    const target = mapToolName(raw);
    if (target === null) {
      unmapped.push(raw);
    } else {
      mapped.push(target);
    }
  }

  return { mapped, unmapped };
}

// ============================================================
// Skill 工具校验
// ============================================================

/** Skill 工具校验结果 */
export interface SkillToolsValidation {
  /** 成功映射的工具名（RouteDev 名） */
  valid: string[];
  /** 无法识别的工具名（原始名） */
  invalid: string[];
  /** 警告信息（每个未映射工具一条） */
  warnings: string[];
}

/**
 * 校验 Skill 中声明的工具名
 *
 * 用于 Skill 导入时：
 *   - 已映射工具进入 valid 数组
 *   - 未映射工具进入 invalid 数组，并为每个生成一条 warning
 *   - 调用方据此决定是否禁用该 Skill 或仅警告
 *
 * 陷阱 #132：未映射工具必须生成 warning，不能静默失败
 *
 * @param toolNames Skill 中声明的工具名列表（可能是 Claude Code 或 RouteDev 命名）
 */
export function validateSkillTools(toolNames: string[]): SkillToolsValidation {
  const valid: string[] = [];
  const invalid: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(toolNames)) {
    return { valid, invalid, warnings };
  }

  // 去重输入避免重复 warning
  const seen = new Set<string>();
  for (const raw of toolNames) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    const target = mapToolName(raw);
    if (target === null) {
      invalid.push(raw);
      warnings.push(
        `工具 "${raw}" 无法映射到 RouteDev 工具，已禁用该工具调用（陷阱 #132）`,
      );
    } else {
      valid.push(target);
    }
  }

  return { valid, invalid, warnings };
}

// ============================================================
// 反向映射（RouteDev → Claude Code，供调试/日志）
// ============================================================

/**
 * 反向查询：RouteDev 工具名 → Claude Code 工具名
 *
 * 主要用于日志/调试，不在导入主流程中使用
 */
export function reverseMapToolName(routedevName: string): string | null {
  if (typeof routedevName !== 'string' || routedevName.length === 0) return null;
  for (const [claudeName, devName] of Object.entries(TOOL_NAME_MAP)) {
    if (devName === routedevName) return claudeName;
  }
  return null;
}

/** 暴露映射表副本（供测试与文档生成使用） */
export function getToolNameMap(): Record<string, string> {
  return { ...TOOL_NAME_MAP };
}
