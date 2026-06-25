# Phase 41 — 代码地图自研引擎升级：对标 Aider Repo Map 与 CodeGraph

> **版本目标：** v3.2.0
> **前置依赖：** Phase 39（代码地图增强双轨制）完成；Phase 40 假设已完成（ Skill/Hook 自动生成 + 分支合并 UI 已落地）
> **新增测试要求：** ≥ 50 个
> **研究依据：** Aider `aider/repomap.py`（867 行，46.6K⭐，MIT，Python，tree-sitter + PageRank + diskcache）与 CodeGraph `colbymchenry/codegraph`（53.8K⭐，MIT，TypeScript/SQLite，tree-sitter + 调用图解析 + 实时同步）官方源码与文档深度调研；RouteDev 当前 `src/tools/repo-map.ts`（Phase 39 版）逐项评估
> **核心命题：** RouteDev 当前代码地图基于正则，已覆盖 5 种语言、增量缓存、文件级影响分析，但在 AST 精度、调用关系、符号排名、实时同步上与 Aider/CodeGraph 存在代差。用户明确要求"最终效果至少比肩 Aider 和 CodeGraph"，且"MCP 总会被淘汰"。本 Phase 不再依赖外部 MCP，而是在 RouteDev 内部构建一个自研的 tree-sitter 代码知识图谱引擎，目标是：**精度 ≥ Aider Repo Map，查询效率与功能覆盖 ≥ CodeGraph，且与 RouteDev 的 KnowledgeGraph、TokenTracker、ContextInjector 深度耦合形成差异化。**

---

## 研究背景：为什么当前正则方案必须升级

### 1. RouteDev 当前代码地图的真实能力（基于 `src/tools/repo-map.ts` 逐项审计）

当前实现是 Phase 34/39 叠加后的结果，约 760 行 TypeScript：

**已具备能力：**

| 能力 | 实现方式 | 状态 |
|------|---------|------|
| 目录扫描 | `walkDir` + 扩展名白名单 | 可用 |
| 符号提取 | 按行正则匹配（TS/JS/Python/Java/Go） | 可用但脆弱 |
| export 识别 | 正则匹配 `export function/class/const` 等 | 较完整 |
| 非导出函数识别 | 正则匹配 `function foo()` / `const foo = () =>` | 部分 |
| 类方法识别 | `inClass` 状态机 + 行级正则 | 脆弱 |
| import 依赖提取 | 正则匹配 import 语句 | 较完整 |
| 增量缓存 | `.routedev/repo-map-cache.json` + mtime 比对 | 已做 |
| 影响分析 | 反向 BFS 文件级依赖图 | 已做（仅文件级） |
| 多语言支持 | TS/JS/Python/Java/Go | 初步 |
| 渲染输出 | 文件路径 + 前 3 个签名 | 简陋 |

**关键缺陷：**

| 缺陷 | 示例 | 后果 |
|------|------|------|
| **无法处理多行签名** | `const foo = (<br>  a: string,<br>  b: number<br>): Promise<void> => {...}` | 漏识别 |
| **泛型识别错误** | `function process<T extends Foo>(data: T)` | 正则可能截断或误识别 |
| **装饰器只记录无关联** | `@Component` 仅作为签名片段记录 | 不知道它装饰了哪个类 |
| **类方法误判** | `if (...) { ... }` 在类内可能被误判为方法 | 噪声 |
| **调用关系缺失** | 只知道 A import B，不知道 A 调用了 B 的哪个函数 | 影响分析只能到文件级 |
| **无符号重要性排名** | 所有签名平铺输出 | 大项目上下文塞不下 |
| **无全文检索** | 只能按文件名/符号名召回 | 无法语义匹配 |
| **语言扩展困难** | 每加一种语言要写一堆正则 | 维护成本高 |
| **无实时同步** | 靠 mtime 增量扫描，需显式触发 | 不够实时 |

### 2. Aider Repo Map 的架构与优点

Aider 的 `repomap.py`（867 行）是当前开源领域最成熟的 repo map 实现之一。核心设计：

**2.1 符号提取：tree-sitter + tags.scm**

```python
# 核心依赖
grep_ast.tsl.USING_TSL_PACK  # tree-sitter 语言包
tree_sitter.Query            # Tree-sitter 查询

# 符号以 Tag 结构表示
Tag = namedtuple("Tag", "rel_fname fname line name kind")
```

