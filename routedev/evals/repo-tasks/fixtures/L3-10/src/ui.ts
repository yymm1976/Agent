// src/ui.ts
// UI 层：基于 revision 缓存渲染结果（表面症状——根因在 store）
import type { TaskStore, Task } from './store.js';

export interface RenderView {
  tasks: Task[];
  stale: boolean;
}

export class TaskView {
  private cache: Task[] = [];
  private cachedRev = -1;
  private store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  /** 渲染：revision 变化时重建缓存，否则返回缓存（stale=true） */
  render(): RenderView {
    if (this.store.revision !== this.cachedRev) {
      this.cache = this.store.listAll();
      this.cachedRev = this.store.revision;
      return { tasks: this.cache, stale: false };
    }
    return { tasks: this.cache, stale: true };
  }
}
