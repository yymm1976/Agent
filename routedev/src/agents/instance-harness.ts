// src/agents/instance-harness.ts
// 三层抽象：Instance → Harness → Session
// Phase 51 Task 6：借鉴 Flue 的三层组合关系
//
// 层级语义：
//   AgentInstance  → 持久运行时作用域（对应一个项目/工作区）
//   AgentHarness   → 已初始化的 Agent 环境（model + tools + sandbox + skills）
//   Session        → 一次会话（持久化消息历史，由 subagent-session.ts 承载）
//
// 借鉴 Flue harness.ts:155-159 的存储键三元组与
// harness.ts:318-334 的 scope abort 级联模型。

/**
 * 三层抽象 Instance/Harness/Session —— 现状说明
 *
 * 当前状态：仅 Session 层（subagent-session.ts）已接入生产路径（DetachedSession）；
 * Instance/Harness 层设计完整但无消费方，装配后 AppDependencies.instanceHarness 字段
 * 无任何生产代码读取（toolRegistry/skills/filesystem 全部 null）。
 * 默认 threeTierAbstractionEnabled=false（config.instanceHarness）。
 *
 * 设计价值：为多项目/多环境隔离提供基础，未来可接入：
 *   - Instance 层：多项目并行运行时作用域
 *   - Harness 层：同一项目下不同模型/工具配置的环境切换
 *
 * 保留此模块供未来接入，不删除。
 */

/**
 * Instance 层——持久运行时作用域
 *
 * 对应一个项目/工作区，拥有独立的 sandbox 状态和配置覆盖。
 * 借鉴 Flue AgentInstance（URL <id> 标识的 durable runtime scope）。
 */
export interface AgentInstance {
  /** 实例 ID（对应项目路径或自定义标识） */
  id: string;
  /** 项目路径 */
  projectPath: string;
  /** 沙箱状态 */
  sandboxState?: {
    worktreePath?: string;
    envVars?: Record<string, string>;
  };
  /** 实例级配置覆盖（用 unknown 避免依赖 AppConfig 类型） */
  configOverride?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
}

/**
 * Harness 层——已初始化的 Agent 环境
 *
 * 封装一次 Agent 运行所需的全部上下文：
 *   model 默认值、tools 注册表、sandbox、filesystem、skills
 *
 * 借鉴 Flue Harness（init() 创建，封装 model/tools/sandbox/filesystem/skills/instructions）。
 */
export interface AgentHarness {
  /** 所属 Instance ID */
  instanceId: string;
  /** harness 名称（默认 'default'） */
  name: string;
  /** 默认模型 id */
  modelId: string;
  /** 工具注册表（用 unknown 避免循环依赖） */
  toolRegistry: unknown;
  /** Skill 注册表（用 unknown 避免循环依赖） */
  skills: unknown;
  /** 文件系统抽象（用 unknown 避免循环依赖） */
  filesystem: unknown;
  /** scope abort 控制器（级联取消） */
  scopeAbortController: AbortController;
  /** 创建时间 */
  createdAt: number;
}

/**
 * 生成存储键三元组字符串
 *
 * 借鉴 Flue createSessionStorageKey：
 * Instance ⊃ Harness ⊃ Session 的组合关系体现在 key 结构。
 *
 * 格式：`${instanceId}/${harnessName}/${sessionName}`
 */
export function createSessionStorageKey(
  instanceId: string,
  harnessName: string,
  sessionName: string,
): string {
  return `${instanceId}/${harnessName}/${sessionName}`;
}

/**
 * 解析存储键三元组字符串
 *
 * @returns 解析成功返回三元组对象；格式不合法（段数不为 3 或存在空段）返回 null
 */
export function parseSessionStorageKey(
  key: string,
): { instanceId: string; harnessName: string; sessionName: string } | null {
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  const [instanceId, harnessName, sessionName] = parts;
  if (!instanceId || !harnessName || !sessionName) return null;
  return { instanceId, harnessName, sessionName };
}

/**
 * Scope abort 级联控制器
 *
 * 借鉴 Flue harness.close() 的级联取消模型：
 *   - 每个 harness 一个 scopeAbortController
 *   - abort() 级联取消自身及所有子 scope
 *
 * 用法：
 *   const root = new HarnessScope();
 *   const child = root.createChild();
 *   const grandChild = child.createChild();
 *   root.abort('parent cancelled');  // 三个 scope 全部被取消
 */
export class HarnessScope {
  private abortController: AbortController;
  private childScopes: HarnessScope[] = [];

  constructor(private parent?: HarnessScope) {
    this.abortController = new AbortController();
    // 构造时自动注册到父 scope
    this.parent?.addChild(this);
  }

  /** 内部：注册子 scope */
  private addChild(child: HarnessScope): void {
    this.childScopes.push(child);
  }

  /** 级联 abort——取消自己和所有子 scope */
  abort(reason?: string): void {
    this.abortController.abort(reason);
    for (const child of this.childScopes) {
      child.abort(reason);
    }
    // I-8 修复：清理引用，避免重复 abort 遍历已取消的子 scope
    this.childScopes = [];
  }

  /** 当前 scope 的 AbortSignal */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** 创建子 scope 并自动注册到当前 scope */
  createChild(): HarnessScope {
    return new HarnessScope(this);
  }
}

/**
 * 创建默认 Instance
 *
 * @param projectPath 项目路径
 * @returns id 默认为 'default' 的 AgentInstance
 */
export function createDefaultInstance(projectPath: string): AgentInstance {
  return {
    id: 'default',
    projectPath,
    createdAt: Date.now(),
  };
}

/**
 * 创建 Harness
 *
 * @param instance 所属 Instance
 * @param name harness 名称（如 'default'）
 * @param modelId 默认模型 id
 * @returns 初始化好的 AgentHarness（toolRegistry/skills/filesystem 留空待后续 Phase 接入）
 */
export function createHarness(
  instance: AgentInstance,
  name: string,
  modelId: string,
): AgentHarness {
  return {
    instanceId: instance.id,
    name,
    modelId,
    // 以下字段留空——由后续 Phase 接入具体注册表实现
    toolRegistry: null,
    skills: null,
    filesystem: null,
    scopeAbortController: new AbortController(),
    createdAt: Date.now(),
  };
}