Aider 使用 tree-sitter 的 `tags.scm` 查询文件提取符号：
- 符号定义（函数、类、方法、变量）
- 符号引用/调用点（用于构建依赖图）
- 语言由 `filename_to_lang()` 自动识别，支持 20+ 语言

**2.2 缓存策略：diskcache（基于文件哈希）**

```python
TAGS_CACHE_DIR = f".aider.tags.cache.v{CACHE_VERSION}"
self.cache_threshold = 0.95
```

- 缓存 key 基于文件内容 hash，而不是 mtime
- 如果文件 hash 与缓存中的匹配率达到 95% 以上，复用旧 tag
- 否则重新解析
- 这比对 mtime 更鲁棒（git checkout 后 mtime 可能变，内容没变）

**2.3 符号排名：PageRank 类算法**

```python
# 构建图：文件/符号是节点，调用/引用是边
# 用 PageRank 的变体计算每个符号的重要性得分
# 最终只把高排名符号放入 repo map
```

Aider 不是平铺所有符号，而是：
1. 构建符号级调用图（definitions + references）
2. 运行图排名算法（类似 PageRank）
3. 在 token 预算（默认 1024 tokens）内，选择最相关的符号
4. 自动根据对话状态动态调整（没有文件加入聊天时 map 更大，有文件时 map 更聚焦）

**2.4 输出格式**

```
aider/coders/base_coder.py:
⋮...
│class Coder:
│    abs_fnames = None
⋮...
│    def run(self, with_message=None):
⋮...
```

特点：
- 文件名 + 省略号表示省略的中间代码
- 只显示最重要的定义行
- 人工可读性好，LLM 理解成本低

### 3. CodeGraph 的架构与优点

CodeGraph 把代码知识图谱工程化到了极致，其四阶段架构非常清晰：

```
files → Extraction (tree-sitter) → DB (nodes/edges/files)
            ↓
      Resolution (imports, name-matching, framework patterns)
            ↓
      Graph queries (callers, callees, impact)
            ↓
      Context building (markdown / JSON for AI consumption)
```

**3.1 数据模型（SQLite Schema）**

从 `src/db/schema.sql` 可见其工程深度：

```sql
-- 符号节点：包含完整的位置、签名、docstring、可见性、导出状态、装饰器、泛型参数、返回类型
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- function/class/method/variable/type/interface...
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,  -- 全限定名
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line/end_line/start_column/end_column INTEGER,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported/is_async/is_static/is_abstract INTEGER,
    decorators TEXT,               -- JSON array
    type_parameters TEXT,          -- JSON array
    return_type TEXT,
    updated_at INTEGER
);

-- 边：调用、继承、实现、引用、导入等
CREATE TABLE edges (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,            -- calls/extends/implements/imports/references...
    metadata TEXT,                 -- JSON
    line/col INTEGER,
    provenance TEXT                -- 'heuristic' for synthesized edges
);

-- 文件追踪：内容哈希、语言、大小、修改时间、节点数、错误
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER,
    modified_at INTEGER,
    indexed_at INTEGER,
    node_count INTEGER,
    errors TEXT
);

-- 未解析引用：用于增量解析和错误追踪
CREATE TABLE unresolved_refs (...);

-- FTS5 全文索引：名字、docstring、签名
CREATE VIRTUAL TABLE nodes_fts USING fts5(...);
```

**3.2 解析与解析后处理**

- **Extraction**：tree-sitter 解析成 AST，语言专用 query 提取节点和边
- **Resolution**：
  - import → 源文件（含 tsconfig 路径别名、cargo workspace）
  - 调用 → 定义（通过 import 解析 + 名字匹配）
  - 继承 → extends/implements
- **Framework awareness**：识别 17+ 个 Web 框架的路由文件
  - Django/Flask/FastAPI/Express/NestJS/Laravel/Drupal/Rails/Spring/Play/Gin/chi/Axum/Actix/Rocket/ASP.NET/Vapor/React Router/SvelteKit/Vue Router/Nuxt/Astro
  - 路由节点 linked 到 handler 函数
- **Dynamic-dispatch 桥接**：callback/observer、EventEmitter、React setState→render、JSX children、interface→impl
  - 这些边标记为 `provenance: 'heuristic'`，路径展示时明确标出

**3.3 同步策略**

