// scripts/task-brief.mjs
// Phase 75-A2：从 plan markdown 中抽取指定 task 全文，落盘为 brief 文件。
// 借鉴 Superpowers v6 的 scripts/task-brief（awk 实现），改为 Node ESM。
// 设计意图：避免把 task 文本粘贴进 controller context，subagent 仅引用 brief 路径。
//
// 用法：node scripts/task-brief.mjs <plan-file> <task-number> [output-dir]
//   plan-file    plan markdown 文件路径（相对或绝对）
//   task-number  要提取的 task 编号（1-based 正整数）
//   output-dir   输出目录，默认 .routedev/sdd/（相对工作目录）
//
// 退出码：0 = 成功（stdout 输出 brief 文件绝对路径），1 = 失败（stderr 报错）

import fs from 'node:fs';
import path from 'node:path';

// task heading 正则：## 或 ### 开头，后跟 Task N。
// 比原版 awk 的 ^#+Task 更宽松（允许 # 与 Task 之间有空格）。
const TASK_HEADING_RE = /^(#{2,3})\s+Task\s+(\d+)/;

// 围栏行正则：以 ``` 开头即视为围栏边界（含 ```javascript 等带语言标记）。
const FENCE_RE = /^```/;

/**
 * 从 plan 文本中抽取指定 task 的全文（含 task heading 行本身）。
 *
 * 核心防御：跳过 ``` 围栏内的伪 heading，避免代码块里的 # Task N 干扰抽取。
 * 实现方式：行扫描 + 围栏计数（in-fence 状态），不解析完整 markdown AST。
 *
 * @param {string} content - plan markdown 全文
 * @param {number} taskNumber - 要提取的 task 编号（1-based）
 * @returns {string | null} task 全文；未找到返回 null
 */
function extractTaskBrief(content, taskNumber) {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let found = false;
  const captured = [];

  for (const line of lines) {
    // 围栏行：切换 in-fence 状态；若已在捕获模式，计入输出
    if (FENCE_RE.test(line)) {
      if (found) captured.push(line);
      inFence = !inFence;
      continue;
    }

    // 非围栏内：检查是否为 task heading
    if (!inFence) {
      const m = line.match(TASK_HEADING_RE);
      if (m) {
        const num = Number(m[2]);
        if (found) {
          // 已在捕获中，遇到下一个 task heading → 结束
          break;
        }
        if (num === taskNumber) {
          found = true;
          captured.push(line);
          continue;
        }
      }
    }

    // 捕获模式：原样保留当前行（围栏内行也照常保留）
    if (found) {
      captured.push(line);
    }
  }

  return found ? captured.join('\n') : null;
}

/**
 * 主入口：解析参数、抽取 task、落盘。
 */
function main() {
  const [planFileArg, taskNumberArg, outputDirArg] = process.argv.slice(2);

  // 参数校验：plan-file 必须提供
  if (!planFileArg) {
    console.error('用法：node scripts/task-brief.mjs <plan-file> <task-number> [output-dir]');
    process.exit(1);
  }

  // 参数校验：task-number 必须是正整数
  if (!/^\d+$/.test(taskNumberArg ?? '') || Number(taskNumberArg) < 1) {
    console.error(`task-number 非法：${taskNumberArg ?? '(空)'}（应为正整数）`);
    process.exit(1);
  }
  const taskNumber = Number(taskNumberArg);

  // 解析路径（相对路径基于工作目录）
  const cwd = process.cwd();
  const planFile = path.resolve(cwd, planFileArg);
  const outputDir = path.resolve(cwd, outputDirArg ?? '.routedev/sdd/');

  // 校验：plan-file 必须存在且为文件
  if (!fs.existsSync(planFile) || !fs.statSync(planFile).isFile()) {
    console.error(`plan-file 不存在：${planFile}`);
    process.exit(1);
  }

  // 读取 plan 全文并抽取 task
  const content = fs.readFileSync(planFile, 'utf-8');
  const brief = extractTaskBrief(content, taskNumber);
  if (brief === null) {
    console.error(`Task ${taskNumber} not found in plan`);
    process.exit(1);
  }

  // 落盘：文件名 task-<NN>-brief.md（N 零填充到 2 位）
  const paddedN = String(taskNumber).padStart(2, '0');
  const fileName = `task-${paddedN}-brief.md`;
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, fileName);
  fs.writeFileSync(outPath, brief, 'utf-8');

  // stdout 输出 brief 文件绝对路径，供调用方读取
  console.log(outPath);
}

main();
