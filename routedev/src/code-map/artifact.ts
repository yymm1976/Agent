// src/code-map/artifact.ts
// Team-Shared Graph Artifact：索引完成后 VACUUM INTO + zstd 压缩导出共享 artifact
//
// 借鉴 codebase-memory-mcp 的 .codebase-memory/graph.db.zst 模式：
// - 全量索引完成后调用 exportArtifact，把 SQLite DB 压缩为 .routedev/code-map.db.zst 提交到 repo
// - 新机器/新分支启动时调用 importArtifact，先解压 artifact 再补 diff，避免全量重建
//
// 关键决策：
// - zstd 实现：复用 Node 24+ 内置 zlib.zstdCompressSync / zstdDecompressSync（无新依赖）
// - 压缩比门槛：≥ 8:1，否则不提交 repo（仅打日志告警，不抛错，避免阻塞索引）
// - 跨平台：zlib zstd 是纯 C 内置，Windows/Linux/macOS 行为一致

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DB } from './database.js';

/**
 * artifact 默认路径（相对 repoRoot，POSIX 风格）
 * 注：使用 POSIX 分隔符以保证 .gitattributes 规则匹配跨平台一致；
 * 实际拼绝对路径时用 path.join 自动转换分隔符
 */
export const ARTIFACT_REL_PATH = '.routedev/code-map.db.zst';

/** 运行时 DB 默认路径（相对 repoRoot，POSIX 风格） */
export const RUNTIME_DB_REL_PATH = '.routedev/code-map/code-map.db';

/** 最低压缩比（原始大小 / 压缩后大小），低于此值仅告警不阻塞 */
const MIN_COMPRESSION_RATIO = 8;

/**
 * 导出 team-shared artifact
 *
 * 流程：
 * 1. VACUUM INTO 临时文件（去碎片 + 收缩）
 * 2. 读临时文件 → zlib.zstdCompressSync 压缩 → 写入 .routedev/code-map.db.zst
 * 3. 删除临时文件
 * 4. 校验压缩比 ≥ 8:1，否则打告警日志（不抛错）
 *
 * @param db 已打开的 DatabaseSync 实例
 * @param repoRoot 仓库根目录绝对路径
 * @returns 压缩比（原始大小 / 压缩后大小）；导出失败返回 null
 */
export function exportArtifact(db: DB, repoRoot: string): { ratio: number; artifactPath: string } | null {
  const artifactPath = path.join(repoRoot, ARTIFACT_REL_PATH);
  const tmpVacuumPath = artifactPath + '.vacuum.tmp';

  // 1. VACUUM INTO 临时文件（必须在 db 连接上执行，会生成一个干净的副本）
  try {
    // 清理可能残留的临时文件
    try { fs.unlinkSync(tmpVacuumPath); } catch { /* 忽略不存在 */ }
    // VACUUM INTO 要求路径用单引号包裹，路径内的单引号需转义为 ''
    const escapedPath = tmpVacuumPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedPath}'`);
  } catch (e) {
    console.warn(`[artifact] VACUUM INTO 失败，跳过导出: ${(e as Error).message}`);
    try { fs.unlinkSync(tmpVacuumPath); } catch { /* 忽略 */ }
    return null;
  }

  // 2. 读取临时文件 → zstd 压缩 → 写入 artifact
  let originalSize = 0;
  let compressedSize = 0;
  try {
    const rawBuf = fs.readFileSync(tmpVacuumPath);
    originalSize = rawBuf.length;
    const compressed = zlib.zstdCompressSync(rawBuf);
    compressedSize = compressed.length;

    // 确保 artifact 目录存在
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, compressed);
  } catch (e) {
    console.warn(`[artifact] zstd 压缩写入失败: ${(e as Error).message}`);
    try { fs.unlinkSync(tmpVacuumPath); } catch { /* 忽略 */ }
    return null;
  }

  // 3. 删除临时文件
  try { fs.unlinkSync(tmpVacuumPath); } catch { /* 忽略 */ }

  // 4. 压缩比校验
  const ratio = compressedSize > 0 ? originalSize / compressedSize : 0;
  if (ratio < MIN_COMPRESSION_RATIO) {
    console.warn(
      `[artifact] 压缩比 ${ratio.toFixed(2)}:1 低于门槛 ${MIN_COMPRESSION_RATIO}:1，artifact 已生成但建议检查 DB 内容是否过于稀疏`,
    );
  } else {
    console.log(
      `[artifact] 导出成功: ${artifactPath} (${originalSize} -> ${compressedSize} bytes, ratio ${ratio.toFixed(2)}:1)`,
    );
  }

  return { ratio, artifactPath };
}

/**
 * 导入 team-shared artifact
 *
 * 流程：
 * 1. 检测 .routedev/code-map.db.zst 是否存在
 * 2. 不存在 → 返回 null（调用方走 fullIndex）
 * 3. 存在 → zstd 解压 → 写入 .routedev/code-map/code-map.db
 * 4. 后续调用方应执行 incrementalIndex 补 diff
 *
 * @param repoRoot 仓库根目录绝对路径
 * @returns 解压后的运行时 DB 路径；artifact 不存在返回 null
 */
export async function importArtifact(repoRoot: string): Promise<string | null> {
  const artifactPath = path.join(repoRoot, ARTIFACT_REL_PATH);
  const dbPath = path.join(repoRoot, RUNTIME_DB_REL_PATH);

  // 1. 检测 artifact 是否存在
  let artifactBuf: Buffer;
  try {
    artifactBuf = await fsp.readFile(artifactPath);
  } catch (e) {
    // artifact 不存在（ENOENT）或读取失败：调用方走 fullIndex
    // eslint-disable-next-line no-console
    console.warn(`[artifact] 读取 artifact 失败，将走全量索引: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  // 2. zstd 解压
  try {
    const decompressed = zlib.zstdDecompressSync(artifactBuf);
    // 确保运行时 DB 目录存在
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    await fsp.writeFile(dbPath, decompressed);
  } catch (e) {
    console.warn(`[artifact] zstd 解压失败，将走全量索引: ${(e as Error).message}`);
    return null;
  }

  console.log(`[artifact] 导入成功: ${artifactPath} -> ${dbPath} (${artifactBuf.length} -> 文件系统)`);
  return dbPath;
}

/**
 * 检测 artifact 是否存在（不实际导入）
 *
 * 供 indexer 决策：存在则走 importArtifact + incrementalIndex，不存在则走 fullIndex
 */
export async function artifactExists(repoRoot: string): Promise<boolean> {
  try {
    await fsp.access(path.join(repoRoot, ARTIFACT_REL_PATH));
    return true;
  } catch (e) {
    // access 失败（通常是 ENOENT），返回 false
    // eslint-disable-next-line no-console
    console.warn(`[artifact] artifactExists: 检测失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
