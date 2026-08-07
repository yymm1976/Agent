// src/utils/ordered-revision.ts
// 第九轮复审：确定性顺序 / revision identity 系统原语
//
// 背景：多个模块曾各自用 Date.now() 当排序键——同毫秒写入时
// "谁先谁后"未被数据模型表达（AuditLogger 同毫秒乱序、Profile
// VersionManager 同毫秒 rollback 偶发）。本原语提供唯一权威排序。
//
// 设计：
//   - wallTimeMs：墙钟（展示/过滤用）
//   - sequence：进程内单调计数（同毫秒 tie-breaker）
//   - id：可排序字符串（wallTimeMs-36 进制 + sequence-36 进制 + 随机分量）
// 唯一 comparator：wallTimeMs → sequence → id（绝不退回 Date.now() 比较）

/** 确定性顺序 revision */
export interface OrderedRevision {
  /** 墙钟毫秒（展示/按天归档） */
  wallTimeMs: number;
  /** 进程内单调计数（同毫秒 tie-breaker；重启后重置由 id 随机分量区分） */
  sequence: number;
  /** 可排序 id（字符串序与 compareRevision 一致） */
  id: string;
}

/** 进程内单调计数器（模块级，跨 createOrderedRevision 调用递增） */
let monotonicCounter = 0;

/**
 * 创建新的 OrderedRevision。
 * @param now 墙钟（可注入以便测试确定性；缺省 Date.now()）
 */
export function createOrderedRevision(now: number = Date.now()): OrderedRevision {
  monotonicCounter += 1;
  const seq = monotonicCounter;
  // 随机分量：跨进程/重启后同毫秒 id 不冲突（字符串序仍由前缀主导）
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  const id = `${now.toString(36)}-${seq.toString(36)}-${rand}`;
  return { wallTimeMs: now, sequence: seq, id };
}

/**
 * 唯一权威 comparator：wallTimeMs → sequence → id。
 * 任何模块不得再自行编写 `b.timestamp - a.timestamp`。
 * @returns <0 表示 a 先于 b；>0 表示 b 先于 a；0 相等（仅当同对象）
 */
export function compareRevision(a: OrderedRevision, b: OrderedRevision): number {
  if (a.wallTimeMs !== b.wallTimeMs) return a.wallTimeMs - b.wallTimeMs;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
