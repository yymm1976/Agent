// tests/integration/phase47-task1.test.ts
// Phase 47 Task 1 集成测试：AGENTS.md 瘦身与按需加载验证
//
// 测试策略：
//   1. 瘦身后的 AGENTS.md ≤ 120 行
//   2. pitfalls-guide SKILL.md 包含全部 71 条陷阱（用关键词覆盖验证）
//   3. SKILL.md 的 description 包含触发场景关键词（PermissionEngine/AgentLoop/Checkpoint 等）
//   4. AGENTS.md 正文 Top 10 陷阱与 SKILL.md 内容一致（编号 #11/#14/#16/#18/#23/#27/#45/#54/#60/#62 均在 SKILL.md 中存在）
//   5. AGENTS.md 保留技术栈/关键入口/项目约定三段
//   6. SKILL.md frontmatter 包含 name: pitfalls-guide
//   7. AGENTS.md 末尾包含「完整陷阱索引」指向 pitfalls-guide Skill

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================
// 路径常量
// ============================================================

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_MD_PATH = path.join(PROJECT_ROOT, 'AGENTS.md');
const SKILL_MD_PATH = path.join(
  PROJECT_ROOT,
  '.routedev',
  'skills',
  'pitfalls-guide',
  'SKILL.md',
);

// ============================================================
// 工具函数
// ============================================================

/** 读取文件内容并返回 { content, lines } */
async function readFileLines(
  filePath: string,
): Promise<{ content: string; lines: string[] }> {
  const content = await fs.readFile(filePath, 'utf-8');
  // 按 \n 拆分，过滤末尾空行（文件末尾的换行符产生的空串）
  const lines = content.split(/\r?\n/);
  // 移除末尾空串（文件以换行结尾时产生）
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { content, lines };
}

/** 提取 YAML frontmatter 中的 description 字段值 */
function extractDescription(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return '';
  const fm = fmMatch[1];
  // 匹配 description: 后面的内容（可能跨行，直到下一个 key 或 frontmatter 结束）
  const descMatch = fm.match(/description:\s*(.+)/);
  if (!descMatch) return '';
  // 简单提取单行 description（本项目 SKILL.md 均为单行）
  return descMatch[1].trim();
}

// ============================================================
// 1. AGENTS.md 瘦身后 ≤ 120 行
// ============================================================
describe('Phase 47 Task 1 - AGENTS.md 瘦身', () => {
  it('AGENTS.md 行数 ≤ 120', async () => {
    const { lines } = await readFileLines(AGENTS_MD_PATH);
    expect(lines.length).toBeLessThanOrEqual(120);
  });

  it('AGENTS.md 保留「技术栈」段落', async () => {
    const { content } = await readFileLines(AGENTS_MD_PATH);
    expect(content).toContain('## 技术栈');
    // 技术栈段必须包含关键技术标识
    expect(content).toContain('TypeScript');
    expect(content).toContain('Vitest');
    expect(content).toContain('pnpm');
  });

  it('AGENTS.md 保留「关键入口」段落', async () => {
    const { content } = await readFileLines(AGENTS_MD_PATH);
    expect(content).toContain('## 关键入口');
    // 关键入口段必须包含核心入口文件
    expect(content).toContain('src/index.tsx');
    expect(content).toContain('src/cli/App.tsx');
    expect(content).toContain('src/cli/service-context.ts');
    expect(content).toContain('src/cli/app-init.ts');
  });

  it('AGENTS.md 保留「项目约定」段落', async () => {
    const { content } = await readFileLines(AGENTS_MD_PATH);
    expect(content).toContain('## 项目约定');
    // 项目约定段必须包含核心约定
    expect(content).toContain('Conventional Commits');
    expect(content).toContain('路径别名');
    expect(content).toContain('导入后缀');
  });
});

// ============================================================
// 2. pitfalls-guide SKILL.md 包含全部 71 条陷阱
// ============================================================
describe('Phase 47 Task 1 - pitfalls-guide SKILL.md 完整性', () => {
  it('SKILL.md 文件存在', async () => {
    const stat = await fs.stat(SKILL_MD_PATH);
    expect(stat.isFile()).toBe(true);
  });

  it('SKILL.md 包含全部 71 条陷阱（按 Phase 章节关键词验证）', async () => {
    const { content } = await readFileLines(SKILL_MD_PATH);

    // 验证每个 Phase 的章节标题存在
    const expectedSections = [
      '## Phase 17b + Phase 0c（陷阱 1-13）',
      '## Phase 29（陷阱 14-19',
      '## Phase 30（陷阱 20-22',
      '## Phase 31（陷阱 23-34',
      '## Phase 32（陷阱 35-40',
      '## Phase 33（陷阱 41-44',
      '## Phase 35（陷阱 45-48',
      '## Phase 36（陷阱 49-54',
      '## Phase 37（陷阱 55-59',
      '## Phase 38（陷阱 60-64',
      '## Phase 46（陷阱 126-132',
    ];
    for (const section of expectedSections) {
      expect(content).toContain(section);
    }

    // 验证关键陷阱编号存在（覆盖 1-64 + 126-132 的代表性编号）
    const expectedNumbers = [
      '1. `ModelRouter.route()`', // 陷阱 1
      '13. **App.tsx 装配已收敛**', // 陷阱 13
      '14. **命令解析必须走', // 陷阱 14
      '19. **LLM 客户端 API Key', // 陷阱 19
      '23. **TaskOrchestrator', // 陷阱 23
      '34. **智能截断的 findErrorRegions', // 陷阱 34
      '40. **chat-runner 传项目上下文', // 陷阱 40
      '44. **SettingsPage 版本号不可硬编码', // 陷阱 44
      '48. **TrajectoryExporter', // 陷阱 48
      '54. **Tool/Skill 的 description', // 陷阱 54
      '59. **采纳实验时的 merge conflict', // 陷阱 59
      '64. **知识图谱持久化文件', // 陷阱 64
      '126. **IPC handler 桥接', // 陷阱 126
      '132. **HookMarketManager 接线', // 陷阱 132
    ];
    for (const num of expectedNumbers) {
      expect(content).toContain(num);
    }
  });
});

