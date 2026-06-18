// tests/agent/init/init.test.ts
// InitAnalyzer 单元测试（fallback 模式，无 LLM）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InitAnalyzer } from '../../../src/agent/init-analyzer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../../src/router/types.js';

function makeFailingClient(): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async () => { throw new Error('no LLM'); }),
    stream: vi.fn(async function* () { /* */ }),
  };
}

function makeMockClient(response: string): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
      content: response,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    })),
    stream: vi.fn(async function* () { /* */ }),
  };
}

describe('InitAnalyzer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-init-'));
    // 创建一个 mock 项目
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      name: 'test', version: '1.0.0', dependencies: { react: '^18.0.0', typescript: '^5.0.0' },
    }));
    fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export {};');
    fs.writeFileSync(path.join(tempDir, 'src', 'App.tsx'), 'export default function App() { return null; }');
    fs.mkdirSync(path.join(tempDir, 'tests'));
    fs.writeFileSync(path.join(tempDir, 'tests', 'index.test.ts'), 'test');
    fs.mkdirSync(path.join(tempDir, 'node_modules'));
    fs.writeFileSync(path.join(tempDir, 'node_modules', 'junk.js'), 'ignored');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should analyze project structure', async () => {
    const analyzer = new InitAnalyzer({
      llmClient: makeFailingClient(),
      modelId: 'test',
      rootPath: tempDir,
    });
    const info = await analyzer.analyze();
    expect(info.fileTree).toContain('package.json');
    expect(info.fileTree).toContain('tsconfig.json');
    expect(info.fileTree).toContain('App.tsx');
    // 应当忽略 node_modules
    expect(info.fileTree).toContain('已忽略');
    expect(info.keyFiles.length).toBeGreaterThanOrEqual(2);
    expect(info.detectedFrameworks).toContain('React');
    expect(info.detectedFrameworks).toContain('TypeScript');
    expect(info.primaryLanguage).toBe('TypeScript');
    expect(info.hasTests).toBe(true);
  });

  it('should generate fallback rules when LLM fails', async () => {
    const analyzer = new InitAnalyzer({
      llmClient: makeFailingClient(),
      modelId: 'test',
      rootPath: tempDir,
    });
    const info = await analyzer.analyze();
    const rules = await analyzer.generateRules(info);
    expect(rules).toContain('# .routedev-rules.md');
    expect(rules).toContain('TypeScript');
    expect(rules).toContain('React');
    expect(rules).toContain('fallback');
  });

  it('should use LLM-generated rules on success', async () => {
    const analyzer = new InitAnalyzer({
      llmClient: makeMockClient('## 编码规范\n- 使用 TypeScript strict 模式'),
      modelId: 'test',
      rootPath: tempDir,
    });
    const info = await analyzer.analyze();
    const rules = await analyzer.generateRules(info);
    expect(rules).toContain('TypeScript strict 模式');
    expect(rules).toContain('项目信息');
  });

  it('should save rules to file', async () => {
    const analyzer = new InitAnalyzer({
      llmClient: makeFailingClient(),
      modelId: 'test',
      rootPath: tempDir,
    });
    const info = await analyzer.analyze();
    const rules = await analyzer.generateRules(info);
    const filePath = await analyzer.saveRules(rules);
    expect(filePath).toContain('.routedev-rules.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('.routedev-rules.md');
  });
});
