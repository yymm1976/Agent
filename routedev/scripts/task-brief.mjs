// scripts/task-brief.mjs
// Phase 75-A2：从 plan markdown 中抽取指定 task 全文，落盘为 brief 文件。
// Phase 75-B5：自动 prepend Global Constraints 章节到 brief 开头（机械传播）。
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

// Global Constraints heading 正则：## 或 ### 开头 + "Global Constraints"。
// 兼容 plan 中 h2（## Global Constraints）与 h3（### Global Constraints）两种写法。
const GLOBAL_CONSTRAINTS_HEADING_RE = /^(#{2,3})\s+Global\s+Constraints\s*$/;

// 任意 markdown heading 正则（h1-h6）：用于检测 Global Constraints 章节边界。
// 形如 `# X`、`## X`、`### X`（# 后须有非空内容）。
const ANY_HEADING_RE = /^#{1,6}\s+\S/;

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
 * 从 plan 文本中抽取 Global Constraints 章节内容（不含 heading 行本身）。
 *
 * Phase 75-B5：用于机械传播到每个 task brief 开头。
 *
 * 匹配规则：找到 `## Global Constraints` 或 `### Global Constraints` heading，
 * 捕获其后续行直到遇到下一个任意级别的 heading 或 EOF。
 * 围栏内的伪 heading 不算（防御代码块里的 # 开头行）。
 *
 * 向后兼容：plan 无 Global Constraints 章节 → 返回 null，调用方不 prepend。
 *
 * @param {string} content - plan markdown 全文
 * @returns {string | null} 章节内容（trimEnd 后）；未找到返回 null
 */
function extractGlobalConstraints(content) {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let found = false;
  const captured = [];

  for (const line of lines) {
    // 围栏行：切换状态；若已在捕获模式，计入输出
    if (FENCE_RE.test(line)) {
      if (found) captured.push(line);
      inFence = !inFence;
      continue;
    }

    if (!inFence) {
      if (!found) {
        // 起始：检测 Global Constraints heading
        if (GLOBAL_CONSTRAINTS_HEADING_RE.test(line)) {
          found = true;
          continue; // 跳过 heading 行本身（prepend 时用固定 ## 重发）
        }
      } else {
        // 已在捕获中，遇到下一个 heading → 结束
        if (ANY_HEADING_RE.test(line)) {
          break;
        }
      }
    }

    // 捕获模式：原样保留当前行（围栏内行也照常保留）
    if (found) {
      captured.push(line);
    }
  }

  if (!found) return null;
  // 去除尾部空行，避免 prepend 时产生多余空行
  return captured.join('\n').trimEnd();
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

  // Phase 75-B5：机械传播 Global Constraints 到 brief 开头。
  // 若 plan 含 Global Constraints 章节，prepend 到 brief；否则原样落盘（向后兼容）。
  const globalConstraints = extractGlobalConstraints(content);
  let finalBrief = brief;
  if (globalConstraints !== null && globalConstraints.length > 0) {
    finalBrief = [
      '<!-- Global Constraints（机械传播自 plan，Phase 75-B5） -->',
      '## Global Constraints',
      globalConstraints,
      '',
      '---',
      brief,
    ].join('\n');
  }

  // 落盘：文件名 task-<NN>-brief.md（N 零填充到 2 位）
  const paddedN = String(taskNumber).padStart(2, '0');
  const fileName = `task-${paddedN}-brief.md`;
  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, fileName);
  fs.writeFileSync(outPath, finalBrief, 'utf-8');

  // stdout 输出 brief 文件绝对路径，供调用方读取
  console.log(outPath);
}

main();