- 原生 OS 文件事件（FSEvents/inotify/ReadDirectoryChangesW）
- 2 秒 debounce
- 只增量同步变更文件
- 零配置

**3.4 MCP 接口设计（重要参考）**

CodeGraph 默认只暴露一个 MCP 工具 `codegraph_explore`：
- 输入：自然语言问题或符号/文件列表
- 输出：相关符号的源代码（带行号）+ 调用路径 + 影响半径摘要

其他 7 个工具（node/search/callers/callees/impact/files/status）默认隐藏，可通过环境变量启用。其理念是：**一个强大的工具比多个窄工具更好，减少 Agent 误选**。

### 4. RouteDev 与两者的能力差距矩阵

| 能力 | RouteDev 当前 | Aider Repo Map | CodeGraph | 差距等级 |
|------|--------------|----------------|-----------|---------|
| 解析精度 | 正则 | tree-sitter AST | tree-sitter AST | 🔴 代差 |
| 符号排名 | 无 | PageRank | 依赖图遍历 | 🔴 代差 |
| 调用关系 | 文件级 import | 符号级 caller/callee | 符号级 caller/callee + 动态分发桥接 | 🔴 代差 |
| 多语言 | 5 种正则 | 20+ tree-sitter | 20+ tree-sitter | 🟡 较大 |
| 缓存策略 | mtime | 内容 hash | 内容 hash + 实时事件 | 🟡 较大 |
| 全文/语义搜索 | 无 | 无 | FTS5 /（外部 embedding） | 🟡 较大 |
| 框架感知 | 无 | 无 | 17+ 框架路由识别 | 🟢 中等 |
| 实时同步 | mtime 增量 | mtime/手动 | OS 文件事件 | 🟡 较大 |
| 输出格式 | 文件+签名列表 | 省略号+代码片段 | Markdown/JSON 上下文块 | 🟡 较大 |
| 与 KnowledgeGraph 融合 | 无 | 无 | 无（外部工具） | 🟢 RouteDev 机会 |
| Token 节省 | 有限 | 明显 | 显著 | - |

### 5. 为什么必须自研而不是长期依赖 MCP

用户明确指出"MCP 总会被淘汰"，原因包括：
- **协议锁定风险**：MCP 只是当前 Agent 工具协议之一，未来可能被 A2A 或其他协议取代
- **外部依赖脆弱**：codegraph 升级、弃用、改许可、被收购都会影响 RouteDev
- **无法深度定制**：外部工具不理解 RouteDev 的 TokenTracker、KnowledgeGraph、项目记忆
- **省钱定位要求**：RouteDev 的"省钱"不仅是模型路由，也包括减少不必要的代码检索。外部工具可能过度索引，RouteDev 自研可以更精细控制
- **差异化需要**：Cursor 靠 IDE 集成、Aider 靠 git 原生、CodeGraph 靠图谱查询。RouteDev 的差异化应该是"代码地图 + 项目记忆 + Token 成本"三位一体

---

## Task 1：引入 tree-sitter 作为解析引擎（≥ 12 测试）

### 1.1 技术选型

```
包选择：
  tree-sitter (npm)            ← 核心解析引擎
  tree-sitter-typescript       ← TS/TSX/JS/JSX
  tree-sitter-python           ← Python
  tree-sitter-java             ← Java
  tree-sitter-go               ← Go
  tree-sitter-rust             ← Rust
  tree-sitter-c-sharp          ← C#
  ...（按需扩展）

为什么不自己写 parser？
  - tree-sitter 是行业标准，Aider/CodeGraph 都用
  - 增量解析性能好
  - 语言生态成熟，添加新语言只需加语言包
  - 我们的正则已经证明维护成本极高
```

### 1.2 模块设计

```
src/code-map/
├── index.ts                  ← 对外统一接口
├── parser.ts                 ← tree-sitter 解析抽象
├── extractor.ts              ← 符号/边提取器
├── schema.ts                 ← 数据库 schema + 类型
├── database.ts               ← SQLite 数据库操作
├── indexer.ts                ← 批量索引 + 增量更新
├── watcher.ts                ← 文件系统监听
├── ranker.ts                 ← PageRank / 重要性算法
├── querier.ts                ← 查询接口（search/context/impact）
├── renderer.ts               ← 渲染为 LLM 友好的文本
└── languages/                ← 各语言 query 配置
    ├── typescript.ts
    ├── python.ts
    ├── java.ts
    ├── go.ts
    └── ...
```

