// src/skills/governance.ts
// B-17：扩展（Skill）治理——能力版本、最小宿主版本、权限清单、故障隔离
//
// 设计目的：
//   扩展（SKILL.md）在加载前做兼容性校验，不兼容的扩展被显式拒绝（fail-open：
//   单个扩展的失败不影响其他扩展与主进程）。数据访问按声明清单约束，
//   不再新增第二套配置语言——全部复用 SKILL.md frontmatter 现有字段。
//
// 消费点：
//   - src/import/anthropic-skills-loader.ts（parseSkillFile 时校验，load() 过滤）
//   - 未来 MCP/Skill 市场安装流程复用同一校验器（单一真相源）

import type { SkillMetadata } from './skill-md-parser.js';

/** 当前支持的能力格式版本（SKILL.md 结构版本） */
export const SUPPORTED_CAPABILITY_VERSION = '1';

/** 兼容性校验结果 */
export interface SkillCompatibility {
  ok: boolean;
  /** 拒绝原因（ok=true 时为空） */
  reason?: string;
}

/** 解析 semver：`4.9.0` / `4.9.0-beta.1` → { major, minor, patch }；非法返回 null */
export function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** semver 比较：a >= b（非法版本视为不满足） */
export function isVersionAtLeast(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  return pa.patch >= pb.patch;
}

/**
 * 校验 Skill 与宿主 RouteDev 的兼容性。
 * @param metadata SKILL.md frontmatter 元数据
 * @param hostVersion 宿主 RouteDev 版本（如 '4.9.0'；缺失时不校验 minRouteDevVersion）
 * @returns { ok, reason }——不兼容时 reason 说明原因
 */
export function checkSkillCompatibility(
  metadata: SkillMetadata,
  hostVersion?: string,
): SkillCompatibility {
  // 能力格式版本：只认支持的版本（缺省视为 '1'，向后兼容存量 skill）
  const capability = metadata.capabilityVersion?.trim() || '1';
  if (capability !== SUPPORTED_CAPABILITY_VERSION) {
    return {
      ok: false,
      reason: `能力格式版本 ${capability} 不受支持（当前支持 ${SUPPORTED_CAPABILITY_VERSION}）`,
    };
  }

  // 最小宿主版本：低于要求则拒绝（宿主版本未知时放行，避免误伤无版本环境）
  if (metadata.minRouteDevVersion && hostVersion) {
    if (!isVersionAtLeast(hostVersion, metadata.minRouteDevVersion)) {
      return {
        ok: false,
        reason: `需要 RouteDev >= ${metadata.minRouteDevVersion}（当前 ${hostVersion}）`,
      };
    }
  }

  return { ok: true };
}

/** 数据访问声明摘要（供 UI/审计展示权限清单） */
export interface SkillPermissionSummary {
  /** 允许的文件访问 glob（空数组 = 仅工作区内路径） */
  files: string[];
  /** 是否允许网络访问 */
  network: boolean;
  /** 允许读取的环境变量（空数组 = 不读取） */
  env: string[];
}

/** 汇总 Skill 的数据访问声明（缺省 = 无网络/无环境变量/文件仅工作区） */
export function describeSkillPermissions(metadata: SkillMetadata): SkillPermissionSummary {
  return {
    files: [...(metadata.permissions?.files ?? [])],
    network: metadata.permissions?.network ?? false,
    env: [...(metadata.permissions?.env ?? [])],
  };
}
