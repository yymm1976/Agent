// src/store.ts
// 任务存储：updateTask 修改任务但 BUG——不递增 revision
export interface Task {
  id: string;
  name: string;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private rev = 0;

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.rev += 1;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listAll(): Task[] {
    return [...this.tasks.values()];
  }

  /** 当前修订号——外部缓存依赖它判断是否需要失效 */
  get revision(): number {
    return this.rev;
  }

  updateTask(id: string, patch: Partial<Task>): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`task not found: ${id}`);
    this.tasks.set(id, { ...task, ...patch });
    // BUG: 忘记 this.rev += 1——订阅者/缓存不会失效（UI 显示旧名直到重启）
  }
}