### 1.3 tags.scm 查询设计

每种语言需要一个 `tags.scm`（tree-sitter query），定义：

```scheme
; TypeScript tags.scm 示例（简化）

; 函数定义
(function_declaration
  name: (identifier) @name) @definition.function

; 箭头函数变量
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

; 类定义
(class_declaration
  name: (identifier) @name) @definition.class

; 方法定义
(method_definition
  name: (property_identifier) @name) @definition.method

; 调用表达式
(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

; import 语句
(import_statement
  source: (string) @import) @reference.import
```

**务实策略：** 先为 TypeScript/JavaScript 写一个完整的 `tags.scm`，其他语言复用 Aider 的 query 或 tree-sitter 社区 query，不追求第一版就 20 语言。

### 1.4 符号提取目标

对于 TypeScript，至少提取：

| 符号类型 | 字段 |
|---------|------|
| function | name, signature, params, returnType, async, exported, decorators, lineRange |
| class | name, extends, implements, exported, decorators, typeParams, lineRange |
| method | name, className, signature, params, returnType, static, async, visibility, lineRange |
| interface | name, extends, exported, typeParams, lineRange |
| type alias | name, exported, lineRange |
| enum | name, exported, lineRange |
| variable | name, type, exported, lineRange |
| import | sourceModule, importedNames, lineRange |

### 1.5 边提取目标

至少提取以下边类型：

| 边类型 | 示例 |
|--------|------|
| CALLS | `foo()` → function foo |
| IMPORTS | `import { foo } from './bar'` → file ./bar |
| EXTENDS | `class A extends B` → class B |
| IMPLEMENTS | `class A implements I` → interface I |
| REFERENCES | `const x = Foo` → class Foo |
| DECORATES | `@Component` 装饰 class |
| CONTAINS | file → function/class/method |

### 1.6 测试要求

- 解析单个 TS 文件，验证所有符号类型正确提取
- 解析多行签名/泛型/装饰器，验证不截断、不误识别
- 解析 import/export，验证依赖图正确
- 解析类继承/接口实现，验证 EXTENDS/IMPLEMENTS 边正确
- 解析函数调用，验证 CALLS 边正确
- 解析 React 组件，验证 JSX 相关边（可选增强）
- 解析 Python/Java/Go 文件，验证跨语言提取
- 错误文件（语法错误）不崩溃，记录到 `files.errors`

---

## Task 2：SQLite 知识图谱存储（≥ 10 测试）

### 2.1 Schema 设计（参考 CodeGraph，但适配 RouteDev）

```sql
-- RouteDev Code Map Schema v1
-- 存储在 .routedev/code-map/code-map.db

CREATE TABLE schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- 符号节点
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,              -- 全限定名或生成的稳定 ID
    kind TEXT NOT NULL,               -- function | class | method | interface | type | enum | variable | import | route
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,     -- 例如：src/auth.ts::AuthManager::login
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    signature TEXT,                   -- 函数签名文本
    docstring TEXT,                   -- 注释/docstring
    visibility TEXT,                  -- public | private | protected
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    decorators TEXT,                  -- JSON array
    type_parameters TEXT,             -- JSON array
    return_type TEXT,
    rank_score REAL DEFAULT 0,        -- PageRank 得分
    updated_at INTEGER NOT NULL
);

-- 关系边
CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,             -- node id 或 file path
    target TEXT NOT NULL,
    kind TEXT NOT NULL,               -- calls | imports | extends | implements | references | decorates | contains
    metadata TEXT,                    -- JSON：调用点行号、import 的符号名等
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT 'static', -- static | heuristic
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- 文件追踪
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,       -- SHA-256 或 xxhash
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT                       -- JSON array
);

-- FTS5 全文索引
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    id, name, qualified_name, docstring, signature,
    content='nodes', content_rowid='rowid'
);

-- 触发器同步 FTS
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN ... END;
CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN ... END;
CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN ... END;

-- 索引（参考 CodeGraph 的优化）
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX idx_nodes_file_path ON nodes(file_path);
CREATE INDEX idx_nodes_language ON nodes(language);
CREATE INDEX idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX idx_edges_kind ON edges(kind);
CREATE INDEX idx_edges_source_kind ON edges(source, kind);
CREATE INDEX idx_edges_target_kind ON edges(target, kind);
```

