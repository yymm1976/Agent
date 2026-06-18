// tests/agent/vision-security.test.ts
// VisionAssistant.loadImage 路径遍历安全测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VisionAssistant } from '../../src/agent/vision.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** 创建临时目录作为隔离的 projectRoot */
async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-vision-sec-'));
}

/** 写入一个最小合法 PNG 文件（1x1 透明像素） */
async function writePng(filePath: string, content: Buffer = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C63000100000005000100' +
  '0D0A2DB40000000049454E44AE426082',
  'hex',
)): Promise<void> {
  await fs.writeFile(filePath, content);
}

describe('VisionAssistant.loadImage - 路径遍历安全', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await makeTempRoot();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('应拦截指向项目根目录之外的路径遍历攻击（../../etc/passwd 风格）', async () => {
    // 构造一个明显越界的相对路径
    const traversalPath = path.join(tempRoot, '..', '..', '..', '..', 'etc', 'passwd.png');
    const result = await VisionAssistant.loadImage(traversalPath, tempRoot);
    expect(result).toBeNull();
  });

  it('应拦截 Windows 风格的 .. 相对路径越界', async () => {
    // 使用纯 .. 拼接的路径，确保最终落在 tempRoot 之外
    const evilPath = path.join(tempRoot, '..', '..', 'evil.png');
    const result = await VisionAssistant.loadImage(evilPath, tempRoot);
    expect(result).toBeNull();
  });

  it('应允许加载项目目录内的合法图片文件', async () => {
    const imgPath = path.join(tempRoot, 'screenshot.png');
    await writePng(imgPath);

    const result = await VisionAssistant.loadImage(imgPath, tempRoot);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/png');
    expect(result!.fileName).toBe('screenshot.png');
    // base64 数据应为非空字符串
    expect(typeof result!.data).toBe('string');
    expect(result!.data.length).toBeGreaterThan(0);
  });

  it('应允许加载项目子目录内的图片', async () => {
    const subDir = path.join(tempRoot, 'assets', 'deep');
    await fs.mkdir(subDir, { recursive: true });
    const imgPath = path.join(subDir, 'pic.png');
    await writePng(imgPath);

    const result = await VisionAssistant.loadImage(imgPath, tempRoot);
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('pic.png');
  });

  it('当未传入 projectRoot 时，应以 process.cwd() 为边界', async () => {
    // 在 tempRoot 下创建文件，但以 process.cwd() 为边界
    // 由于 tempRoot 通常在 process.cwd() 之外，应被拦截
    const imgPath = path.join(tempRoot, 'outside.png');
    await writePng(imgPath);

    // tempRoot 一般位于系统临时目录，不在项目 cwd 内
    const cwd = process.cwd();
    const outside = !path.resolve(tempRoot).startsWith(path.resolve(cwd) + path.sep);
    // 仅在 tempRoot 确实在 cwd 之外时才做断言，避免环境差异导致误判
    if (outside) {
      const result = await VisionAssistant.loadImage(imgPath);
      expect(result).toBeNull();
    }
  });

  it('应允许 projectRoot 自定义为图片所在的临时目录', async () => {
    const imgPath = path.join(tempRoot, 'allowed.png');
    await writePng(imgPath);

    // 显式传入 tempRoot 作为 projectRoot，应允许加载
    const result = await VisionAssistant.loadImage(imgPath, tempRoot);
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('allowed.png');
  });

  it('应拒绝不支持的图片扩展名（即使路径合法）', async () => {
    const imgPath = path.join(tempRoot, 'notimage.txt');
    await fs.writeFile(imgPath, 'hello');

    const result = await VisionAssistant.loadImage(imgPath, tempRoot);
    expect(result).toBeNull();
  });

  it('应拒绝不存在的文件（路径合法但文件不存在）', async () => {
    const imgPath = path.join(tempRoot, 'missing.png');
    const result = await VisionAssistant.loadImage(imgPath, tempRoot);
    expect(result).toBeNull();
  });
});
