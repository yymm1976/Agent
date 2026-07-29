// src/tools/builtin/bom-utils.ts
// BOM（Byte Order Mark）检测与保留工具
//
// Phase 96 P1-3 修复：file-edit/file-write/file-read 三工具原先依赖 Node.js 默认 utf-8
// 解码器自动剥离 BOM（U+FEFF），导致带 BOM 的 Windows 历史遗留文件（如 .ps1 / .cs / 旧
// .sln）编辑后 BOM 静默丢失。本模块提供统一的 BOM 检测与回写能力。
//
// 使用方式：
//   1. 读取文件时用 readWithBomInfo() 获取 { content, hadBom }
//   2. 写回文件时用 writeWithBomInfo(path, content, hadBom) 按原状态保留 BOM
//   3. file_read 工具可在 metadata 中暴露 hadBom 供上层感知

import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';

/** UTF-8 BOM 字节序列：0xEF 0xBB 0xBF */
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
/** UTF-8 BOM 字符串形式（U+FEFF） */
const UTF8_BOM_CHAR = '\uFEFF';

export interface BomInfo {
  /** 文件内容（已剥离 BOM，纯 utf-8 文本） */
  content: string;
  /** 原文件是否带 BOM */
  hadBom: boolean;
}

/**
 * 读取文件并检测 BOM 状态
 *
 * 与 fs.readFile(path, 'utf-8') 的差异：
 *   - 前者：Node 自动剥离 BOM，但调用方无法感知文件是否带 BOM
 *   - 本函数：显式检测前 3 字节是否为 0xEF 0xBB 0xBF，返回 hadBom 标志
 *
 * 写回时配合 writeWithBomInfo() 即可保留原 BOM 状态
 */
export async function readWithBomInfo(filePath: string): Promise<BomInfo> {
  const buf = await fs.readFile(filePath);
  const hadBom = buf.length >= 3 &&
    buf[0] === UTF8_BOM_BYTES[0] &&
    buf[1] === UTF8_BOM_BYTES[1] &&
    buf[2] === UTF8_BOM_BYTES[2];
  // 跳过 BOM 字节后解码为 utf-8 字符串
  const contentBuf = hadBom ? buf.subarray(3) : buf;
  return {
    content: contentBuf.toString('utf-8'),
    hadBom,
  };
}

/**
 * 按指定 BOM 状态写入文件
 *
 * @param filePath 目标路径
 * @param content 文本内容（不含 BOM，本函数会按 hadBom 决定是否前置 BOM）
 * @param hadBom 是否前置 UTF-8 BOM
 */
export async function writeWithBomInfo(
  filePath: string,
  content: string,
  hadBom: boolean,
): Promise<void> {
  if (hadBom) {
    // 用 Buffer 拼接确保 BOM 字节正确写入
    const contentBuf = Buffer.from(content, 'utf-8');
    const fullBuf = Buffer.concat([UTF8_BOM_BYTES, contentBuf]);
    await fs.writeFile(filePath, fullBuf);
  } else {
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

/**
 * 同步检测字符串是否以 BOM 开头
 *
 * 用于在已读入内存的字符串上快速判断 BOM（不触发文件 I/O）
 */
export function startsWithBom(content: string): boolean {
  return content.length > 0 && content.charCodeAt(0) === 0xfeff;
}

/**
 * 剥离字符串开头的 BOM（若存在）
 */
export function stripBom(content: string): string {
  return startsWithBom(content) ? content.slice(1) : content;
}

/**
 * 按原文件 BOM 状态决定是否前置 BOM 到字符串
 *
 * 与 writeWithBomInfo 配对：当用 fs.writeFile(path, stringContent) 写入时使用
 */
export function restoreBom(content: string, hadBom: boolean): string {
  return hadBom ? UTF8_BOM_CHAR + content : content;
}