### 2.2 与 CodeGraph schema 的关键差异

| 差异 | RouteDev | CodeGraph | 原因 |
|------|----------|-----------|------|
| 增加 `rank_score` | ✅ | ❌ | RouteDev 要做 PageRank |
| 增加 `provenance` | ✅ static/heuristic | ✅ | 复用 CodeGraph 思路 |
| 文件表用 content_hash | ✅ | ✅ | 比 mtime 更鲁棒 |
| 不存完整 AST | ✅ 只存符号和边 | ✅ | 节省空间 |
| 集成 TokenTracker | ✅ 记录索引耗时/token | ❌ | RouteDev 省钱定位 |
| 集成 KnowledgeGraph | ✅ 节点可链接到记忆 | ❌ | RouteDev 差异化 |

### 2.3 索引器（Indexer）

```typescript
class CodeMapIndexer {
  /**
   * 全量索引
   */
  async fullIndex(root: string, options?: IndexOptions): Promise<IndexStats>;

  /**
   * 增量索引：只处理变更/新增/删除的文件
   * 基于 content_hash 判断文件是否变更
   */
  async incrementalIndex(changedFiles?: string[]): Promise<IndexStats>;

  /**
   * 删除文件索引
   */
  async removeFile(path: string): Promise<void>;
}
```

### 2.4 测试要求

- 创建数据库、schema 迁移正常
- 插入/更新/删除节点和边
- content_hash 变化触发重新索引，未变化跳过
- FTS 全文搜索返回正确结果
- 删除文件时级联删除节点和边
- 大数据量性能：1 万文件索引在 1 分钟内完成（目标）

---

## Task 3：符号排名算法 PageRank（≥ 8 测试）

### 3.1 为什么需要排名

Aider 的核心洞察：大项目里所有符号都放进 prompt 会超 token 预算，必须选择"最重要的符号"。重要性由图结构决定：
- 被调用/引用越多的符号越重要
- 处于调用链中心位置的符号越重要
- 被已选中的上下文相关文件引用的符号更相关

### 3.2 RouteDev 的 PageRank 实现

```
图构建：
  节点：符号（function/class/method/variable）+ 文件
  边：
    - function A calls function B → A → B（权重 1.0）
    - file F imports file G → F → G（权重 0.5）
    - class A extends class B → A → B（权重 0.8）
    - function A references symbol B → A → B（权重 0.3）

迭代计算：
  PR(node) = (1 - d) / N + d * Σ(PR(incoming) / out_degree)
  d = 0.85（阻尼系数）
  迭代直到收敛或达到最大次数

输出：
  每个 node.rank_score 更新到数据库
```

### 3.3 上下文感知排名

基础 PageRank 给出全局重要性，但用户当前问题只关心部分代码。Aider 的做法是：
- 如果聊天中已加入某些文件，提升这些文件相关符号的排名
- RouteDev 可以做得更好：结合 KnowledgeGraph 的 PPR（Personalized PageRank）

```
PPR 种子节点：
  - 用户当前提到的文件/符号
  - 从 query 中提取的关键词匹配到的节点
  - 最近修改过的文件
  - KnowledgeGraph 中 recall 出的相关节点

PPR 结果：
  - 距离种子节点越近的符号排名越高
  - 与种子节点有调用关系的符号被优先召回
```

### 3.4 测试要求

- 简单链式调用图的 PageRank 正确
- 环形调用图收敛
-  star 图（一个函数被多个函数调用）中心节点排名最高
- PPR 以某个节点为种子时，相关节点排名提升
- 排名结果稳定（多次运行结果一致）

---

## Task 4：实时文件监听与增量同步（≥ 6 测试）

### 4.1 实现方式

参考 CodeGraph：
- 使用 `chokidar`（跨平台，RouteDev 已有依赖可复用）
- 监听项目根目录
- debounce 2 秒
- 过滤非源码文件（`.git/`, `node_modules/`, `dist/` 等）
- 变更文件内容 hash 变化才触发重新索引

```typescript
class CodeMapWatcher {
  async start(root: string): Promise<void>;
  async stop(): Promise<void>;
  onChange(callback: (changedFiles: string[]) => void): void;
}
```

### 4.2 与当前增量扫描的关系

