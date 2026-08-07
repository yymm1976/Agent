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

import { randomBytes } from 'node:crypto';

/** 进程内单调计数器（模块级，跨 createOrderedRevision 调用递增） */
let monotonicCounter = 0;

/**
 * A4 修复：fixed-width base36 编码——保证 id 字符串序与数值序一致。
 * 变长编码在进位边界错序（'9' vs '10'：字典序 '10' < '9'）；fixed-width
 * 前缀对齐后字符串比较 = 数值比较。36^10 ≈ 3.6e15 ms（远超 Date.now
 * 1.7e12），36^6 ≈ 2.1e9（进程内单调计数足够）。
 */
const TS_WIDTH = 10;
const SEQ_WIDTH = 6;

function toFixedBase36(value: number, width: number): string {
  return value.toString(36).padStart(width, '0');
}

/**
 * 创建新的 OrderedRevision。
 * @param now 墙钟（可注入以便测试确定性；缺省 Date.now()）
 */
export function createOrderedRevision(now: number = Date.now()): OrderedRevision {
  monotonicCounter += 1;
  const seq = monotonicCounter;
  // A4 修复：crypto 随机分量（不依赖 Math.random 做 identity collision protection）
  const rand = randomBytes(4).toString('hex');
  const id = `${toFixedBase36(now, TS_WIDTH)}-${toFixedBase36(seq, SEQ_WIDTH)}-${rand}`;
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
