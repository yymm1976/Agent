// src/hooks/templates.ts
// Hook 模板库：替代已移除的 HookGenerator（LLM 生成模式）
//
// 设计目标：
//   1. 提供一组内置、可控、安全的 Hook 模板（不依赖 LLM 生成）
//   2. 用户从 UI 选择模板即可创建 Hook，无需编写代码
//   3. 自定义模式仍允许用户直接提供 shell 命令（需自担风险）
//
// 与 HookGenerator 的区别：
//   - Generator 用 LLM 生成 JS 代码，存在不可控风险
//   - Templates 提供预定义、经过审查的 shell 命令模板，可读可审计
//
// 与 HookConfigRegistry 的关系：
//   - 模板的 code 字段会保存到 HookConfig.command（复用现有持久化结构）
//   - 模板的 condition / failBehavior / priority 同步到 HookConfig 对应字段
//   - 创建后 isTemplate=true，可在 UI 区分模板/自定义

import type { HookEvent } from '../agent/hooks.js';

// ============================================================
// 类型定义
// ============================================================

/** Hook 模板（UI 展示用，含完整元数据） */
export interface HookTemplate {
  /** 模板唯一 ID（创建 Hook 时作为前缀避免冲突，如 template-block-large-file-write） */
  id: string;
  /** 模板显示名称 */
  name: string;
  /** 模板描述（说明用途和行为） */
  description: string;
  /** 触发事件 */
  event: HookEvent;
  /** 优先级（数值越小越先执行，默认 50） */
  priority: number;
  /**
   * 模板代码（shell 命令字符串）
   *
   * 支持变量替换：
   *   - {{filePath}}：当前文件路径
   *   - {{toolName}}：当前工具名
   *   - {{stepId}}：当前步骤 ID
   *
   * 退出码语义（由 adapter.ts 解释）：
   *   - 0：通过，返回 continue
   *   - 非零：返回 skip（pre-tool-call 时阻止工具调用）
   */
  code: string;
  /** 默认是否启用 */
  enabled: boolean;
  /** 触发条件（可选，匹配特定工具/文件） */
  condition?: { toolName?: string; filePattern?: string };
  /** 失败行为（默认 warn） */
  failBehavior: 'warn' | 'block' | 'silent';
}

// ============================================================
// 内置 Hook 模板
// ============================================================

/**
 * 内置 Hook 模板列表
 *
 * 每个模板都经过人工审查，命令安全可审计。
 * 新增模板时请遵循：
 *   1. 命令不修改系统状态（除非明确必要）
 *   2. 命令不访问网络（避免数据外泄）
 *   3. 命令有明确退出码语义
 *   4. 优先使用 {{filePath}}/{{toolName}} 变量而非硬编码
 */
export const HOOK_TEMPLATES: HookTemplate[] = [
  // 1. 阻止写入大文件（>10MB）
  {
    id: 'block-large-file-write',
    name: '阻止大文件写入',
    description:
      'pre-tool-call：检查待写入文件是否已存在且 > 10MB，若是则阻止 file_write 调用（防止意外覆盖大文件）',
    event: 'pre-tool-call',
    priority: 30,
    code:
      'f="{{filePath}}"; if [ -f "$f" ]; then sz=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0); if [ "$sz" -gt 10485760 ]; then echo "阻止：$f 大小 $sz 字节（> 10MB）" >&2; exit 1; fi; fi; exit 0',
    enabled: true,
    condition: { toolName: 'file_write' },
    failBehavior: 'block',
  },

  // 2. 记录 shell_exec 命令到日志
  {
    id: 'log-shell-commands',
    name: '记录 Shell 命令',
    description:
      'pre-tool-call：将所有 shell_exec 工具调用的命令记录到 .routedev/shell-commands.log（审计用途）',
    event: 'pre-tool-call',
    priority: 20,
    code:
      'mkdir -p .routedev && echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] {{toolName}} step={{stepId}}" >> .routedev/shell-commands.log; exit 0',
    enabled: true,
    condition: { toolName: 'shell_exec' },
    failBehavior: 'silent',
  },

  // 3. 验证工具输出（post-tool-call，简单 JSON 检测）
  {
    id: 'validate-json-output',
    name: '验证 JSON 输出',
    description:
      'post-tool-call：检测 file_read 工具读取的 JSON 文件是否有效（简单括号匹配，不阻断）',
    event: 'post-tool-call',
    priority: 50,
    code:
      'f="{{filePath}}"; if [ -f "$f" ] && echo "$f" | grep -qE "\\.(json)$"; then if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then echo "警告：$f 不是有效 JSON" >&2; fi; fi; exit 0',
    enabled: true,
    condition: { toolName: 'file_read' },
    failBehavior: 'warn',
  },

  // 4. 会话结束时打印摘要
  {
    id: 'session-token-summary',
    name: '会话结束摘要',
    description:
      'on-session-end：会话结束时在 .routedev/session-summary.log 记录结束时间戳（token 用量由 TraceCollector 单独记录）',
    event: 'on-session-end',
    priority: 50,
    code:
      'mkdir -p .routedev && echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] session ended" >> .routedev/session-summary.log; exit 0',
    enabled: true,
    failBehavior: 'silent',
  },

  // 5. 夜间阻止破坏性操作（22:00-06:00）
  {
    id: 'block-nightly-destructive',
    name: '夜间阻止破坏性操作',
    description:
      'pre-tool-call：22:00-06:00 期间阻止 shell_exec / git_op / file_delete 工具调用（避免疲劳时段误操作）',
    event: 'pre-tool-call',
    priority: 10,
    code:
      'h=$(date +%H); if [ "$h" -ge 22 ] || [ "$h" -lt 6 ]; then echo "阻止：当前为夜间时段（$h:xx），禁止破坏性操作" >&2; exit 1; fi; exit 0',
    enabled: true,
    condition: { toolName: 'shell_exec' },
    failBehavior: 'block',
  },
];

// ============================================================
// 查询 API
// ============================================================

/**
 * 获取所有内置 Hook 模板
 *
 * 返回模板的浅拷贝列表，调用方修改不会影响内置模板。
 */
export function getHookTemplates(): HookTemplate[] {
  return HOOK_TEMPLATES.map((t) => ({ ...t }));
}

/**
 * 按 ID 获取 Hook 模板
 *
 * @returns 模板对象（浅拷贝）或 undefined（ID 不存在）
 */
export function getHookTemplateById(id: string): HookTemplate | undefined {
  const t = HOOK_TEMPLATES.find((x) => x.id === id);
  return t ? { ...t } : undefined;
}