当前 `incrementalScan()` 基于 mtime，将被替换为：
- `CodeMapIndexer.incrementalIndex()` 基于 content_hash
- `CodeMapWatcher` 实时触发增量索引
- 保留 `.routedev/repo-map-cache.json` 的轻量 fallback（用于没有启用 code-map 引擎时）

### 4.3 测试要求

- 修改文件后 3 秒内数据库更新
- 重命名文件正确处理
- 删除文件后节点和边级联删除
- 批量保存多个文件只触发一次增量索引
- 不监听 `.git/` 和 `node_modules/`

---

## Task 5：查询接口设计（≥ 10 测试）

### 5.1 内部查询 API（非 MCP，直接 TypeScript API）

```typescript
interface CodeMapQuerier {
  /**
   * 根据自然语言查询或符号名搜索相关代码
   * 返回 LLM 友好的上下文块
   */
  explore(query: string, options?: ExploreOptions): Promise<CodeContext>;

  /**
   * 查找符号定义
   */
  findNode(name: string, fileHint?: string): Promise<Node[]>;

  /**
   * 查找调用者
   */
  findCallers(nodeId: string): Promise<Node[]>;

  /**
   * 查找被调用者
   */
  findCallees(nodeId: string): Promise<Node[]>;

  /**
   * 影响分析：修改某个符号会影响哪些符号/文件
   */
  analyzeImpact(nodeId: string, maxDepth?: number): Promise<ImpactResult>;

  /**
   * 获取文件结构
   */
  getFileStructure(filePath?: string): Promise<FileNode[]>;

  /**
   * 获取索引状态
   */
  getStatus(): Promise<IndexStatus>;
}
```

### 5.2 explore 返回格式（LLM 友好）

```typescript
interface CodeContext {
  summary: string;           // 查询结果摘要
  files: {
    path: string;
    nodes: {
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
      signature: string;
      source: string;        // 源代码片段
    }[];
  }[];
  callPaths: {               // 调用路径
    from: string;
    to: string;
    path: string[];
  }[];
  impact: {                  // 影响半径
    affectedFiles: string[];
    affectedNodes: string[];
  };
}
```

### 5.3 输出渲染格式（Aider 风格）

```
src/auth/auth-manager.ts:
⋮...
│export class AuthManager {
│  async login(credentials: Credentials): Promise<AuthResult> {
⋮...
│  async verifyToken(token: string): Promise<boolean> {
⋮...

src/api/routes.ts:
⋮...
│router.post('/login', authManager.login);
⋮...
```

### 5.4 与 ContextInjector 集成

```
上下文注入点：
  1. 会话启动 → getFileStructure() 生成项目概览
  2. 用户消息 → explore(query) 召回相关代码
  3. /goal 分解 → analyzeImpact(targetSymbol) 预估影响范围
  4. 文件修改前 → findCallers() 评估改动风险
```

### 5.5 测试要求

- explore 查询返回相关符号和源代码
- findCallers/findCallees 正确返回调用关系
- analyzeImpact 递归追踪到指定深度
- getFileStructure 返回文件树
- 查询结果 token 控制在预算内

---

## Task 6：与 RouteDev 现有系统深度耦合（≥ 6 测试）

### 6.1 与 TokenTracker 集成

```
记录事件：
  - code_map_index_start / code_map_index_end（耗时、索引文件数、节点数）
  - code_map_query（查询类型、返回节点数、estimated token）
  - code_map_saved_tokens（与 file_search 方案对比节省的 token）

目标：
  - 在 Token 页面显示"代码地图本次帮你省了 X tokens"
```

### 6.2 与 KnowledgeGraph 集成

```
融合方式：
  - 代码节点作为 KnowledgeGraph 中的一类实体
  - 用户做出的架构决策可以链接到具体代码节点
  - recall 时同时搜索代码图谱和项目记忆

示例：
  - 用户之前说"认证用 JWT"
  - KnowledgeGraph 存储："认证策略 = JWT" 关联到 `AuthManager.login`
  - 后续查询"登录相关代码"时，同时召回 `AuthManager` 和"JWT 策略"记忆
```

### 6.3 与 HookRunner 集成

```
新增 Hook 事件：
  - on-code-map-index-start/end
  - on-code-map-query

应用场景：
  - 索引失败时通知用户
  - 大项目索引进度更新到 UI
```

