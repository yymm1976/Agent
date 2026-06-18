// tests/agent/vision-phase29.test.ts
// Phase 29 Task 6：VisionAssistant 路径检查加固测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { logger } from '../../src/utils/logger.js';

// 由于 VisionAssistant.loadImage 需要实际文件，我们测试路径检查逻辑
// 通过模拟 projectRoot 和文件路径来验证 path.relative 行为

describe('VisionAssistant Phase 29 路径检查加固', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as any);
  });

  it('path.relative 应正确识别子目录', () => {
    const root = '/project';
    const file = '/project/subdir/file.png';
    const rel = path.relative(root, file);
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it('path.relative 应识别前缀匹配绕过', () => {
    // /project-secret/file 不应在 /project 内
    const root = '/project';
    const file = '/project-secret/file.png';
    const rel = path.relative(root, file);
    expect(rel.startsWith('..')).toBe(true);
  });

  it('path.relative 应识别父目录遍历', () => {
    const root = '/project';
    const file = '/project/../etc/passwd';
    const normalizedFile = path.normalize(file);
    const rel = path.relative(root, normalizedFile);
    expect(rel.startsWith('..')).toBe(true);
  });

  it('实际 loadImage 应阻止路径遍历', async () => {
    // 动态导入避免模块初始化问题
    const { VisionAssistant } = await import('../../src/agent/vision.js');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-vision-test-'));
    try {
      // 创建一个"伪兄弟目录"模拟前缀匹配绕过
      const siblingDir = tmpDir + '-secret';
      await fs.mkdir(siblingDir, { recursive: true });
      await fs.writeFile(path.join(siblingDir, 'file.png'), 'fake');

      // 以 tmpDir 为 root，尝试访问 siblingDir 中的文件
      const result = await VisionAssistant.loadImage(
        path.join(siblingDir, 'file.png'),
        tmpDir,
      );

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(tmpDir + '-secret', { recursive: true, force: true });
    }
  });
});
