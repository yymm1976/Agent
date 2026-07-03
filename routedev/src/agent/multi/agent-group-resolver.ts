// src/agent/multi/agent-group-resolver.ts
// Phase 69 Task 4: 代理组管理与寻址

export interface AgentGroup {
  name: string;
  workerIds: string[];
  description: string;
}

export class AgentGroupResolver {
  private groups = new Map<string, AgentGroup>();

  register(group: AgentGroup): void {
    this.groups.set(group.name, group);
  }

  resolve(address: string): string[] {
    if (address.startsWith('@')) {
      const groupName = address.slice(1);
      const group = this.groups.get(groupName);
      return group?.workerIds ?? [];
    }
    return [address];
  }

  listGroups(): AgentGroup[] {
    return [...this.groups.values()];
  }

  isGroupAddress(address: string): boolean {
    return address.startsWith('@') && this.groups.has(address.slice(1));
  }

  unregister(name: string): boolean {
    return this.groups.delete(name);
  }
}