### 6.4 与 CheckpointManager / 分支合并集成

```
应用场景：
  - 在实验分支（worktree）中独立维护代码地图
  - 主分支和实验分支的代码地图隔离
  - 合并前对比两个分支的影响分析
```

### 6.5 测试要求

- TokenTracker 正确记录索引和查询事件
- KnowledgeGraph 能召回关联的代码节点
- Hook 事件正确触发
- 实验分支的代码地图隔离

---

## Task 7：桌面端 UI 与设置（≥ 6 测试）

### 7.1 Settings > 代码地图 页面升级

```
┌──────────────────────────────────────────────────────┐
│  代码地图                                             │
│                                                      │
│  引擎状态：                                           │
│  ● RouteDev 自研代码地图引擎（tree-sitter）           │
│  ○ 内置轻量代码地图（正则，旧版）                     │
│  ○ CodeGraph MCP（外部）                             │
│  ○ 禁用代码地图                                       │
│                                                      │
│  索引状态：                                           │
│  ✅ 已索引 1,247 个文件，48,392 个符号               │
│  上次更新：刚刚                                       │
│  [重新索引] [暂停监听]                                │
│                                                      │
│  Token 节省：                                         │
│  本月累计：节省 1,245,000 tokens                     │
│                                                      │
│  语言支持：                                           │
│  TypeScript/JavaScript ✅    Python ✅               │
│  Java ✅                    Go ✅                    │
│  Rust ⏳（计划中）        C# ⏳（计划中）             │
│                                                      │
│  高级设置                                             │
│  • 索引排除目录：node_modules, dist, .git...         │
│  • 最大上下文符号数：50                               │
│  • 启用语义搜索（实验性）○                            │
└──────────────────────────────────────────────────────┘
```

### 7.2 首次使用引导

```
场景：打开项目时检测到代码地图未索引
  ┌──────────────────────────────────────────────────┐
  │  让 AI 更懂你的项目                                 │
  │                                                   │
  │  RouteDev 可以为你构建项目代码知识图谱：            │
  │  • 自动识别函数、类、调用关系                       │
  │  • 问"登录功能怎么实现"直接找到相关代码             │
  │  • 修改代码前自动分析影响范围                       │
  │  • 预计节省 80%+ 代码检索 Token                     │
  │                                                   │
  │  [开始构建索引]  [稍后]                            │
  └──────────────────────────────────────────────────┘
```

### 7.3 ChatPage 集成

```
用户输入"帮我改登录功能"时：
  1. 自动调用 explore("登录功能")
  2. 在消息气泡下方显示"已召回 3 个相关文件：auth.ts, login.tsx, auth.test.ts"
  3. 用户可点击展开查看
  4. AI 回复基于召回的代码上下文
```

### 7.4 测试要求

- Settings 页面正确显示索引状态
- 切换引擎模式时正常工作
- 首次引导弹窗正确显示
- 召回文件提示正确显示
- 重新索引和暂停监听功能正常

---

## Task 8：集成测试与文档同步（≥ 6 测试）

### 8.1 集成测试

- **端到端测试 1**：打开项目 → 首次引导 → 构建索引 → 用户提问 → 自动召回代码 → AI 基于召回代码回答
- **端到端测试 2**：修改文件 → 实时同步 → 查询返回更新后的代码
- **端到端测试 3**：使用 /goal → 分析影响范围 → 执行修改 → 验证影响分析准确
- **性能测试**：1000/5000/10000 文件项目索引耗时与内存占用
- **稳定性测试**：语法错误文件、二进制文件、空文件不导致崩溃
- **降级测试**：tree-sitter 引擎失败时自动回退到内置正则方案

### 8.2 文档同步

- **CODEMAP.md**：新增 `src/code-map/` 模块说明
- **CHANGELOG.md**：v3.2.0 条目
- **package.json**：版本号升级至 3.2.0
- **config schema**：新增 `codeMap.engine`、`codeMap.indexExclude`、`codeMap.maxContextSymbols` 等配置项

---

## 新增陷阱警告

**74. tree-sitter 原生模块在 Windows 上的编译问题：** `tree-sitter` npm 包依赖 C++ 原生模块。在 Windows 上如果没有预编译二进制，可能需要 Visual Studio Build Tools。RouteDev 必须：
- 优先使用提供预编译 binary 的 `tree-sitter` 版本
- 提供 fallback：如果 tree-sitter 加载失败，自动回退到内置正则 repo-map
- 在 Windows 安装包中预置兼容的 tree-sitter binary

