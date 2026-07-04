// src/agent/context/user-profile-loader.ts
// Phase 71 Task D2：用户偏好加载器
// 加载顺序：项目级 .routedev/user_profile.md > 全局 ~/.routedev/user_profile.md
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { countTokens } from '../../code-map/token-counter.js';

export interface UserProfile {
  /** 原始 markdown 内容 */
  raw: string;
  /** tiktoken 精确 token 数 */
  tokens: number;
  /** 加载来源路径（用于调试） */
  sourcePath: string;
}

/**
 * 加载用户偏好 profile
 *
 * 查找顺序：
 * 1. 项目级：{cwd}/.routedev/user_profile.md
 * 2. 全局级：{homedir}/.routedev/user_profile.md
 *
 * 找到第一个存在的文件即返回；都找不到返回 null（fail-open，不阻塞主流程）
 *
 * @param cwd 工作目录（默认 process.cwd()）
 * @returns UserProfile 或 null
 */
export async function loadUserProfile(cwd: string = process.cwd()): Promise<UserProfile | null> {
  const candidates = [
    path.join(cwd, '.routedev', 'user_profile.md'),
    path.join(os.homedir(), '.routedev', 'user_profile.md'),
  ];
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      if (content.trim().length === 0) continue; // 空文件跳过
      return {
        raw: content,
        tokens: countTokens(content),
        sourcePath: p,
      };
    } catch {
      continue; // 文件不存在或无权限，尝试下一个
    }
  }
  return null;
}
