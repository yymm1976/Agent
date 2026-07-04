// edit-history.ts — 文件编辑历史栈，用于 /undo 命令撤销最近一次文件编辑（非工具，辅助类）

/** 单条编辑历史条目 */
export interface EditHistoryEntry {
  /** 被编辑文件的绝对路径 */
  filePath: string;
  /** 编辑前的原始内容 */
  content: string;
  /** 推入时间戳（Date.now()） */
  timestamp: number;
}

export class EditHistory {
  private stack: EditHistoryEntry[] = [];
  private maxSize = 20;

  /** 推入一条编辑前的文件内容快照 */
  push(filePath: string, content: string): void {
    this.stack.push({ filePath, content, timestamp: Date.now() });
    // 超过上限时丢弃最早的（FIFO，保留最近 20 条）
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    }
  }

  /** 弹出最近一条编辑（栈顶），栈空返回 null */
  pop(): EditHistoryEntry | null {
    return this.stack.pop() ?? null;
  }

  /** 当前栈深度 */
  size(): number {
    return this.stack.length;
  }

  /** 清空栈 */
  clear(): void {
    this.stack = [];
  }
}

/** 单例：进程内全局共享，file-edit 工具与 /undo 命令共用 */
export const editHistory = new EditHistory();