// ============================================================
// 3. SKILL.md 的 description 包含触发场景关键词
// ============================================================
describe('Phase 47 Task 1 - SKILL.md description 触发关键词', () => {
  it('description 包含全部触发场景关键词', async () => {
    const { content } = await readFileLines(SKILL_MD_PATH);
    const description = extractDescription(content);
    expect(description.length).toBeGreaterThan(0);

    // 任务要求的关键词：PermissionEngine/AgentLoop/Checkpoint/Blackboard/
    // HookRunner/MCPClientManager/ToolExecutor/TaskOrchestrator/ReadTracker 等
    const requiredKeywords = [
      'PermissionEngine',
      'AgentLoop',
      'Checkpoint',
      'Blackboard',
      'HookRunner',
      'MCPClientManager',
      'ToolExecutor',
      'TaskOrchestrator',
      'ReadTracker',
    ];
    for (const kw of requiredKeywords) {
      expect(description).toContain(kw);
    }
  });

  it('SKILL.md frontmatter 包含 name: pitfalls-guide', async () => {
    const { content } = await readFileLines(SKILL_MD_PATH);
    // frontmatter 必须包含 name: pitfalls-guide
    expect(content).toMatch(/^name:\s*pitfalls-guide\s*$/m);
  });
});

// ============================================================
// 4. AGENTS.md Top 10 陷阱与 SKILL.md 内容一致
// ============================================================
describe('Phase 47 Task 1 - Top 10 陷阱一致性', () => {
  it('AGENTS.md 的 Top 10 陷阱编号在 SKILL.md 中均存在', async () => {
    const { content: agentsContent } = await readFileLines(AGENTS_MD_PATH);
    const { content: skillContent } = await readFileLines(SKILL_MD_PATH);

    // AGENTS.md 中 Top 10 引用的编号
    const top10Ids = ['#11', '#14', '#16', '#18', '#23', '#27', '#45', '#54', '#60', '#62'];
    for (const id of top10Ids) {
      // AGENTS.md 中必须引用此编号
      expect(agentsContent).toContain(id);
    }

    // SKILL.md 中必须存在对应的陷阱条目（按编号开头）
    // 陷阱 11/14/16/18/23/27/45/54/60/62 在 SKILL.md 中以 "数字. " 开头
    const skillEntries = [
      '11. **权限检查走 PermissionEngine 中间件**',
      '14. **命令解析必须走 `parseCommand()` tokenize**',
      '16. **环境变量替换 fail-fast**',
      '18. **Rollback 前置工作区检查**',
      '23. **TaskOrchestrator 是 App.tsx 的新调度层**',
      '27. **ReadTracker 追踪的是绝对路径**',
      '45. **HookRunner 在 app-init.ts 中必须传入 TraceCollector**',
      '54. **Tool/Skill 的 description 写法决定 80% 匹配效果**',
      '60. **中间件阶段顺序不可随意调整**',
      '62. **子 Agent 的 ToolRegistry 是父 Agent 的浅拷贝**',
    ];
    for (const entry of skillEntries) {
      expect(skillContent).toContain(entry);
    }
  });

  it('AGENTS.md Top 10 陷阱标题与 SKILL.md 中对应条目标题一致', async () => {
    const { content: agentsContent } = await readFileLines(AGENTS_MD_PATH);
    const { content: skillContent } = await readFileLines(SKILL_MD_PATH);

    // 抽取 AGENTS.md Top 10 中的加粗标题（**xxx**）
    const agentsBoldTitles = agentsContent
      .match(/\*\*[^*]+\*\*/g) ?? [];
    // 抽取 SKILL.md 中的加粗标题
    const skillBoldTitles = skillContent
      .match(/\*\*[^*]+\*\*/g) ?? [];

    // 关键标题必须在两个文件中都出现（Top 10 核心标题）
    const sharedTitles = [
      '**权限检查走 PermissionEngine 中间件**',
      '**命令解析必须走 `parseCommand()` tokenize**',
      '**环境变量替换 fail-fast**',
      '**Rollback 前置工作区检查**',
      '**TaskOrchestrator 是 App.tsx 的新调度层**',
      '**ReadTracker 追踪的是绝对路径**',
      '**HookRunner 在 app-init.ts 中必须传入 TraceCollector**',
      '**Tool/Skill 的 description 写法决定 80% 匹配效果**',
      '**中间件阶段顺序不可随意调整**',
      '**子 Agent 的 ToolRegistry 是父 Agent 的浅拷贝**',
    ];
    for (const title of sharedTitles) {
      expect(agentsBoldTitles).toContain(title);
      expect(skillBoldTitles).toContain(title);
    }
  });
});

// ============================================================
// 5. AGENTS.md 末尾包含「完整陷阱索引」指向 pitfalls-guide Skill
// ============================================================
describe('Phase 47 Task 1 - 完整陷阱索引指向', () => {
  it('AGENTS.md 包含「完整陷阱索引」段落', async () => {
    const { content } = await readFileLines(AGENTS_MD_PATH);
    expect(content).toContain('## 完整陷阱索引');
  });

  it('AGENTS.md 指向 pitfalls-guide SKILL.md 路径', async () => {
    const { content } = await readFileLines(AGENTS_MD_PATH);
    expect(content).toContain('.routedev/skills/pitfalls-guide/SKILL.md');
  });
});