**75. content_hash 比 mtime 更可靠，但计算成本更高：** 每文件计算 SHA-256 在万级文件项目上会有明显开销。建议使用 `xxhash` 或 `farmhash` 等快速非加密哈希。只有在 hash 冲突可接受场景使用。

**76. SQLite WAL 模式在多进程/多 worktree 下的并发：** RouteDev 的实验分支（worktree）可能各自访问 `.routedev/code-map/code-map.db`。必须使用 WAL 模式，且每个 worktree 应该有独立的 code-map 数据库实例，避免锁竞争。主工作区和 worktree 的 code-map 应该物理隔离。

**77. PageRank 收敛问题：** 大型项目（10 万节点）的 PageRank 可能收敛慢。必须设置最大迭代次数（如 100 次），并在后台线程运行，避免阻塞 UI。可以缓存 rank_score，只在图结构显著变化时重新计算。

**78. 符号 ID 稳定性：** node.id 必须稳定（基于 qualified_name + file_path），否则每次索引后 ID 变化会导致边失效。避免使用行号或随机 ID。

**79. 语言包体积爆炸：** tree-sitter 各语言包（tree-sitter-typescript/tree-sitter-python/...）总体积可能上百 MB。 Electron 打包时要谨慎选择包含哪些语言，不要无差别打包所有语言。可以：
- 核心包包含 TS/JS/Python/Java/Go
- 其他语言按需下载

**80. FTS5 在旧版 SQLite 上不可用：** Node.js 内置 `node:sqlite` 需要较新版本。RouteDev 需要检测 SQLite 版本，低于 3.35.0 时使用 `better-sqlite3` 或关闭 FTS 功能。

**81. 过度索引浪费资源：** 不要索引 `node_modules/`、`dist/`、`.git/`、生成的 lock 文件。`isIgnoredPath()` 必须扩展为排除这些目录，并提供用户可配置的排除模式。

**82. 代码地图引擎不能阻塞 Agent Loop：** 索引和查询必须在后台执行。任何同步数据库操作都会冻结 UI。所有 DB 操作必须 async，必要时使用 worker thread。

---

## 思考引导总结

以下问题供执行人在实现时思考：

1. **语言包选择：** 第一版支持几种语言？建议至少 TS/JS/Python/Java/Go，Rust/C# 紧随。是否允许用户按需下载语言包？

2. **符号 ID 生成策略：** 用 `qualified_name` 作为主键有冲突风险（不同文件可能同名函数）。是否用 `<file_path>::<qualified_name>`？还是生成 UUID 但额外维护稳定映射？

3. **PageRank 还是 PPR：** 全局 PageRank 给出"重要符号"，PPR 给出"与当前问题相关的符号"。是否两者都做？PPR 计算成本更高，如何控制？

4. **动态分发桥接的投入：** CodeGraph 花了大量精力做 React/JSX/EventEmitter 等 heuristic 边。RouteDev 第一版是否值得投入？建议先只做静态调用关系，heuristic 边后续迭代。

5. **与 KnowledgeGraph 的融合深度：** 是简单把代码节点作为记忆实体，还是做双向链接（代码节点引用记忆，记忆引用代码）？后者更强大但更复杂。

6. **实时监听的 debounce 时间：** CodeGraph 用 2 秒。RouteDev 如果 debounce 太短，批量保存会触发多次索引；太长，用户感知延迟。是否可配置？

7. **是否保留正则 repo-map 作为永久 fallback：** 是的。tree-sitter 可能失败、语言不支持、依赖缺失，正则方案是最后的保底。但不需要继续增强它。

8. **索引进度如何展示：** 大项目首次索引可能需要几分钟。UI 需要显示进度条、已索引文件数、预计剩余时间，避免用户以为卡死。

9. **跨 worktree 的 code-map 同步：** 实验分支修改代码后，主分支的 code-map 是否需要立即感知？不需要——各 worktree 独立，合并后统一更新主分支 code-map。

10. **开源与闭源的边界：** RouteDev 整体 AGPL-3.0，代码地图引擎是否独立为可复用库？如果未来想作为独立产品发布，建议把 `src/code-map/` 设计为内部包，但暂时不单独发布。