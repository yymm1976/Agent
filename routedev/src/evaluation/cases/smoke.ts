// src/evaluation/cases/smoke.ts
// Phase 49 Task 5.2：Smoke 评估用例集（10 个）
//
// 设计目标（知识库蓝图 5.1）：
//   - Smoke(10)：Skill 安装/更新时运行，2 分钟内出结果
//   - 每个用例验证 RouteDev 的一个核心工具能力
//   - 用例彼此正交，单个失败不影响其他用例的判定
//
// EvalCase 接口在此导出，供 regression.ts 与 runner.ts 复用，
// 避免在 cases/ 下再开一个 types.ts（保持文件清单精简）。

/**
 * 评估用例通用结构。
 *
 * expectedBehavior 是"行为约束"而非"精确输出"——
 * 这是为了规避 LLM-as-Judge 陷阱 #5（缺少 ground truth）：
 * 用行为约束作为参考，judge 据此判定。
 */
export interface EvalCase {
  id: string;
  name: string;
  category: 'smoke' | 'regression';
  description: string;
  /** 用户输入（Agent 接收的 prompt） */
  prompt: string;
  expectedBehavior: {
    /** 期望调用的工具名 */
    toolCalls?: string[];
    /** 期望不调用的工具 */
    noToolCalls?: string[];
    /** 输出应包含的关键词（小写不敏感比较） */
    outputContains?: string[];
    /** 输出不应包含的关键词 */
    outputNotContains?: string[];
    /** 期望被修改的文件（相对工作目录） */
    fileChanged?: string[];
    /** 期望退出码 */
    exitCode?: number;
  };
  /** 超时 ms（缺省由 runner 兜底） */
  timeout?: number;
  /** 前置准备命令（在临时工作目录中执行） */
  setup?: string;
  /** 清理命令 */
  teardown?: string;
}

/**
 * Smoke 10 用例。
 *
 * 覆盖核心工具：file_read / file_write / file_search / shell_exec /
 * code_search / file_edit(replace) / file_edit(edit_lines) / repo_map /
 * code_graph_query / 多步骤工具链。
 */
export const SMOKE_CASES: EvalCase[] = [
  {
    id: 'smoke-001',
    name: '读取文件',
    category: 'smoke',
    description: '验证 file_read 工具能正确读取文件内容',
    prompt: '请读取 README.md 文件的内容并告诉我项目名称。',
    expectedBehavior: {
      toolCalls: ['file_read'],
      outputContains: ['routedev'],
      noToolCalls: ['file_write', 'file_edit', 'shell_exec'],
    },
    timeout: 30_000,
    setup: 'echo "# routedev" > README.md',
  },
  {
    id: 'smoke-002',
    name: '写入文件',
    category: 'smoke',
    description: '验证 file_write 工具能创建新文件',
    prompt: '请创建一个名为 hello.txt 的文件，内容为 "Hello RouteDev"。',
    expectedBehavior: {
      toolCalls: ['file_write'],
      fileChanged: ['hello.txt'],
      outputContains: ['hello.txt'],
      noToolCalls: ['file_read', 'shell_exec'],
    },
    timeout: 30_000,
  },
  {
    id: 'smoke-003',
    name: '搜索文件',
    category: 'smoke',
    description: '验证 file_search 工具能按通配符匹配文件',
    prompt: '搜索当前目录下所有 .md 文件，列出文件名。',
    expectedBehavior: {
      toolCalls: ['file_search'],
      outputContains: ['.md'],
      noToolCalls: ['file_edit', 'file_write'],
    },
    timeout: 30_000,
    setup: 'echo "# a" > a.md && echo "# b" > b.md',
  },
  {
    id: 'smoke-004',
    name: '执行 shell 命令',
    category: 'smoke',
    description: '验证 shell_exec 工具能执行简单命令并返回输出',
    prompt: '执行 echo smoke-ok 命令并返回输出。',
    expectedBehavior: {
      toolCalls: ['shell_exec'],
      outputContains: ['smoke-ok'],
      noToolCalls: ['file_read', 'file_write'],
    },
    timeout: 30_000,
  },
  {
    id: 'smoke-005',
    name: '代码搜索',
    category: 'smoke',
    description: '验证 code_search 工具能按语义检索代码',
    prompt: '在代码库中搜索 "评估" 相关的实现。',
    expectedBehavior: {
      toolCalls: ['code_search'],
      noToolCalls: ['file_write', 'shell_exec'],
    },
    timeout: 60_000,
  },
  {
    id: 'smoke-006',
    name: '编辑文件（search-replace）',
    category: 'smoke',
    description: '验证 file_edit 工具的 replace 模式（字符串精确替换）',
    prompt: '请把 config.txt 中的 "debug=false" 替换为 "debug=true"。',
    expectedBehavior: {
      toolCalls: ['file_edit'],
      fileChanged: ['config.txt'],
      noToolCalls: ['file_write', 'shell_exec'],
    },
    timeout: 30_000,
    setup: 'echo "debug=false" > config.txt',
  },
  {
    id: 'smoke-007',
    name: '编辑文件（行范围）',
    category: 'smoke',
    description: '验证 file_edit 工具的 edit_lines 模式（按行号范围替换）',
    prompt: '请把 lines.txt 的第 2 行替换为 "REPLACED"。',
    expectedBehavior: {
      toolCalls: ['file_edit'],
      fileChanged: ['lines.txt'],
      noToolCalls: ['file_write', 'shell_exec'],
    },
    timeout: 30_000,
    setup: 'printf "line1\\nline2\\nline3\\n" > lines.txt',
  },
  {
    id: 'smoke-008',
    name: '查看 repo map',
    category: 'smoke',
    description: '验证 repo_map 工具能输出仓库结构概览',
    prompt: '请展示当前仓库的 repo map。',
    expectedBehavior: {
      toolCalls: ['repo_map'],
      noToolCalls: ['file_write', 'file_edit'],
    },
    timeout: 60_000,
  },
  {
    id: 'smoke-009',
    name: '查询代码图',
    category: 'smoke',
    description: '验证 code_graph_query 工具能查询代码依赖关系',
    prompt: '查询当前代码库的调用图，列出主要节点。',
    expectedBehavior: {
      toolCalls: ['code_graph_query'],
      noToolCalls: ['file_write', 'file_edit'],
    },
    timeout: 60_000,
  },
  {
    id: 'smoke-010',
    name: '多步骤任务（读取→编辑→验证）',
    category: 'smoke',
    description: '验证工具链式调用：先读取、再编辑、最后再读取确认',
    prompt: '请读取 todo.txt，把其中的 "[ ]" 改成 "[x]"，然后重新读取确认修改成功。',
    expectedBehavior: {
      toolCalls: ['file_read', 'file_edit'],
      fileChanged: ['todo.txt'],
      noToolCalls: ['shell_exec'],
    },
    timeout: 60_000,
    setup: 'echo "[ ] task one" > todo.txt',
  },
];

export default SMOKE_CASES;
