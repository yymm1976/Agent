// src/security/integrity-manifest.ts
// 依赖完整性校验模块
//
// 设计目标：
//   1. 管理外部依赖（Skill / Claude Plugin / Anthropic Skills）的 SHA-256 checksum 清单
//   2. 在依赖安装/导入/加载时计算 SHA-256 并记录到 manifest
//   3. 下次加载时校验文件完整性，检测篡改
//   4. fail-open：manifest 文件不存在时 record 创建新文件；verify 时无记录返回 ok=true（首次信任）
//   5. 流式读取大文件，避免一次性 readFile 占用内存
//
// manifestPath 由调用方传入，不写死路径，便于测试与多项目隔离

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 单条完整性记录 */
export interface IntegrityRecord {
  /** 文件绝对路径（作为 key） */
  path: string;
  /** SHA-256 hex 摘要 */
  sha256: string;
  /** 记录时间（ms 时间戳） */
  recordedAt: number;
  /** 来源标注（如 'skill-market' / 'claude-plugin' / 'anthropic-skills'） */
  source?: string;
}

/** manifest 持久化结构 */
interface IntegrityManifestFile {
  version: 1;
  records: Record<string, IntegrityRecord>;
}

/** verify 返回结果 */
export interface VerifyResult {
  /** 是否通过校验 */
  ok: boolean;
  /** manifest 中记录的期望摘要（无记录时为 undefined） */
  expected?: string;
  /** 实际计算的摘要 */
  actual: string;
}

// ============================================================
// IntegrityManifest 主类
// ============================================================

/**
 * 依赖完整性校验清单
 *
 * 用法：
 *   const manifest = new IntegrityManifest('/path/to/integrity-manifest.json');
 *   await manifest.load();  // 首次不存在时 records 为空
 *   await manifest.record('/path/to/skill/SKILL.md', 'skill-market');
 *   await manifest.save();
 *   const result = await manifest.verify('/path/to/skill/SKILL.md');
 *   if (!result.ok) { // 篡改处理 }
 *
 * 设计要点：
 *   - manifestPath 不写死，由调用方传入
 *   - fail-open：文件不存在/解析失败时返回空记录，不抛错
 *   - verify 无记录时返回 ok=true（首次加载信任）
 *   - SHA-256 用流式读取，支持大文件
 */
export class IntegrityManifest {
  /** 内存中的记录索引（path → record） */
  private records: Map<string, IntegrityRecord> = new Map();

  constructor(private readonly manifestPath: string) {}

  /**
   * 计算文件 SHA-256 并记录到 manifest
   *
   * @param filePath 文件绝对路径
   * @param source 来源标注（可选）
   */
  async record(filePath: string, source?: string): Promise<void> {
    const sha256 = await this.computeSha256(filePath);
    const record: IntegrityRecord = {
      path: filePath,
      sha256,
      recordedAt: Date.now(),
      source,
    };
    this.records.set(filePath, record);
  }

  /**
   * 校验文件完整性
   *
   * fail-open 策略：
   *   - manifest 中无此文件记录 → 返回 { ok: true, actual, expected: undefined }（首次信任）
   *   - 有记录且 SHA-256 匹配 → { ok: true, expected, actual }
   *   - 有记录但不匹配 → { ok: false, expected, actual }
   *
   * @param filePath 文件绝对路径
   * @returns 校验结果
   */
  async verify(filePath: string): Promise<VerifyResult> {
    const actual = await this.computeSha256(filePath);
    const record = this.records.get(filePath);
    if (!record) {
      // 无记录视为首次信任
      return { ok: true, actual, expected: undefined };
    }
    const expected = record.sha256;
    return { ok: expected === actual, expected, actual };
  }

  /**
   * 列出所有已记录的条目（便于审计/UI 展示）
   */
  list(): IntegrityRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * 持久化 manifest 到磁盘（JSON 格式）
   *
   * 自动创建父目录；fail-open：写入失败仅 warn 不抛错
   */
  async save(): Promise<void> {
    const data: IntegrityManifestFile = {
      version: 1,
      records: Object.fromEntries(this.records),
    };
    try {
      await fs.mkdir(path.dirname(this.manifestPath), { recursive: true });
      await fs.writeFile(this.manifestPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      // fail-open：IO 失败不阻塞主流程
      logger.warn('IntegrityManifest.save: failed to persist', {
        path: this.manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从磁盘加载 manifest
   *
   * fail-open 策略：
   *   - 文件不存在（ENOENT）→ 重置为空记录（首次启动）
   *   - 解析失败 → warn 并重置为空记录
   *   - 成功 → 填充 records
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf-8');
      const data = JSON.parse(raw) as IntegrityManifestFile;
      this.records = new Map(Object.entries(data.records || {}));
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        // manifest 文件不存在时返回空（fail-open，首次启动）
        this.records = new Map();
        return;
      }
      logger.warn('IntegrityManifest.load: parse failed, reset', {
        path: this.manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
      this.records = new Map();
    }
  }

  /**
   * 删除指定文件的记录（卸载时调用）
   */
  forget(filePath: string): void {
    this.records.delete(filePath);
  }

  /**
   * 判断 manifest 中是否已记录该文件
   */
  has(filePath: string): boolean {
    return this.records.has(filePath);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 流式计算文件 SHA-256
   *
   * 使用 fs.createReadStream 分块读取，避免大文件占用内存
   *
   * @param filePath 文件绝对路径
   * @returns SHA-256 hex 摘要（64 字符）
   */
  private computeSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fsSync.createReadStream(filePath);
      stream.on('data', (chunk: Buffer) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}
