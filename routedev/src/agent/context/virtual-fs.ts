// src/agent/context/virtual-fs.ts
// Phase 71 Task E1：进程内虚拟文件系统（VirtualFS）
//
// 设计借鉴 deepagents 的 StateFile 思路：把 Agent 工作内存（todo、scratchpad、notes、
// 中间产物）统一抽象为虚拟文件，让 LLM 通过文件读写操作维护状态，避免状态散落在
// 多个 system prompt 字段。
//
// 特性：
// 1. 纯内存维护，无 IO，理论上不失败（fail-open）
// 2. 路径规范化：相对路径基于 `/` 根，posix 风格（用 `/` 不用 `\`）
// 3. 路径安全：禁止 `..` 越权（规范化后检测是否在根下）
// 4. 路径非法时返回错误值（null/false/空数组），不抛异常

/**
 * 虚拟节点类型
 */
export type VNodeType = 'file' | 'dir';

/**
 * 虚拟节点
 */
export interface VNode {
  type: VNodeType;
  /** 文件内容（仅 file 节点有效） */
  content?: string;
}

/**
 * 进程内虚拟文件系统
 *
 * 内存中维护文件树（Map<normalizedPath, VNode>），根目录 `/` 隐式存在。
 * 所有方法在路径非法时返回错误值（不抛异常），由调用方（如 VFS 工具层）
 * 通过 normalizePath 公共方法预检路径合法性并构造错误信息。
 */
export class VirtualFS {
  /** 文件树：normalizedPath → VNode（根目录 `/` 不入 Map，隐式存在） */
  private readonly nodes = new Map<string, VNode>();

  /**
   * 路径规范化：
   *   1. Windows 反斜杠 → posix 正斜杠
   *   2. 去除前缀 `./`
   *   3. 相对路径补前导 `/`（基于根 `/`）
   *   4. 折叠多余斜杠
   *   5. 解析 `.` 与 `..` 段；`..` 越权（跳出根）返回 null
   *
   * @returns 规范化后的 posix 路径；非法（空串、`..` 越权）返回 null
   */
  normalizePath(input: string): string | null {
    if (typeof input !== 'string' || input.length === 0) return null;

    // 1. Windows 反斜杠 → 正斜杠
    let p = input.replace(/\\/g, '/');

    // 2. 去除前缀 ./
    while (p.startsWith('./')) {
      p = p.slice(2);
    }

    // 3. 相对路径补前导 /
    if (!p.startsWith('/')) {
      p = '/' + p;
    }

    // 4. 折叠多余斜杠
    p = p.replace(/\/+/g, '/');

    // 5. 解析段（处理 . 与 ..）
    const segments: string[] = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        // .. 越权：已到根之上
        if (segments.length === 0) return null;
        segments.pop();
        continue;
      }
      segments.push(seg);
    }

    return '/' + segments.join('/');
  }

  /**
   * 读取文件内容
   * @returns 文件内容；路径非法或文件不存在返回 null
   */
  read(path: string): string | null {
    const normalized = this.normalizePath(path);
    if (normalized === null) return null;
    const node = this.nodes.get(normalized);
    if (!node || node.type !== 'file') return null;
    return node.content ?? '';
  }

  /**
   * 写入文件（覆盖式）
   * 路径非法时静默忽略（fail-open，不抛异常）
   */
  write(path: string, content: string): void {
    const normalized = this.normalizePath(path);
    if (normalized === null) return;
    this.nodes.set(normalized, { type: 'file', content });
  }

  /**
   * 列出目录直接子节点（不递归）
   * @returns 子节点名称列表（文件原样返回，目录加 `/` 后缀），按字典序排序；
   *          路径非法或目录不存在返回空数组
   */
  list(dir: string): string[] {
    const normalized = this.normalizePath(dir);
    if (normalized === null) return [];

    const prefix = normalized === '/' ? '/' : normalized + '/';
    const results = new Set<string>();

    for (const path of this.nodes.keys()) {
      if (path === normalized) continue; // 跳过自身
      if (!path.startsWith(prefix)) continue;

      const rest = path.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) {
        // 直接子文件
        results.add(rest);
      } else if (slashIdx > 0) {
        // 直接子目录：取第一段，加 / 后缀
        results.add(rest.slice(0, slashIdx) + '/');
      }
    }

    return Array.from(results).sort();
  }

  /**
   * 删除文件或目录（递归删除目录下所有内容）
   * 路径非法时静默忽略（fail-open，不抛异常）
   */
  delete(path: string): void {
    const normalized = this.normalizePath(path);
    if (normalized === null || normalized === '/') {
      // 禁止删除根目录
      return;
    }

    this.nodes.delete(normalized);

    // 递归删除子节点
    const prefix = normalized + '/';
    for (const p of Array.from(this.nodes.keys())) {
      if (p.startsWith(prefix)) {
        this.nodes.delete(p);
      }
    }
  }

  /**
   * 判断路径是否存在（文件或目录）
   */
  exists(path: string): boolean {
    const normalized = this.normalizePath(path);
    if (normalized === null) return false;
    if (normalized === '/') return true; // 根目录隐式存在
    return this.nodes.has(normalized);
  }

  /**
   * 创建目录
   * 路径非法时静默忽略；已存在同名节点时不覆盖
   */
  mkdir(path: string): void {
    const normalized = this.normalizePath(path);
    if (normalized === null || normalized === '/') return;
    if (this.nodes.has(normalized)) return;
    this.nodes.set(normalized, { type: 'dir' });
  }
}

/**
 * 创建 VirtualFS 实例的工厂函数
 */
export function createVFS(): VirtualFS {
  return new VirtualFS();
}
