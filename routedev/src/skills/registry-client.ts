// src/skills/registry-client.ts
// 远程市场 Registry 接口预留
// 当 market.registryUrl 配置后，可通过 HTTP 拉取远程 Skill/Hook/Agent Profile
// 未配置时返回 StubRegistryClient（空列表），避免 breaking change

export type RegistryItemType = 'skill' | 'hook' | 'agent-profile';

export interface RegistryItem {
  /** 包名（唯一标识） */
  name: string;
  /** 语义化版本号 */
  version: string;
  /** 包类型 */
  type: RegistryItemType;
  /** 描述 */
  description: string;
  /** 作者 */
  author: string;
  /** 下载 URL */
  downloadUrl: string;
  /** 包大小（字节） */
  size: number;
  /** 发布时间戳（ms） */
  publishedAt: number;
}

/**
 * Registry 客户端接口
 * 支持列出 / 搜索 / 下载远程市场包
 */
export interface RegistryClient {
  listSkills(): Promise<RegistryItem[]>;
  listHooks(): Promise<RegistryItem[]>;
  listAgentProfiles(): Promise<RegistryItem[]>;
  downloadPackage(name: string, version: string): Promise<Buffer>;
  search(query: string): Promise<RegistryItem[]>;
}

/**
 * Stub 实现（默认）
 * 返回空列表，downloadPackage 抛错
 * 用于未配置 registryUrl 时的占位，避免 breaking change
 */
export class StubRegistryClient implements RegistryClient {
  async listSkills(): Promise<RegistryItem[]> {
    return [];
  }
  async listHooks(): Promise<RegistryItem[]> {
    return [];
  }
  async listAgentProfiles(): Promise<RegistryItem[]> {
    return [];
  }
  async downloadPackage(): Promise<Buffer> {
    throw new Error('Registry not configured');
  }
  async search(): Promise<RegistryItem[]> {
    return [];
  }
}

/**
 * HTTP 实现
 * 当 registryUrl 配置后启用，通过 HTTP 拉取远程 Skill/Hook/Agent Profile
 */
export class HttpRegistryClient implements RegistryClient {
  private baseUrl: string;
  private token?: string;

  constructor(registryUrl: string, token?: string) {
    // 规范化 URL：补全协议前缀、去除尾斜杠
    let url = registryUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    this.baseUrl = url.replace(/\/+$/, '');
    this.token = token;
  }

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`Registry ${res.status}: ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  async listSkills(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/skills');
  }
  async listHooks(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/hooks');
  }
  async listAgentProfiles(): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>('/api/agent-profiles');
  }
  async search(query: string): Promise<RegistryItem[]> {
    return this.request<RegistryItem[]>(`/api/search?q=${encodeURIComponent(query)}`);
  }
  async downloadPackage(name: string, version: string): Promise<Buffer> {
    const res = await fetch(
      `${this.baseUrl}/api/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
    );
    if (!res.ok) throw new Error(`Download ${res.status}: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

/**
 * 工厂函数：根据 registryUrl 是否配置选择客户端
 * - 未配置：返回 StubRegistryClient（空列表）
 * - 已配置：返回 HttpRegistryClient（实际实现待后续）
 */
export function createRegistryClient(registryUrl?: string, token?: string): RegistryClient {
  if (!registryUrl) return new StubRegistryClient();
  return new HttpRegistryClient(registryUrl, token);
}
