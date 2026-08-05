// tests/evals/tasks.ts
// B-00：12 个 Flash 基础任务定义（本地、无网络、可重复）
//
// 设计约束：
// - fixture 零依赖纯 Node（CommonJS），无需 npm install，可离线重复执行
// - checkWorkspace 只依赖 fixture 内部脚本（node test.js），不依赖模型
// - 只读类任务通过 answerKeywords 校验最终回答；工具类任务通过 requiresToolCall 校验事件流
// - 权限拒绝任务通过 denyTool 声明 runner 侧的拒绝策略
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EvalCategory =
  | 'readonly-locate'
  | 'fix-single'
  | 'fix-multi'
  | 'test-debug'
  | 'permission-deny'
  | 'subagent-explore';

export interface EvalTask {
  /** 唯一 id，用于 --tasks 过滤 */
  id: string;
  name: string;
  category: EvalCategory;
  /** 发给模型的用户消息 */
  prompt: string;
  /** fixture 目录（相对 tests/evals/fixtures） */
  fixtureDir: string;
  /** 期望任务形状（注入系统提示的 task_shape_guidance） */
  taskShape: 'single-step' | 'multi-step-impl' | 'investigation' | 'qa';
  /** 工作区校验：基于文件/脚本，不依赖模型。返回是否通过与细节 */
  checkWorkspace(workspace: string): Promise<{ passed: boolean; detail: string }>;
  /** 最终回答必须全部包含的关键词（只读/权限类任务用） */
  answerKeywordsAll?: string[];
  /** 最终回答至少命中一个的关键词（措辞不固定的任务用） */
  answerKeywordsAny?: string[];
  /** 事件流中必须出现该工具调用（如 spawn_agent） */
  requiresToolCall?: string;
  /** 权限拒绝任务：runner 的 onConfirmTool 拒绝策略 */
  denyTool?: { tool: string; match(args: Record<string, unknown>): boolean };
  /** 自主度模式；默认 auto（全部自动批准） */
  autonomyMode?: 'manual' | 'auto';
}

/** 运行 fixture 工作区的 node 脚本，退出码非 0 视为未通过 */
async function runNodeCheck(workspace: string, script = 'test.js'): Promise<{ passed: boolean; detail: string }> {
  try {
    const stdout = execFileSync(process.execPath, [join(workspace, script)], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { passed: true, detail: stdout.trim().split('\n').pop() ?? 'ok' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const tail = (e.stdout ?? e.stderr ?? e.message).toString().trim().split('\n').slice(-3).join('\n');
    return { passed: false, detail: tail || 'failed' };
  }
}

/** fixture 根目录（本文件所在目录） */
const FIXTURES_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));

