// tests/agent/context/offload-cleaner.test.ts
// Phase 71 Task D7：offload 文件清理机制 + Budget Offload pipeline 集成测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { ToolOutputPipeline } from '../../../src/agent/context/tool-output-pipeline.js';
import {
  cleanSessionOffload,
  cleanOrphanOffload,
  registerOffloadCleaner,
} from '../../../src/agent/context/offload-cleaner.js';

// 构造临时 offload 根目录的辅助函数
function makeTmpOffloadRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-offload-test-'));
}

// 构造超长输出
function makeLongContent(length: number): string {
  return 'x'.repeat(length);
}

describe('offload-cleaner + Budget Offload 集成', () => {
  let offloadRoot: string;

  beforeEach(() => {
    offloadRoot = makeTmpOffloadRoot();
  });

  afterEach(() => {
    // 兜底清理：防止用例失败遗留临时目录
    try {
      fs.rmSync(offloadRoot, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });

  // 用例 1：超预算工具输出写入 offload 文件
  it('超预算工具输出应写入 offload 文件', () => {
    const sessionId = 'session-1';
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: true,
      offloadDir: offloadRoot,
      maxChars: 2000,
      sessionId,
    });
    const longContent = makeLongContent(5000);
    const result = pipeline.process('read', longContent);

    expect(result.offloadedPath).toBeDefined();
    // 文件确实落盘
    expect(fs.existsSync(result.offloadedPath!)).toBe(true);
    // 文件内容等于完整原始输出
    const fileContent = fs.readFileSync(result.offloadedPath!, 'utf8');
    expect(fileContent).toBe(longContent);
    // 阶段标记正确
    expect(result.stages).toContain('budget-offload');
  });

  // 用例 2：offload 文件路径正确返回给 Agent（在截断摘要后附加）
  it('offload 文件路径应附加到截断摘要中供 Agent 引用', () => {
    const sessionId = 'session-2';
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: true,
      offloadDir: offloadRoot,
      maxChars: 2000,
      sessionId,
    });
    const longContent = makeLongContent(6000);
    const result = pipeline.process('exec', longContent);

    // 摘要中包含 offload 文件路径引用
    expect(result.output).toContain(result.offloadedPath!);
    // 摘要中包含 persisted-output 标签
    expect(result.output).toContain('<persisted-output');
    // 摘要中包含原始大小信息
    expect(result.output).toContain('size="6000"');
    // 摘要长度远小于原始内容
    expect(result.output.length).toBeLessThan(longContent.length);
  });

  // 用例 3：写入失败时 fail-open 降级到内存截断
  it('offload 写入失败时应 fail-open 降级到内存截断', () => {
    const sessionId = 'session-3';
    // 用一个不可能写入的路径触发 writeFileSync 失败
    // Windows 下 NUL 路径不可写；用嵌套不存在的根目录更稳妥
    const badOffloadDir = path.join(offloadRoot, 'subdir-with-no-perm', 'deep');
    // 先确保该目录不存在且 mkdirSync 会因为父级被占用而失败：
    // 在 offloadRoot 下创建一个同名文件，让 mkdirSync(子目录) 失败
    fs.writeFileSync(path.join(offloadRoot, 'subdir-with-no-perm'), 'blocker');

    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: true,
      offloadDir: badOffloadDir,
      maxChars: 2000,
      sessionId,
    });
    const longContent = makeLongContent(5000);
    const result = pipeline.process('read', longContent);

    // 应该走 fail-open 分支：offloadedPath 未设置
    expect(result.offloadedPath).toBeUndefined();
    // 阶段标记为失败
    expect(result.stages).toContain('budget-offload-failed');
    // 输出降级为内存截断（包含截断标记）
    expect(result.output).toContain('[...truncated, offload failed...]');
    // 截断后长度远小于原始
    expect(result.output.length).toBeLessThan(longContent.length);
  });

  // 用例 4：清理指定 sessionId 的 offload 文件
  it('cleanSessionOffload 应清理指定 session 的 offload 目录', () => {
    const sessionId = 'session-to-clean';
    const sessionDir = path.join(offloadRoot, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'read-1.txt'), 'content-1');
    fs.writeFileSync(path.join(sessionDir, 'exec-2.txt'), 'content-2');

    // 清理前目录存在
    expect(fs.existsSync(sessionDir)).toBe(true);

    cleanSessionOffload(offloadRoot, sessionId);

    // 清理后目录不存在
    expect(fs.existsSync(sessionDir)).toBe(false);

    // 其他 session 不受影响
    const otherSession = path.join(offloadRoot, 'other-session');
    fs.mkdirSync(otherSession, { recursive: true });
    fs.writeFileSync(path.join(otherSession, 'data.txt'), 'keep-me');
    cleanSessionOffload(offloadRoot, sessionId);
    expect(fs.existsSync(otherSession)).toBe(true);
  });

  // 用例 5：清理 7 天前的孤儿文件
  it('cleanOrphanOffload 应清理超过 7 天的孤儿目录', () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const oldSession = path.join(offloadRoot, 'old-session');
    const freshSession = path.join(offloadRoot, 'fresh-session');
    fs.mkdirSync(oldSession, { recursive: true });
    fs.mkdirSync(freshSession, { recursive: true });
    fs.writeFileSync(path.join(oldSession, 'a.txt'), 'old');
    fs.writeFileSync(path.join(freshSession, 'b.txt'), 'fresh');

    // 把 oldSession 的 mtime 改成 8 天前
    const oldTime = new Date(Date.now() - eightDaysMs(sevenDaysMs));
    fs.utimesSync(oldSession, oldTime, oldTime);

    cleanOrphanOffload(offloadRoot);

    // 老目录被清理
    expect(fs.existsSync(oldSession)).toBe(false);
    // 新目录保留
    expect(fs.existsSync(freshSession)).toBe(true);
  });

  // 用例 6：清理钩子异常不导致进程崩溃
  it('registerOffloadCleaner 钩子异常不应导致进程崩溃', () => {
    // 用一个不可能存在的根目录注册钩子
    // registerOffloadCleaner 启动时会调 cleanOrphanOffload（fail-open 不抛）
    // 然后注册 beforeExit/SIGINT/SIGTERM 钩子
    const badDir = path.join(
      os.tmpdir(),
      'routedev-non-existent-' + Date.now(),
      'nested',
    );
    expect(() => {
      const dispose = registerOffloadCleaner('crash-test-session', badDir);
      // 反注册以隔离测试（避免污染进程级钩子）
      dispose();
    }).not.toThrow();

    // 验证 cleanSessionOffload 对不存在目录也不抛
    expect(() => {
      cleanSessionOffload(badDir, 'non-existent-session');
    }).not.toThrow();

    // 验证 cleanOrphanOffload 对"offloadDir 是文件"这种异常场景也不抛
    const fileAsDir = path.join(offloadRoot, 'iam-a-file');
    fs.writeFileSync(fileAsDir, 'not a directory');
    expect(() => {
      cleanOrphanOffload(fileAsDir);
    }).not.toThrow();
  });
});

// 构造 8 天的毫秒数（略大于 7 天阈值，确保触发清理）
function eightDaysMs(sevenDaysMs: number): number {
  return sevenDaysMs + 24 * 60 * 60 * 1000;
}
