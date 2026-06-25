// desktop/main/mcp-catalog.ts
// 内置 MCP 服务器市场目录（精选 20+ 流行服务器）
// 数据来源：mcp.so / Smithery / modelcontextprotocol 官方仓库
// 离线可用，无需第三方 API Key 即可浏览和安装

import type { MCPCatalogEntry, MCPCatalogResult } from '../shared/ipc-types.js';

/**
 * 内置精选 MCP 服务器目录
 * 按流行度排序，覆盖文件系统/数据库/浏览器/搜索/开发工具/通讯六大类
 */
const CATALOG: MCPCatalogEntry[] = [
  // === 文件系统类 ===
  {
    id: 'filesystem',
    displayName: 'Filesystem',
    description: '安全的文件读写、目录管理、文件搜索。允许 AI 访问指定目录下的文件。',
    category: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${WORKSPACE}'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    requiresApiKey: false,
    popularity: 100,
  },
  {
    id: 'everything',
    displayName: 'Everything Search',
    description: 'Windows Everything 文件搜索（仅 Windows）。快速全盘搜索文件和目录。',
    category: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    requiresApiKey: false,
    popularity: 40,
  },

  // === 数据库类 ===
  {
    id: 'postgres',
    displayName: 'PostgreSQL',
    description: '只读 PostgreSQL 数据库访问。支持 schema 检查和 SQL 查询（仅 SELECT）。',
    category: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'],
    requiredEnv: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    requiresApiKey: false,
    popularity: 70,
  },
  {
    id: 'sqlite',
    displayName: 'SQLite',
    description: 'SQLite 数据库操作。支持查询、写入、schema 管理和数据分析。',
    category: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '${DB_PATH}'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    requiresApiKey: false,
    popularity: 55,
  },
  {
    id: 'redis',
    displayName: 'Redis',
    description: 'Redis 数据库操作。支持键值读写、列表/哈希/集合操作。',
    category: 'database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-redis'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
    requiresApiKey: false,
    popularity: 45,
  },

  // === 浏览器自动化类 ===
  {
    id: 'puppeteer',
    displayName: 'Puppeteer',
    description: '浏览器自动化。支持页面截图、PDF 生成、表单填写、网页抓取、JavaScript 执行。',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    requiresApiKey: false,
    popularity: 75,
  },
  {
    id: 'playwright',
    displayName: 'Playwright',
    description: '微软维护的浏览器自动化（比 Puppeteer 更强）。支持多浏览器、截图、点击、填表、抓取。',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@executeautomation/playwright-mcp-server'],
    homepage: 'https://github.com/executeautomation/mcp-playwright',
    requiresApiKey: false,
    popularity: 65,
  },
  {
    id: 'browserbase',
    displayName: 'Browserbase',
    description: '远程浏览器控制（通过 Stagehand）。无需本地安装浏览器，云端运行。',
    category: 'browser',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@browserbasehq/mcp-browserbase'],
    requiredEnv: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    homepage: 'https://github.com/browserbase/mcp-browserbase',
    requiresApiKey: true,
    popularity: 35,
  },

  // === 搜索类 ===
  {
    id: 'brave-search',
    displayName: 'Brave Search',
    description: 'Brave 搜索引擎集成。支持网页搜索和本地搜索，无需 API Key 即可使用（有免费额度）。',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: ['BRAVE_API_KEY'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    requiresApiKey: true,
    popularity: 60,
  },
  {
    id: 'exa',
    displayName: 'Exa Search',
    description: 'AI 原生搜索引擎。支持实时网页搜索、LinkedIn 检索、深度研究。',
    category: 'search',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    requiredHeaders: ['x-api-key'],
    homepage: 'https://exa.ai',
    requiresApiKey: true,
    popularity: 50,
  },
  {
    id: 'fetch',
    displayName: 'Fetch',
    description: '网页抓取工具。获取 URL 内容并转为 Markdown，支持可配置的截断和分页。',
    category: 'search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    requiresApiKey: false,
    popularity: 55,
  },

  // === 开发工具类 ===
  {
    id: 'github',
    displayName: 'GitHub',
    description: 'GitHub 仓库管理。支持创建/管理 PR、Issue、代码审查、文件操作、分支管理。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    requiresApiKey: true,
    popularity: 90,
  },
  {
    id: 'gitlab',
    displayName: 'GitLab',
    description: 'GitLab 项目管理。支持 Issue、MR、管道、分支操作。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    requiredEnv: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
    requiresApiKey: true,
    popularity: 50,
  },
  {
    id: 'sentry',
    displayName: 'Sentry',
    description: 'Sentry 错误监控集成。查看项目错误、堆栈跟踪、发布追踪。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    requiredEnv: ['SENTRY_AUTH_TOKEN'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sentry',
    requiresApiKey: true,
    popularity: 40,
  },
  {
    id: 'context7',
    displayName: 'Context7',
    description: '在 IDE 内引用主流 SDK/框架的最新文档。解决 AI 使用过时 API 的问题。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    homepage: 'https://github.com/upstash/context7',
    requiresApiKey: false,
    popularity: 45,
  },
  {
    id: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    description: '结构化思考工具。引导 AI 分步推理、修正假设、动态调整思考路径。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    requiresApiKey: false,
    popularity: 50,
  },
  {
    id: 'memory',
    displayName: 'Memory',
    description: '基于知识图谱的长期记忆。支持实体、关系、观察的存储和检索。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    requiresApiKey: false,
    popularity: 55,
  },
  {
    id: 'time',
    displayName: 'Time',
    description: '时间工具。获取当前时间、时区转换、时间计算。',
    category: 'devtool',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    requiresApiKey: false,
    popularity: 35,
  },

  // === 通讯类 ===
  {
    id: 'slack',
    displayName: 'Slack',
    description: 'Slack 工作区集成。发送消息、列出频道、获取历史消息、回复线程。',
    category: 'communication',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    requiresApiKey: true,
    popularity: 55,
  },
  {
    id: 'google-drive',
    displayName: 'Google Drive',
    description: 'Google Drive 文件操作。搜索、读取、创建文档和文件夹（需要 OAuth 凭证）。',
    category: 'communication',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-drive'],
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-drive',
    requiresApiKey: true,
    popularity: 45,
  },

  // === 其他 ===
  {
    id: 'obsidian',
    displayName: 'Obsidian',
    description: 'Obsidian 笔记库访问。搜索、读取、创建笔记，支持 Markdown 格式。',
    category: 'other',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-obsidian'],
    requiredEnv: ['OBSIDIAN_API_KEY', 'OBSIDIAN_VAULT_PATH'],
    homepage: 'https://github.com/MarkusPfundstein/mcp-obsidian',
    requiresApiKey: true,
    popularity: 40,
  },
  {
    id: 'everart',
    displayName: 'EverArt',
    description: 'AI 图像生成。通过文本描述生成图像，支持多种风格模型。',
    category: 'other',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everart'],
    requiredEnv: ['EVERART_API_KEY'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everart',
    requiresApiKey: true,
    popularity: 30,
  },
];

/** 按流行度降序排序的目录副本 */
const SORTED_CATALOG = [...CATALOG].sort((a, b) => b.popularity - a.popularity);

/**
 * 列出目录（可按分类过滤）
 * @param category 可选分类过滤，不传则返回全部
 */
export function listCatalog(category?: string): MCPCatalogResult {
  const entries = category && category !== 'all'
    ? SORTED_CATALOG.filter((e) => e.category === category)
    : SORTED_CATALOG;
  return { entries, total: entries.length };
}

/**
 * 按关键词搜索目录（匹配 id/displayName/description/category）
 * @param query 搜索关键词
 */
export function searchCatalog(query: string): MCPCatalogResult {
  const q = query.trim().toLowerCase();
  if (!q) {
    return listCatalog();
  }
  const entries = SORTED_CATALOG.filter((e) =>
    e.id.toLowerCase().includes(q) ||
    e.displayName.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.category.toLowerCase().includes(q)
  );
  return { entries, total: entries.length };
}

/**
 * 根据 id 获取目录条目
 * @param id 目录条目 id
 */
export function getCatalogEntry(id: string): MCPCatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** 获取所有分类 */
export function getCategories(): string[] {
  return ['all', 'filesystem', 'database', 'browser', 'search', 'devtool', 'communication', 'other'];
}
