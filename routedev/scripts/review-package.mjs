// scripts/review-package.mjs
// Phase 75-A1：Review Package 预生成脚本
// 借鉴 Superpowers v6 scripts/review-package：reviewer subagent 不再自跑 git，
// 由本脚本提前生成 review package（commit list + stat + diff -U10），
// reviewer 一次 Read 该文件即可。
//
// 用法：node scripts/review-package.mjs <base> <head> [output-dir]
//   base       dispatch 前记录的 commit SHA（禁止 HEAD~N，多 commit 任务会截断）
//   head       当前 HEAD commit SHA
//   output-dir 默认 .routedev/review/（相对当前工作目录解析）
//
// 退出码：0 = 成功（stdout 输出生成的文件绝对路径），1 = 失败（stderr 输出错误信息）

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import simpleGit from 'simple-git';

/**
 * 输出错误信息到 stderr 并以退出码 1 退出
 * @param {string} msg - 错误信息
 * @returns {never}
 */
function fail(msg) {
  process.stderr.write(`[review-package] 错误：${msg}\n`);
  process.exit(1);
}

/**
 * 校验给定 ref 在仓库中存在且解析为 commit 对象
 * @param {import('simple-git').SimpleGit} git - simple-git 实例
 * @param {string} ref - 用户传入的 ref（SHA 或可解析引用）
 * @returns {Promise<string>} 完整 40 位 commit SHA
 * @throws {Error} 当 ref 不存在或不是 commit 时抛出
 */
async function verifyCommit(git, ref) {
  // 用 git cat-file -t 校验存在性及对象类型
  let type;
  try {
    type = await git.raw(['cat-file', '-t', ref]);
  } catch (err) {
    throw new Error(
      `commit 校验失败：'${ref}' 不存在或无法解析（${err.message}）`,
    );
  }
  if (type.trim() !== 'commit') {
    throw new Error(
      `'${ref}' 不是 commit 对象（cat-file -t 返回：${type.trim()}）`,
    );
  }
  // 取完整 SHA，避免后续命令对短 SHA / 引用产生歧义
  const full = await git.raw(['rev-parse', '--verify', `${ref}^{commit}`]);
  return full.trim();
}

/**
 * 生成时间戳后缀（本地时区），格式 YYYYMMDD-HHMMSS
 * @returns {string}
 */
function timestampSuffix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 主流程：解析参数 → 校验仓库与 commit → 生成 review package 文件
 * @returns {Promise<void>}
 */
async function main() {
  const [, , baseArg, headArg, outputDirArg] = process.argv;

  // 1. 参数数量校验
  if (!baseArg || !headArg) {
    fail(
      `参数不足。用法：node scripts/review-package.mjs <base> <head> [output-dir]`,
    );
  }

  // 2. 关键约束：禁止 HEAD~N 形式作为 base（多 commit 任务会截断）
  if (baseArg.startsWith('HEAD~')) {
    fail(
      `base 禁止使用 'HEAD~N' 形式（多 commit 任务会截断）。` +
        `请传入 dispatch 前记录的具体 commit SHA，收到：${baseArg}`,
    );
  }

  const cwd = process.cwd();
  const git = simpleGit(cwd);

  // 3. 必须在 git 仓库内执行
  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) fail(`当前目录不是 git 仓库：${cwd}`);
  } catch (err) {
    fail(`git 仓库检测失败：${err.message}`);
  }

  // 4. 校验 base/head 存在且为 commit，并取得完整 SHA
  let baseFull;
  let headFull;
  try {
    baseFull = await verifyCommit(git, baseArg);
    headFull = await verifyCommit(git, headArg);
  } catch (err) {
    fail(err.message);
  }

  // 5. 取短 SHA 前 7 位用于文件命名
  const base7 = baseFull.slice(0, 7);
  const head7 = headFull.slice(0, 7);

  // 6. 确保输出目录存在（recursive mkdir），默认 .routedev/review/
  const outputDir = path.resolve(cwd, outputDirArg ?? '.routedev/review');
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    fail(`创建输出目录失败：${outputDir}（${err.message}）`);
  }

  // 7. 输出文件名按 range 命名；re-review 不覆盖旧文件，已存在则附加时间戳后缀
  let outputFile = path.join(outputDir, `review-${base7}..${head7}.diff`);
  try {
    await access(outputFile);
    // 文件已存在 → 附加时间戳，避免覆盖旧 review 记录
    outputFile = path.join(
      outputDir,
      `review-${base7}..${head7}.${timestampSuffix()}.diff`,
    );
  } catch {
    // 文件不存在，使用原路径（access 抛错即代表不存在）
  }

  // 8. 抓取三段内容：commit list / diff --stat / diff -U10
  //    统一使用完整 SHA，避免用户传入的短 SHA / 引用在边界场景产生歧义
  const range = `${baseFull}..${headFull}`;
  let commits;
  let stat;
  let diff;
  try {
    commits = await git.raw(['log', '--oneline', range]);
  } catch (err) {
    fail(`git log --oneline ${range} 失败：${err.message}`);
  }
  try {
    stat = await git.raw(['diff', '--stat', range]);
  } catch (err) {
    fail(`git diff --stat ${range} 失败：${err.message}`);
  }
  try {
    diff = await git.raw(['diff', '-U10', range]);
  } catch (err) {
    fail(`git diff -U10 ${range} 失败：${err.message}`);
  }

  // 9. 拼接 review package：三段，用 markdown 二级标题分隔
  const content =
    `## Commits\n${commits.trimEnd()}\n\n` +
    `## Files changed\n${stat.trimEnd()}\n\n` +
    `## Diff\n${diff.trimEnd()}\n`;

  try {
    await writeFile(outputFile, content, 'utf-8');
  } catch (err) {
    fail(`写入文件失败：${outputFile}（${err.message}）`);
  }

  // 10. 成功：stdout 输出文件绝对路径，供调用方读取
  process.stdout.write(`${outputFile}\n`);
  process.exit(0);
}

main().catch((err) => {
  fail(`未预期错误：${err?.stack ?? err?.message ?? err}`);
});
