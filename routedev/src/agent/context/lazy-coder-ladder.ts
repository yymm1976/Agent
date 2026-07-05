// src/agent/context/lazy-coder-ladder.ts
// Phase 72 Task C3：5 级决策阶梯（Lazy Coder Ladder）
//
// 设计动机：抑制 Agent 在代码任务中"过度工程化"倾向——
//   倾向于新增抽象、新增依赖、新增功能，而非复用现有、用 stdlib、最小实现。
// 5 级阶梯按"代码新增成本"递增排序，Agent 应从第 1 级开始自问，命中即停：
//   1. YAGNI：真的需要存在吗？
//   2. 复用现有：codebase 中已有类似功能？
//   3. stdlib / native：能用语言标准库实现？
//   4. 已装依赖：package.json 中已有依赖能满足？
//   5. 最小实现：必须新增时，写最少行数、最少抽象的版本。
//
// 永不裁剪清单：安全边界校验、防数据丢失的错误处理、可访问性、并发安全
// 这四类即便增加代码量也必须保留，不属于"过度工程化"。

/**
 * 5 级决策阶梯 prompt 片段（不含外层标题，由 system-prompt-builder 统一加【】标题）
 *
 * 命中即停：从第 1 级开始自问，任一级满足即采用该级方案，不向下继续。
 */
export const LAZY_CODER_LADDER = `编写代码前，按以下 5 级阶梯依次自问，命中即停（优先选择成本最低的方案）：

1. YAGNI：这个功能真的需要存在吗？能否用注释占位延后实现？
2. 复用现有：codebase 中是否已有类似功能可调用？先 grep 再写。
3. stdlib / native：能否用语言标准库 / 内置 API 实现？
4. 已装依赖：package.json 中已有的依赖能否满足？
5. 最小实现：必须新增代码时，写最少行数、最少抽象的版本。

永不裁剪清单（即便增加代码量也必须保留，不属于过度工程化）：
- 安全边界校验（路径/权限/输入校验）
- 防数据丢失的错误处理（写入失败回滚、并发冲突检测）
- 可访问性（a11y / 键盘导航 / 屏幕阅读器）
- 并发安全（竞态条件 / 锁 / 原子性）`;

/**
 * 检测用户消息是否为"代码任务"
 *
 * 启发式规则：同时包含"动作词"与"代码词"才判定为代码任务
 *   - 动作词：实现 / 修改 / 编写 / 修复 / 重构 / 添加 / 删除
 *   - 代码词：代码 / 函数 / 类 / 模块 / 文件 / 接口 / 类型 / 组件 / bug
 *
 * 仅在判定为代码任务时注入 LAZY_CODER_LADDER，避免闲聊/知识问答场景污染 prompt。
 *
 * @param userMessage 用户最新消息
 * @returns 是否为代码任务
 */
export function isCodeTask(userMessage: string): boolean {
  if (!userMessage || typeof userMessage !== 'string') return false;
  const text = userMessage.toLowerCase();
  // 动作词（含中英文）
  const actionWords = [
    '实现', '修改', '编写', '修复', '重构', '添加', '删除', '新增', '改动', '改一下', '写一个', '写个',
    'implement', 'modify', 'write', 'fix', 'refactor', 'add', 'delete', 'change',
  ];
  // 代码词（含中英文）
  const codeWords = [
    '代码', '函数', '类', '模块', '文件', '接口', '类型', '组件', 'bug', '方法', '变量', '逻辑', '实现',
    'code', 'function', 'class', 'module', 'file', 'interface', 'type', 'component', 'method', 'variable', 'logic',
  ];
  const hasAction = actionWords.some(w => text.includes(w.toLowerCase()));
  const hasCode = codeWords.some(w => text.includes(w.toLowerCase()));
  return hasAction && hasCode;
}