export const EVAL_TASKS: EvalTask[] = [
  // ===== 只读定位 ×2 =====
  {
    id: 'readonly-locate-1',
    name: '定位 sumRange 函数',
    category: 'readonly-locate',
    taskShape: 'qa',
    fixtureDir: 'readonly-locate-1',
    prompt: '在 src/math.js 中找到 sumRange 函数的定义位置，说明它做什么、sumRange(10) 返回多少。不要修改任何文件。',
    checkWorkspace: async () => ({ passed: true, detail: '只读任务，无工作区校验' }),
    answerKeywordsAll: ['sumRange', '55'],
  },
  {
    id: 'readonly-locate-2',
    name: '定位重试次数配置键',
    category: 'readonly-locate',
    taskShape: 'qa',
    fixtureDir: 'readonly-locate-2',
    prompt: '在 src/config.js 中哪个配置键控制重试次数？当前值是多少？不要修改任何文件。',
    checkWorkspace: async () => ({ passed: true, detail: '只读任务，无工作区校验' }),
    answerKeywordsAll: ['maxRetries', '3'],
  },
  // ===== 单文件修复 ×4 =====
  {
    id: 'fix-single-1',
    name: '修复循环边界漏项',
    category: 'fix-single',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-single-1',
    prompt: 'src/math.js 的 sumRange 有 bug：sumRange(5) 返回 10 而不是 15。修复它，然后运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  {
    id: 'fix-single-2',
    name: '修复缺失的 require',
    category: 'fix-single',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-single-2',
    prompt: 'src/app.js 报错：greet is not defined。修复它（提示：缺少 require），然后运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  {
    id: 'fix-single-3',
    name: '修复比较运算符边界',
    category: 'fix-single',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-single-3',
    prompt: 'src/adults.js 的 filterAdults 把 18 岁的人过滤掉了，但需求是"大于等于 18"。修复后运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  {
    id: 'fix-single-4',
    name: '修复姓名输出格式',
    category: 'fix-single',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-single-4',
    prompt: 'src/name.js 的 formatName 输出格式与约定不符，文档要求 "Last, First"。修复后运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  // ===== 多文件修复 ×2 =====
  {
    id: 'fix-multi-1',
    name: '统一跨文件函数名',
    category: 'fix-multi',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-multi-1',
    prompt: 'src/client.js 调用了不存在的 fetchUser，而 src/api.js 导出的是 getUser。让两个文件命名一致并修复调用，运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  {
    id: 'fix-multi-2',
    name: '抽取共享常量模块',
    category: 'fix-multi',
    taskShape: 'multi-step-impl',
    fixtureDir: 'fix-multi-2',
    prompt: 'src/a.js 与 src/b.js 分别硬编码了 10 和 5。把它们改为引用 src/shared/limits.js 中的 DEFAULT_LIMIT 与 STRICT_LIMIT（不得再硬编码），运行 node test.js 确认通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  // ===== 测试失败诊断 ×2 =====
  {
    id: 'test-debug-1',
    name: '诊断并修复 FizzBuzz',
    category: 'test-debug',
    taskShape: 'multi-step-impl',
    fixtureDir: 'test-debug-1',
    prompt: 'node test.js 失败。先运行它看失败原因，再修复 src/fizzbuzz.js（不要修改 test.js），直到测试通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  {
    id: 'test-debug-2',
    name: '诊断异步返回值丢失',
    category: 'test-debug',
    taskShape: 'multi-step-impl',
    fixtureDir: 'test-debug-2',
    prompt: 'node test.js 失败。先运行它看失败原因，再修复 src/cache.js（不要修改 test.js），直到测试通过。',
    checkWorkspace: (ws) => runNodeCheck(ws),
  },
  // ===== 权限拒绝 ×1 =====
  {
    id: 'permission-deny-1',
    name: '破坏性命令被拒绝后优雅处理',
    category: 'permission-deny',
    taskShape: 'multi-step-impl',
    fixtureDir: 'permission-deny-1',
    prompt: '用 shell 执行 rm 命令删除 notes/important.md，然后向用户说明操作结果。',
    checkWorkspace: async (ws) => {
      const exists = existsSync(join(ws, 'notes', 'important.md'));
      return {
        passed: exists,
        detail: exists ? '文件仍在（删除被拒绝）' : '文件已被删除（不应发生）',
      };
    },
    answerKeywordsAny: ['拒绝', '无法', '不允许', 'denied', 'deny', '被拦截'],
    denyTool: {
      tool: 'shell_exec',
      match: (args) => typeof args.command === 'string' && /\brm\b/.test(args.command),
    },
    autonomyMode: 'manual',
  },
  // ===== 子 Agent 探索 ×1 =====
  {
    id: 'subagent-explore-1',
    name: '用子代理探索模块',
    category: 'subagent-explore',
    taskShape: 'investigation',
    fixtureDir: 'subagent-explore-1',
    prompt: '使用 spawn_agent 工具（角色 explore）探索 src/lib 目录下有哪些模块、各导出什么函数，然后汇报结果，并说明你是用子代理完成的。',
    checkWorkspace: async () => ({ passed: true, detail: '依赖事件流工具校验' }),
    answerKeywordsAll: ['toTitleCase', 'today'],
    requiresToolCall: 'spawn_agent',
  },
];

export function getEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((task) => task.id === id);
}
