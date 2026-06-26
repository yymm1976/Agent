// src/agent/init-analyzer.ts
// InitAnalyzer：分析项目结构，生成 .routedev-rules.md

import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from '../router/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

interface ProjectInfo {
  /** 项目根目录 */
  rootPath: string;
  /** 文件结构（树形） */
  fileTree: string;
  /** 关键文件内容（package.json, tsconfig.json 等） */
  keyFiles: Array<{ path: string; content: string }>;
  /** 检测到的框架/库 */
  detectedFrameworks: string[];
  /** 主要语言 */
  primaryLanguage: string;
  /** 是否有测试框架 */
  hasTests: boolean;
}

interface InitAnalyzerOptions {
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 模型 ID */
  modelId: string;
  /** 项目根目录 */
  rootPath?: string;
  /** 最大扫描深度 */
  maxDepth?: number;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '.vscode', '.idea', 'target', 'out', '.claude', '.routedev',
  'venv', '.venv', '__pycache__', 'env',
]);

const KEY_FILES = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
  'README.md', 'README.zh.md', 'routedev.yaml', 'routedev.yml',
];

const FRAMEWORK_SIGNATURES: Array<{ name: string; patterns: Array<{ file: string; key: string }> }> = [
  { name: 'React', patterns: [
    { file: 'package.json', key: '"react"' },
  ] },
  { name: 'Vue', patterns: [
    { file: 'package.json', key: '"vue"' },
  ] },
  { name: 'Next.js', patterns: [
    { file: 'package.json', key: '"next"' },
  ] },
  { name: 'Express', patterns: [
    { file: 'package.json', key: '"express"' },
  ] },
  { name: 'Hono', patterns: [
    { file: 'package.json', key: '"hono"' },
  ] },
  { name: 'TypeScript', patterns: [
    { file: 'tsconfig.json', key: '' },
  ] },
  { name: 'Vitest', patterns: [
    { file: 'package.json', key: '"vitest"' },
  ] },
  { name: 'Jest', patterns: [
    { file: 'package.json', key: '"jest"' },
  ] },
  { name: 'Mocha', patterns: [
    { file: 'package.json', key: '"mocha"' },
  ] },
];

const TEST_PATTERNS = [
  /__tests__\//, /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/,
  /tests?\//, /test_.*\.py$/, /.*_test\.go$/,
];

