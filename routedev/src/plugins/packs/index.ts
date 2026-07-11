// src/plugins/packs/index.ts
// Phase 82 Task 2/3：能力包（Capability Pack）注册入口
//
// 导出所有官方 Pack（3 Extended + 3 Standard），供 PackLoader 按配置装配：
//   - Extended Pack（高级区，默认关，修 bug 不扩功能）
//     1. pack.goal-advanced       Goal 高级编排
//     2. pack.multi-agent         Multi-Agent 编排
//     3. pack.adversarial-review  对抗审查
//   - Standard Pack（扩展区，默认关，冷处理仅修崩溃）
//     4. pack.browser-web         浏览器/Web
//     5. pack.code-map            代码地图
//     6. pack.harness             Harness
//
// 装配流程：
//   1. PackLoader 读取 config.packs.<id>.enabled 判断是否启用
//   2. 启用的 Pack 调用 register(ctx) 注册资源
//   3. Phase 81 门控已负责模块的条件装配，Pack 在此基础上增加正式接口包装

import type { CapabilityPack } from '../capability-pack.js';

// --- Extended Pack（高级区）---
import { goalAdvancedPack } from './goal-advanced-pack.js';
import { multiAgentPack } from './multi-agent-pack.js';
import { adversarialReviewPack } from './adversarial-review-pack.js';

// --- Standard Pack（扩展区）---
import { browserWebPack } from './browser-web-pack.js';
import { codeMapPack } from './code-map-pack.js';
import { harnessPack } from './harness-pack.js';

// ============================================================
// 官方 Pack 列表
// ============================================================

/**
 * 所有官方 Pack 列表（按 layer 分组：extended 在前，standard 在后）
 *
 * PackLoader 应遍历此列表，按 config.packs.<id>.enabled 决定是否调用 register。
 * 注意：Pack 的 id 需与 config.packs 的 key 对应（如 pack.browser-web ↔ browserWeb）。
 */
export const OFFICIAL_PACKS: CapabilityPack[] = [
  // --- Extended Pack（高级区，默认关，修 bug 不扩功能）---
  goalAdvancedPack,
  multiAgentPack,
  adversarialReviewPack,
  // --- Standard Pack（扩展区，默认关，冷处理仅修崩溃）---
  browserWebPack,
  codeMapPack,
  harnessPack,
];

// ============================================================
// 命名导出（便于按需引用单个 Pack）
// ============================================================

// --- Extended Pack ---
export { goalAdvancedPack } from './goal-advanced-pack.js';
export { multiAgentPack } from './multi-agent-pack.js';
export { adversarialReviewPack } from './adversarial-review-pack.js';

// --- Standard Pack ---
export { browserWebPack } from './browser-web-pack.js';
export { codeMapPack } from './code-map-pack.js';
export { harnessPack } from './harness-pack.js';

// ============================================================
// 辅助函数
// ============================================================

// Phase 82 自审修复：findPackById / getPacksByLayer 已删除（死代码，无调用方）
// 按需查找请直接使用 CapabilityPackRegistry.listAll() / listByLayer() / get()
