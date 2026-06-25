// src/skills/code-style-analyzer.ts
// Phase 39 Task 2：代码风格分析器
//
// 设计目标：
//   1. 扫描项目 src/ 下的 .ts/.js/.tsx/.jsx 文件
//   2. 提取风格特征（注释语言、引号、缩进、命名、测试框架、常用工具、错误处理）
//   3. 根据特征生成对应的 Skill（让 Agent 在写代码时遵循项目既有风格）
//
// 性能约束：
//   - 最多扫描 100 个文件（避免大项目分析超时）
//   - 单文件最大 100KB（避免扫描压缩文件）
//   - 仅静态文本分析，不做 AST 解析（保持轻量）

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { GeneratedSkill } from './skill-generator.js';

// ============================================================
// 类型定义
// ============================================================

/** 代码风格特征 */
export interface CodeStyleFeatures {
  /** 注释语言 */
  commentLanguage: 'chinese' | 'english' | 'mixed' | 'none';
  /** 引号风格 */
  quoteStyle: 'single' | 'double' | 'mixed';
  /** 缩进风格 */
  indentStyle: 'space-2' | 'space-4' | 'tab' | 'mixed';
  /** 命名规范 */
  namingConvention: 'camelCase' | 'snake_case' | 'PascalCase' | 'mixed';
  /** 测试框架（从 package.json 检测） */
  testFramework?: string;
  /** 被多次 import 的内部模块 */
  commonUtils: string[];
  /** 错误处理方式 */
  errorHandling: 'try-catch' | 'promise-catch' | 'result-type' | 'mixed' | 'none';
}

// ============================================================
// 常量
// ============================================================

/** 支持的源码文件扩展名 */
const SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];

/** 最多扫描的文件数 */
const MAX_FILES = 100;

/** 单文件最大字节数（100KB） */
const MAX_FILE_SIZE = 100 * 1024;

/** 中文 Unicode 范围（基本汉字 + 扩展 A） */
const CHINESE_REGEX = /[\u4e00-\u9fff]/g;

/** 英文字母（用于注释语言判定） */
const ENGLISH_LETTER_REGEX = /[a-zA-Z]/g;

// ============================================================
// CodeStyleAnalyzer
// ============================================================

/**
 * 代码风格分析器
 *
 * 用法：
 *   const analyzer = new CodeStyleAnalyzer('/path/to/project');
 *   const features = await analyzer.analyze();
 *   const skill = analyzer.generateSkillFromFeatures(features);
 */
export class CodeStyleAnalyzer {
  constructor(private rootDir: string) {}