const LANGUAGE_SIGNATURES: Array<{ name: string; extensions: string[] }> = [
  { name: 'TypeScript', extensions: ['.ts', '.tsx'] },
  { name: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  { name: 'Python', extensions: ['.py'] },
  { name: 'Rust', extensions: ['.rs'] },
  { name: 'Go', extensions: ['.go'] },
  { name: 'Java', extensions: ['.java'] },
  { name: 'Kotlin', extensions: ['.kt'] },
  { name: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.h'] },
  { name: 'C#', extensions: ['.cs'] },
];

export class InitAnalyzer {
  private client: ILLMClient;
  private modelId: string;
  private rootPath: string;
  private maxDepth: number;

  constructor(options: InitAnalyzerOptions) {
    this.client = options.llmClient;
    this.modelId = options.modelId;
    this.rootPath = options.rootPath ?? process.cwd();
    this.maxDepth = options.maxDepth ?? 4;
  }

  async analyze(): Promise<ProjectInfo> {
    const fileTree = await this.buildFileTree(this.rootPath, 0);
    const keyFiles = await this.readKeyFiles(this.rootPath);
    const detectedFrameworks = this.detectFrameworks(keyFiles);
    const primaryLanguage = this.detectPrimaryLanguage(fileTree);
    const hasTests = this.detectTests(fileTree);

    return {
      rootPath: this.rootPath,
      fileTree,
      keyFiles,
      detectedFrameworks,
      primaryLanguage,
      hasTests,
    };
  }

  async generateRules(info: ProjectInfo): Promise<string> {
    const prompt = this.buildPrompt(info);
    const request: LLMRequestOptions = {
      model: this.modelId,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: [
        '你是一个项目分析专家。',
        '根据用户提供的项目结构信息，生成一份 .routedev-rules.md 文件内容。',
        '文件应包含：',
        '- 项目概述（语言、框架、用途）',
        '- 目录结构说明',
        '- 开发约定（编码风格、命名规范）',
        '- 常用命令（构建、测试、运行）',
        '- 关键文件说明',
        '输出 Markdown 格式，不要用代码块包裹。',
      ].join('\n'),
      maxTokens: 2000,
      temperature: 0.3,
    };

    try {
      const response = await this.client.complete(request);
      return this.formatRules(response.content, info);
    } catch (error) {
      logger.warn('LLM failed, using fallback rules', { error: String(error) });
      return this.fallbackRules(info);
    }
  }

  private formatRules(llmContent: string, info: ProjectInfo): string {
    return [
      '# .routedev-rules.md',
      '',
      `> 由 RouteDev 自动生成于 ${new Date().toLocaleString('zh-CN')}`,
      '',
      '## 项目信息',
      `- 主要语言: ${info.primaryLanguage}`,
      `- 检测到框架: ${info.detectedFrameworks.length > 0 ? info.detectedFrameworks.join(', ') : '无'}`,
      `- 包含测试: ${info.hasTests ? '是' : '否'}`,
      '',
      '---',
      '',
      '## AI 生成的项目规则',
      '',
      llmContent.trim(),
    ].join('\n');
  }

  fallbackRules(info: ProjectInfo): string {
    return [
      '# .routedev-rules.md',
      '',
      `> 由 RouteDev 自动生成于 ${new Date().toLocaleString('zh-CN')}（fallback 模式）`,
      '',
      '## 项目信息',
      `- 主要语言: ${info.primaryLanguage}`,
      `- 检测到框架: ${info.detectedFrameworks.length > 0 ? info.detectedFrameworks.join(', ') : '无'}`,
      `- 包含测试: ${info.hasTests ? '是' : '否'}`,
      `- 项目根目录: ${info.rootPath}`,
      '',
      '## 目录结构',
      '```',
      info.fileTree.split('\n').slice(0, 50).join('\n'),
      info.fileTree.split('\n').length > 50 ? '\n... (已截断)' : '',
      '```',
      '',
      '## 关键文件',
      ...info.keyFiles.map(f => `- \`${f.path}\``),
    ].join('\n');
  }

  async saveRules(content: string, outputPath?: string): Promise<string> {
    const filePath = outputPath ?? path.join(this.rootPath, '.routedev-rules.md');
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private buildPrompt(info: ProjectInfo): string {
    const parts: string[] = [];
    parts.push(`## 项目根目录\n${info.rootPath}\n`);
    parts.push(`## 文件结构\n${info.fileTree.split('\n').slice(0, 100).join('\n')}\n`);
    parts.push(`## 主要语言\n${info.primaryLanguage}\n`);
    parts.push(`## 检测到的框架\n${info.detectedFrameworks.join(', ') || '无'}\n`);
    if (info.keyFiles.length > 0) {
      parts.push(`## 关键文件内容（前 500 字符）\n`);
      for (const f of info.keyFiles.slice(0, 5)) {
        parts.push(`### ${f.path}\n\`\`\`\n${f.content.slice(0, 500)}\n\`\`\`\n`);
      }
    }
    return parts.join('\n');
  }

  private async buildFileTree(dir: string, depth: number): Promise<string> {
    if (depth > this.maxDepth) return '';

    const lines: string[] = [];
    const indent = '  '.repeat(depth);
    const baseName = path.basename(dir);

    if (depth === 0) {
      lines.push(baseName);
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) {
          lines.push(`${indent}  ${entry.name}/ (已忽略)`);
          continue;
        }
        if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.routedev') {
          continue;
        }
        if (entry.isDirectory()) {
          const subTree = await this.buildFileTree(path.join(dir, entry.name), depth + 1);
          if (subTree) {
            lines.push(`${indent}${entry.name}/`);
            lines.push(subTree);
          }
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
    } catch {
      // 权限错误等，忽略
    }
    return lines.join('\n');
  }

  private async readKeyFiles(rootPath: string): Promise<Array<{ path: string; content: string }>> {
    const results: Array<{ path: string; content: string }> = [];
    for (const filename of KEY_FILES) {
      const filePath = path.join(rootPath, filename);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        results.push({ path: filename, content });
      } catch {
        // 文件不存在
      }
    }
    return results;
  }

  private detectFrameworks(keyFiles: Array<{ path: string; content: string }>): string[] {
    const found = new Set<string>();
    for (const sig of FRAMEWORK_SIGNATURES) {
      for (const pattern of sig.patterns) {
        const file = keyFiles.find(f => f.path === pattern.file);
        if (!file) continue;
        if (!pattern.key || file.content.includes(pattern.key)) {
          found.add(sig.name);
          break;
        }
      }
    }
    return [...found];
  }

  private detectPrimaryLanguage(fileTree: string): string {
    const counts: Record<string, number> = {};
    for (const lang of LANGUAGE_SIGNATURES) {
      for (const ext of lang.extensions) {
        const regex = new RegExp(`\\${ext}$`, 'm');
        const matches = fileTree.match(regex);
        if (matches) counts[lang.name] = (counts[lang.name] ?? 0) + matches.length;
      }
    }
    let best = 'Unknown';
    let max = 0;
    for (const [lang, count] of Object.entries(counts)) {
      if (count > max) {
        max = count;
        best = lang;
      }
    }
    return best;
  }

  private detectTests(fileTree: string): boolean {
    return TEST_PATTERNS.some(p => p.test(fileTree));
  }
}
