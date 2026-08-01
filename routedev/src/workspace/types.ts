// src/workspace/types.ts
// Phase 97 Part D：工作区能力边界类型
//
// 设计目的：
//   Workspace 是 Skill / MCP / 记忆 / 权限的统一作用域：
//   - projectRoot：本地目录直接作为项目根，不导入不复制
//   - attachedDirectories / attachedFiles：显式附加目录与文件（API 文档、共享库、
//     测试数据、另一个 Git 仓库），把 Agent 可访问范围收在显式边界内
//   - enabledSkills / enabledMcpServers / instructions / memoryRef / permissionPolicy：
//     按工作区隔离的能力与策略

/** 工作区权限策略 */
export interface WorkspacePermissionPolicy {
  /** 沙箱级：read-only / workspace-write / full-access */
  sandbox: 'read-only' | 'workspace-write' | 'full-access';
  /** 是否允许读取工作区外路径（默认 false） */
  allowReadOutside: boolean;
}

/** 工作区 */
export interface Workspace {
  /** 全局唯一 id */
  id: string;
  /** 短标识（目录/URL 友好） */
  slug: string;
  /** 项目根目录（绝对路径，不复制） */
  projectRoot: string;
  /** 显式附加目录（绝对路径） */
  attachedDirectories: string[];
  /** 显式附加文件（绝对路径） */
  attachedFiles: string[];
  /** 启用的 Skill 名列表 */
  enabledSkills: string[];
  /** 启用的 MCP Server 名列表 */
  enabledMcpServers: string[];
  /** 工作区级指令（注入系统提示词） */
  instructions?: string;
  /** 记忆引用（可选，指向记忆命名空间） */
  memoryRef?: string;
  /** 权限策略（可选，缺省时沿用全局配置） */
  permissionPolicy?: WorkspacePermissionPolicy;
}

/** WorkspaceManager 配置 */
export interface WorkspaceManagerConfig {
  /** 持久化文件路径（默认 getAppDataDir()/workspaces.json） */
  storageFile?: string;
}
