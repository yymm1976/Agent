// src/macros/builtin.ts
// 内置 Macro 定义
//
// 4 个内置宏（Phase 48 Task 5.5）：
//   1. macro-creator：关于宏的宏，引导用户创建新宏
//   2. daily-standup：每日站会汇报模板
//   3. code-review：代码审查标准流程
//   4. commit-message：生成规范提交信息
//
// 内置宏在 MacroManager.loadAll 时注入，用户磁盘上的同名宏会覆盖内置版本。

import type { Macro } from './types.js';

/** 内置 Macro 列表（不可写盘，运行时注入） */
export const BUILTIN_MACROS: Macro[] = [
  {
    metadata: {
      name: 'macro-creator',
      type: 'macro',
      version: '1.0.0',
      author: 'routedev',
      keywords: ['macro', 'create', 'meta', '新建', '创建'],
      description: '关于宏的宏，引导用户创建新宏',
      category: 'meta',
    },
    content: `## 适用场景
当用户想要创建一个新的宏（Macro）时使用此宏。

## 工作流程
1. 询问用户宏的名称（kebab-case）
2. 询问用户宏的描述与适用场景
3. 询问用户希望宏的关键词（用于 \`!\` 触发器补全）
4. 根据用户描述生成宏正文（Markdown）
5. 写入 \`macros/<macro-name>/MACRO.md\`
6. 提示用户可以用 \`!<macro-name>\` 触发

## 输出格式
- 完整的 MACRO.md 文件内容（含 frontmatter）
- 写盘路径
- 触发示例`,
    filePath: '',
    source: 'builtin',
  },
  {
    metadata: {
      name: 'daily-standup',
      type: 'macro',
      version: '1.0.0',
      author: 'routedev',
      keywords: ['standup', 'daily', 'morning', '站会', '每日'],
      description: '每日站会汇报模板',
      category: 'daily-work',
    },
    content: `## 适用场景
每日早会/站会时使用此宏生成结构化汇报。

## 工作流程
1. 回顾昨日完成事项
2. 列出今日计划事项
3. 标记当前阻塞与风险
4. 提出需要的协助

## 输出格式
\`\`\`
【昨日完成】
- ...

【今日计划】
- ...

【阻塞/风险】
- ...

【需要协助】
- ...
\`\`\``,
    filePath: '',
    source: 'builtin',
  },
  {
    metadata: {
      name: 'code-review',
      type: 'macro',
      version: '1.0.0',
      author: 'routedev',
      keywords: ['review', 'code', 'audit', '审查', '代码'],
      description: '代码审查标准流程',
      category: 'code-quality',
    },
    content: `## 适用场景
当需要审查一段代码或一个 PR 时使用此宏。

## 工作流程
1. 读取待审查的代码（文件引用 / diff）
2. 检查代码风格与规范
3. 检查潜在 Bug 与边界条件
4. 检查测试覆盖
5. 检查安全风险（注入、敏感信息泄漏、SSRF 等）
6. 检查性能与可维护性
7. 输出审查报告

## 输出格式
- **结论**：approval / conditional / rejected
- **问题列表**：按严重程度排序（blocking / warning / nit）
- **改进建议**：可操作的具体建议`,
    filePath: '',
    source: 'builtin',
  },
  {
    metadata: {
      name: 'commit-message',
      type: 'macro',
      version: '1.0.0',
      author: 'routedev',
      keywords: ['commit', 'message', 'git', '提交', '信息'],
      description: '生成规范提交信息',
      category: 'code-quality',
    },
    content: `## 适用场景
当需要为当前的代码变更生成规范的 Git 提交信息时使用此宏。

## 工作流程
1. 通过 git diff / git status 读取变更
2. 识别变更类型（feat / fix / refactor / docs / test / chore / perf / style）
3. 识别变更范围（scope）
4. 生成简明扼要的描述
5. 如有破坏性变更，标记 BREAKING CHANGE
6. 如有必要，补充详细说明

## 输出格式
遵循 Conventional Commits 规范：

\`\`\`
<type>(<scope>): <subject>

<body>

<footer>
\`\`\`

## 注意事项
- subject 不超过 50 字符
- body 每行不超过 72 字符
- 一个提交只做一件事`,
    filePath: '',
    source: 'builtin',
  },
];

/** 按名称获取内置宏 */
export function getBuiltinMacro(name: string): Macro | undefined {
  return BUILTIN_MACROS.find((m) => m.metadata.name === name);
}
