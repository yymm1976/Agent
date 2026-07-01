// src/policies/playbook.ts
// SOP 注入
//
// 设计目标：
//   1. 提供内置 SOP（API 设计、数据库迁移等）
//   2. 命中后通过 PolicyEngine 统一调度，返回 injectPrompt（步骤说明）
//
// 注：静态 evaluate / getPrompts / matchKeywords 已作为死代码删除
//     （PolicyEngine 内部通过 evaluateAction 遍历 policies 数组直接处理）

import type { Policy } from './policy-engine.js';

// ============================================================
// Playbook
// ============================================================

export class Playbook {
  /**
   * 内置 SOP
   *
   * priority=50 低于 IntentGuard（100），保证危险操作优先阻断
   */
  static readonly BUILTIN_PLAYBOOKS: Policy[] = [
    {
      id: 'api-design-sop',
      type: 'playbook',
      name: 'API 设计 SOP',
      enabled: true,
      priority: 50,
      trigger: {
        mode: 'keyword',
        keywords: ['设计 API', '新增接口', 'REST API', 'API 设计'],
      },
      action: {
        injectPrompt:
          '请按以下步骤设计 API：\n1. 先定义 OpenAPI schema\n2. 再写 handler 单元测试\n3. 最后实现 handler 并接入路由',
      },
    },
    {
      id: 'db-migration-sop',
      type: 'playbook',
      name: '数据库迁移 SOP',
      enabled: true,
      priority: 50,
      trigger: {
        mode: 'keyword',
        keywords: ['数据库迁移', 'migration', 'schema 变更'],
      },
      action: {
        injectPrompt:
          '请按以下步骤执行数据库迁移：\n1. 先创建迁移文件\n2. 在测试环境验证\n3. 更新相关模型和类型\n4. 更新文档',
      },
    },
  ];
}

// ============================================================
// 工厂函数（供 app-init.ts feature-detect 加载）
// ============================================================

/**
 * 创建内置 Playbook 策略列表
 *
 * 返回 BUILTIN_PLAYBOOKS 的深拷贝
 */
export function createBuiltinPlaybookPolicies(): Policy[] {
  return Playbook.BUILTIN_PLAYBOOKS.map((p) => ({
    ...p,
    trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
    action: { ...p.action },
  }));
}