  /**
   * 扫描项目代码，提取风格特征
   *
   * 步骤：
   *   1. 扫描 src/ 下的 .ts/.js/.tsx/.jsx 文件（最多 100 个）
   *   2. 检测注释语言：统计注释行中中文字符占比
   *   3. 检测引号习惯：统计 ' vs " 出现频率
   *   4. 检测缩进风格：检测行首空白（2空格/4空格/tab）
   *   5. 检测命名规范：检测变量声明名模式
   *   6. 检测测试框架：读 package.json devDependencies
   *   7. 检测常用工具函数：统计 import 语句
   *   8. 检测错误处理方式：统计 try-catch / .catch / Result 类型
   */
  async analyze(): Promise<CodeStyleFeatures> {
    logger.debug('CodeStyleAnalyzer: starting', { rootDir: this.rootDir });

    const files = await this.collectSourceFiles();
    logger.debug('CodeStyleAnalyzer: files collected', { count: files.length });

    // 并行读取所有文件内容
    const contents: string[] = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(file, 'utf-8');
        contents.push(content);
      } catch {
        // 跳过读取失败的文件
      }
    }

    // 检测各类特征
    const commentLanguage = this.detectCommentLanguage(contents);
    const quoteStyle = this.detectQuoteStyle(contents);
    const indentStyle = this.detectIndentStyle(contents);
    const namingConvention = this.detectNamingConvention(contents);
    const commonUtils = this.detectCommonUtils(contents);
    const errorHandling = this.detectErrorHandling(contents);
    const testFramework = await this.detectTestFramework();

    const features: CodeStyleFeatures = {
      commentLanguage,
      quoteStyle,
      indentStyle,
      namingConvention,
      testFramework,
      commonUtils,
      errorHandling,
    };

    logger.info('CodeStyleAnalyzer: analysis complete', { features });
    return features;
  }

  /**
   * 根据分析结果生成 Skill
   *
   * 将特征转换为 SKILL.md 内容，让 Agent 在写代码时遵循项目既有风格
   */
  generateSkillFromFeatures(features: CodeStyleFeatures): GeneratedSkill {
    const sections: string[] = [];

    sections.push(`## 注释语言\n- 注释使用${this.commentLanguageLabel(features.commentLanguage)}`);

    sections.push(`## 引号风格\n- 字符串使用${this.quoteStyleLabel(features.quoteStyle)}`);

    sections.push(`## 缩进风格\n- 使用${this.indentStyleLabel(features.indentStyle)}`);

    sections.push(`## 命名规范\n- 变量与函数使用${this.namingConventionLabel(features.namingConvention)}`);

    if (features.testFramework) {
      sections.push(`## 测试框架\n- 使用 ${features.testFramework} 编写测试`);
    }

    if (features.commonUtils.length > 0) {
      const utilsList = features.commonUtils.map((u) => `- 优先复用 \`${u}\``).join('\n');
      sections.push(`## 常用工具函数\n${utilsList}`);
    }

    sections.push(`## 错误处理\n- 使用${this.errorHandlingLabel(features.errorHandling)}`);

    const content = sections.join('\n\n');

    return {
      name: 'project-code-style',
      description: '项目代码风格规范，让 Agent 在写代码时遵循既有风格',
      routingKeywords: [
        '写代码', '新建文件', '实现', '编码', 'refactor', '重构',
        'create', 'implement', 'add function', '新建函数', '新建类',
      ],
      content,
    };
  }

  // ============================================================
  // 文件收集
  // ============================================================

  /**
   * 收集 src/ 下的源码文件
   *   - 递归扫描 src/ 目录
   *   - 最多 MAX_FILES 个
   *   - 跳过 node_modules / dist / build
   */
  private async collectSourceFiles(): Promise<string[]> {
    const srcDir = path.join(this.rootDir, 'src');
    const files: string[] = [];

    const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', '.routedev']);

    async function walk(dir: string): Promise<void> {
      if (files.length >= MAX_FILES) return;
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
            files.push(full);
          }
        }
      }
    }

    await walk(srcDir);
    return files;
  }

  // ============================================================
  // 特征检测
  // ============================================================

  /**
   * 检测注释语言
   *
   * 策略：
   *   - 提取所有 // 和 /* * / 注释行
   *   - 统计中文字符数 vs 英文字母数
   *   - 中文占比 > 70% → chinese
   *   - 英文占比 > 70% → english
   *   - 都不达 70% → mixed
   *   - 无注释 → none
   */
  private detectCommentLanguage(contents: string[]): CodeStyleFeatures['commentLanguage'] {
    let chineseCount = 0;
    let englishCount = 0;
    let commentLines = 0;

    for (const content of contents) {
      const lines = content.split('\n');
      for (const line of lines) {
        // 单行注释 //
        const singleMatch = line.match(/\/\/\s*(.*)$/);
        if (singleMatch) {
          const comment = singleMatch[1];
          const cn = (comment.match(CHINESE_REGEX) ?? []).length;
          const en = (comment.match(ENGLISH_LETTER_REGEX) ?? []).length;
          if (cn > 0 || en > 0) {
            chineseCount += cn;
            englishCount += en;
            commentLines++;
          }
        }
        // 多行注释行（简化处理：以 * 开头的行）
        const blockMatch = line.match(/^\s*\*\s*(.*)$/);
        if (blockMatch) {
          const comment = blockMatch[1];
          const cn = (comment.match(CHINESE_REGEX) ?? []).length;
          const en = (comment.match(ENGLISH_LETTER_REGEX) ?? []).length;
          if (cn > 0 || en > 0) {
            chineseCount += cn;
            englishCount += en;
            commentLines++;
          }
        }
      }
    }

    if (commentLines === 0) return 'none';

    const total = chineseCount + englishCount;
    if (total === 0) return 'none';

    const chineseRatio = chineseCount / total;
    const englishRatio = englishCount / total;

    if (chineseRatio > 0.7) return 'chinese';
    if (englishRatio > 0.7) return 'english';
    return 'mixed';
  }

  /**
   * 检测引号习惯
   *
   * 策略：
   *   - 统计字符串字面量中 ' 和 " 的出现频率
   *   - 排除转义引号
   *   - 单一占比 > 70% → 对应风格
   *   - 否则 → mixed
   */
  private detectQuoteStyle(contents: string[]): CodeStyleFeatures['quoteStyle'] {
    let singleCount = 0;
    let doubleCount = 0;

    for (const content of contents) {
      // 匹配单引号字符串（简化版：'xxx'，不含转义）
      const singleMatches = content.match(/(^|[^\\])'(?:[^'\\]|\\.)*'/g);
      if (singleMatches) singleCount += singleMatches.length;

      // 匹配双引号字符串
      const doubleMatches = content.match(/(^|[^\\])"(?:[^"\\]|\\.)*"/g);
      if (doubleMatches) doubleCount += doubleMatches.length;
    }

    const total = singleCount + doubleCount;
    if (total === 0) return 'single'; // 默认单引号

    if (singleCount / total > 0.7) return 'single';
    if (doubleCount / total > 0.7) return 'double';
    return 'mixed';
  }

  /**
   * 检测缩进风格
   *
   * 策略：
   *   - 统计行首空白模式（2空格 / 4空格 / tab）
   *   - 排除空行和顶格行
   *   - 单一占比 > 70% → 对应风格
   *   - 否则 → mixed
   */
  private detectIndentStyle(contents: string[]): CodeStyleFeatures['indentStyle'] {
    let space2 = 0;
    let space4 = 0;
    let tab = 0;

    for (const content of contents) {
      const lines = content.split('\n');
      for (const line of lines) {
        // 跳过空行和顶格行
        if (!line.startsWith(' ') && !line.startsWith('\t')) continue;
        if (line.trim().length === 0) continue;

        if (line.startsWith('\t')) {
          tab++;
        } else if (line.startsWith('    ')) {
          space4++;
        } else if (line.startsWith('  ')) {
          space2++;
        }
      }
    }

    const total = space2 + space4 + tab;
    if (total === 0) return 'space-2'; // 默认 2 空格

    if (space2 / total > 0.7) return 'space-2';
    if (space4 / total > 0.7) return 'space-4';
    if (tab / total > 0.7) return 'tab';
    return 'mixed';
  }

  /**
   * 检测命名规范
   *
   * 策略：
   *   - 统计变量声明（const/let/var）的名称模式
   *   - camelCase:^[a-z][a-zA-Z0-9]*$
   *   - snake_case:^[a-z][a-z0-9_]*$ 且含 _
   *   - PascalCase:^[A-Z][a-zA-Z0-9]*$
   *   - 单一占比 > 70% → 对应风格
   *   - 否则 → mixed
   */
  private detectNamingConvention(contents: string[]): CodeStyleFeatures['namingConvention'] {
    let camel = 0;
    let snake = 0;
    let pascal = 0;

    for (const content of contents) {
      // 匹配 const/let/var 声明
      const matches = content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g);
      for (const m of matches) {
        const name = m[1];
        // 跳过全大写常量（如 MAX_SIZE）
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        // 跳过单字符变量
        if (name.length < 2) continue;

        if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name.slice(1))) {
          camel++;
        } else if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) {
          snake++;
        } else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
          pascal++;
        } else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
          // 单词小写也算 camelCase（如 `name`）
          camel++;
        }
      }
    }

    const total = camel + snake + pascal;
    if (total === 0) return 'camelCase'; // 默认 camelCase

    if (camel / total > 0.7) return 'camelCase';
    if (snake / total > 0.7) return 'snake_case';
    if (pascal / total > 0.7) return 'PascalCase';
    return 'mixed';
  }

  /**
   * 检测测试框架
   *
   * 策略：
   *   - 读 package.json 的 devDependencies
   *   - 优先级：vitest > jest > mocha > jasmine > ava > tape
   */
  private async detectTestFramework(): Promise<string | undefined> {
    try {
      const pkgPath = path.join(this.rootDir, 'package.json');
      const pkgRaw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { devDependencies?: Record<string, string> };
      const devDeps = pkg.devDependencies ?? {};

      const frameworks = ['vitest', 'jest', 'mocha', 'jasmine', 'ava', 'tape'];
      for (const fw of frameworks) {
        if (devDeps[fw]) return fw;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 检测常用工具函数
   *
   * 策略：
   *   - 统计 import 语句中的相对路径模块
   *   - 出现次数 >= 3 的模块视为常用工具
   *   - 返回模块名列表（最多 10 个）
   */
  private detectCommonUtils(contents: string[]): string[] {
    const importCounts = new Map<string, number>();

    for (const content of contents) {
      // 匹配 import ... from './xxx' 或 import ... from '../xxx'
      const matches = content.matchAll(
        /import\s+(?:[\s\S]*?)\s+from\s+['"](\.\.?\/[^'"]+)['"]/g,
      );
      for (const m of matches) {
        const importPath = m[1];
        // 取文件名（不含扩展名）作为模块名
        const basename = path.basename(importPath).replace(/\.(ts|js|tsx|jsx)$/, '');
        if (basename.length === 0) continue;
        importCounts.set(basename, (importCounts.get(basename) ?? 0) + 1);
      }
    }

    // 过滤出现次数 >= 3 的模块，按次数降序排序
    const common = Array.from(importCounts.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name);

    return common;
  }

  /**
   * 检测错误处理方式
   *
   * 策略：
   *   - try-catch：统计 try { } catch 出现次数
   *   - promise-catch：统计 .catch( 出现次数
   *   - result-type：统计 Result< 或 Either< 类型注解
   *   - 单一占比 > 70% → 对应风格
   *   - 否则 → mixed
   *   - 都为 0 → none
   */
  private detectErrorHandling(contents: string[]): CodeStyleFeatures['errorHandling'] {
    let tryCatch = 0;
    let promiseCatch = 0;
    let resultType = 0;

    for (const content of contents) {
      const tryMatches = content.match(/\btry\s*\{/g);
      if (tryMatches) tryCatch += tryMatches.length;

      const catchMatches = content.match(/\.catch\s*\(/g);
      if (catchMatches) promiseCatch += catchMatches.length;

      const resultMatches = content.match(/\b(?:Result|Either)<[^>]+>/g);
      if (resultMatches) resultType += resultMatches.length;
    }

    const total = tryCatch + promiseCatch + resultType;
    if (total === 0) return 'none';

    if (tryCatch / total > 0.7) return 'try-catch';
    if (promiseCatch / total > 0.7) return 'promise-catch';
    if (resultType / total > 0.7) return 'result-type';
    return 'mixed';
  }

  // ============================================================
  // 标签生成（用于 generateSkillFromFeatures）
  // ============================================================

  private commentLanguageLabel(lang: CodeStyleFeatures['commentLanguage']): string {
    const labels: Record<CodeStyleFeatures['commentLanguage'], string> = {
      chinese: '中文注释',
      english: '英文注释',
      mixed: '中英文混合注释',
      none: '注释（当前项目无注释，建议补充）',
    };
    return labels[lang];
  }

  private quoteStyleLabel(style: CodeStyleFeatures['quoteStyle']): string {
    const labels: Record<CodeStyleFeatures['quoteStyle'], string> = {
      single: '单引号 \'\'',
      double: '双引号 ""',
      mixed: '单双引号混合（建议统一）',
    };
    return labels[style];
  }

  private indentStyleLabel(style: CodeStyleFeatures['indentStyle']): string {
    const labels: Record<CodeStyleFeatures['indentStyle'], string> = {
      'space-2': '2 空格缩进',
      'space-4': '4 空格缩进',
      tab: 'Tab 缩进',
      mixed: '混合缩进（建议统一）',
    };
    return labels[style];
  }

  private namingConventionLabel(conv: CodeStyleFeatures['namingConvention']): string {
    const labels: Record<CodeStyleFeatures['namingConvention'], string> = {
      camelCase: 'camelCase 驼峰命名',
      snake_case: 'snake_case 下划线命名',
      PascalCase: 'PascalCase 大驼峰命名',
      mixed: '混合命名（建议统一）',
    };
    return labels[conv];
  }

  private errorHandlingLabel(eh: CodeStyleFeatures['errorHandling']): string {
    const labels: Record<CodeStyleFeatures['errorHandling'], string> = {
      'try-catch': 'try-catch 同步错误捕获',
      'promise-catch': '.catch() Promise 错误捕获',
      'result-type': 'Result/Either 类型返回错误',
      mixed: '混合错误处理方式',
      none: '错误处理（当前项目缺少错误处理，建议补充）',
    };
    return labels[eh];
  }
}
