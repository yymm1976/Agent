# Phase 75 第三波（75-C）详解

> **文档目的**：详细解释 Phase 75 第三波 5 项借鉴点的含义、背景、实施思路与预期价值
>
> **目标读者**：RouteDev 项目维护者
>
> **日期**：2026-07-07

---

## 为什么第三波是"高难度"

第一波（75-A）和第二波（75-B）的借鉴点主要是"加脚本 / 加字段 / 加 prompt 片段 / 加配置文件"——这些是**增量式改动**，不触动现有架构。

第三波（75-C）的 5 项都需要**架构层面的调整**，要么改变核心调度逻辑、要么引入新的运行时沙箱、要么重构测试基础设施、要么建立新的贡献者契约。每项都可能影响多个子系统，因此标注为"高难度"，建议在 Phase 76+ 按需启动，而非一次性全做完。

---

## 75-C1：Turn count beats token price 模型路由

### 一句话解释
**不要无脑用最便宜的模型——多步任务上便宜模型会多花 2-3 倍轮次，总成本反而更高。**

### 背景
Superpowers v6 的反直觉发现：

> Turn count beats token price. Wall-clock and context cost scale with how many turns a subagent takes, and the cheapest models routinely take 2-3× the turns on multi-step work — costing more overall.

具体实验：让便宜模型做"多文件集成 + 调试"任务，它经常在第 3-4 轮才发现前 2 轮走错了方向，回头重试。而 mid-tier 模型一轮就能做对。最终便宜模型花了 2-3 倍的轮次，每轮都要重新读上下文，总 token 消耗反超。

### v6 的应对策略
- **按任务形态分层**：
  - 1-2 文件 + 完整 spec → cheapest（这是"转录 + 测试"任务，模型只是照着 plan 抄代码）
  - 多文件 + 集成 → standard（mid-tier 地板）
  - 设计判断 / 广 codebase 理解 → most capable
- **reviewer 与 prose-implementer 用 mid-tier 作地板**：reviewer 要判断 spec compliance，prose-implementer 要从文字描述推导实现，两者都不能用最便宜模型
- **最终 whole-branch review 必须 most capable**：这是合并前最后一道关，不能用 session 默认模型（可能是便宜的）

### RouteDev 现状
RouteDev 有 Router 层（Phase 61 ACRouter 闭环模型路由），但路由分类器**只按"任务类型"路由**（如 research / code / review），不考虑：
- 任务的"轮次成本"（多步任务便宜模型可能更贵）
- 任务复杂度信号（文件数 / spec 完整度 / 是否需要设计判断）
- reviewer 的"地板"约束

### 落地思路
1. **Router 加"task complexity signal"维度**：除了任务类型，还要评估：
   - 影响文件数（1-2 / 3-10 / >10）
   - spec 完整度（plan 是否含完整代码 / 只是 prose 描述）
   - 是否需要设计判断（架构决策 / 接口设计 / vs. 照 plan 执行）
2. **建立"模型地板"规则**：
   - reviewer → mid-tier 地板（禁用 cheapest）
   - prose-implementer → mid-tier 地板
   - 最终 whole-branch review → most capable 地板
3. **dispatch 时强制写明 model**（75-A3 已落地字段，本项是路由策略层）
4. **建立"轮次成本"监控**：记录每个 subagent 的轮次 + 总 token，发现便宜模型多轮反超时告警

### 为什么高难度
- 需要改 Router 核心分类逻辑
- 需要建立"任务复杂度信号"评估机制（可能需要 subagent 自评或预扫描）
- 需要建立轮次成本监控基础设施
- 模型分层策略需要实测调优（不同模型供应商的能力分层不同）

### 预期价值
避免"用便宜模型反而更贵"的陷阱。对于 RouteDev 这种多 Agent 协作场景，reviewer 和 implementer 的模型选择直接影响总成本。

---

## 75-C2：Skill 沙箱脚本扩展

### 一句话解释
**让 Skill 不只是 prompt 模板，还能包含可执行逻辑（如自动生成 review package、解析 tool result），用沙箱隔离运行。**

### 背景
tau 项目的 `poe`（Plugin of Everything）引擎加载 Starlark 脚本（Python 子集，沙箱化）作为 DNS 插件——运行时热加载、不重编译二进制。Superpowers v6 用 bash 脚本做确定性工作（review-package / task-brief）。

两个项目都把"确定性工作"交给脚本，而非让 LLM 临场探索。但 RouteDev 的 Skill 系统目前**只有 prompt 模板**，没有可执行逻辑层。

### RouteDev 现状
RouteDev 的 Skill 是纯 Markdown：
- `.routedev/skills/<name>/SKILL.md` 含 frontmatter（name / description / when_to_use / paths）+ prompt 内容
- `filesystem-discovery.ts` 自动扫描加载
- Skill 被触发后，其 prompt 内容被注入到 agent 上下文

**问题**：Skill 只能"说话"，不能"做事"。例如：
- "生成 review package"这个动作，Skill 只能告诉 agent "请运行 review-package.mjs 脚本"，agent 还得自己跑工具调用
- "解析 tool result 提取关键字段"这个动作，Skill 只能描述"请提取 X 字段"，agent 还得自己理解结构

### 落地思路
1. **在 Electron 主进程引入沙箱运行时**：
   - 选项 A：`isolated-vm`（V8 隔离堆，安全但启动慢）
   - 选项 B：`quickjs-emscripten`（QuickJS 编译为 WASM，轻量但生态弱）
   - 选项 C：Node.js `worker_threads` + 限制全局 API（折中）
2. **Skill 结构扩展**：
   ```
   .routedev/skills/<name>/
     ├── SKILL.md          # prompt 模板（现有）
     ├── scripts/          # 可执行脚本（新增）
     │   ├── pre-process.mjs   # 触发前预处理（如解析 tool result）
     │   ├── post-process.mjs  # 触发后后处理（如生成 review package）
     │   └── validate.mjs      # 输入校验
     └── manifest.json     # Skill 元数据 + 脚本声明
   ```
3. **脚本 API**：沙箱内可用的 API 白名单：
   - `readFile(path)` / `writeFile(path, content)`（受限路径）
   - `git(args)`（只读 git 命令）
   - `log(level, message)`（日志）
   - **禁**：`require` / `import`（除非白名单模块）/ `process` / `child_process` / 网络
4. **执行时机**：
   - `pre-process`：Skill 触发前，脚本预处理输入（如从 tool result 提取字段）
   - `post-process`：Skill 触发后，脚本后处理输出（如生成文件）
   - `validate`：输入校验，失败则 Skill 不触发

### 为什么高难度
- 引入沙箱运行时有性能开销（isolated-vm 启动 ~50ms）
- 沙箱 API 设计需要平衡安全与能力（太严没法用，太松有安全风险）
- Skill 结构扩展需要向后兼容（纯 prompt Skill 仍要能用）
- 脚本调试体验差（沙箱内不能 console.log 到主进程）

### 预期价值
让 Skill 从"只能说话"升级为"能说话能做事"。对于 review-package 生成、tool result 解析、输入校验等确定性工作，脚本比 LLM 更快更准更便宜。

---

## 75-C3：一键本地测试环境（routedev dream）

### 一句话解释
**一行命令（`npm run dream`）拉起完整测试环境——mock LLM + 临时工作区 + headless 浏览器，所有 e2e 测试基于这个环境。**

### 背景
tau 项目的 `dream` 命令是核心测试基础设施：

> 一行命令拉起整个本地云（含全部服务），既做演示也做 e2e 测试床。所有贡献者一行命令复现完整环境。

tau 的 `CONTRIBUTING.md` 还规定 `go test -p 1`（串行测试），避免并发测试互相污染共享资源。

Superpowers v6 也有类似理念——`review-package` 脚本生成的 `.superpowers/sdd/` 目录既是运行时数据也是测试夹具。

### RouteDev 现状
RouteDev 的测试现状：
- 有 vitest 单元测试（如 progress-ledger 29 测试全绿）
- **缺少统一 e2e 环境**：每次 e2e 测试需手动准备：
  - mock LLM（固定响应）
  - 临时工作区（避免污染真实项目）
  - Electron 主进程 + 渲染进程启动
  - 测试项目数据（项目树 / 对话历史 / 工具调用记录）
- e2e 测试覆盖薄（主要靠单元测试 + 手动验证）
- React UI 端到端几乎无自动化覆盖

### 落地思路
1. **新增 `npm run dream` 子命令**：
   ```json
   {
     "scripts": {
       "dream": "node scripts/dream.mjs",
       "test:e2e": "node scripts/dream.mjs --run-e2e",
       "test:serial": "vitest run --serial"
     }
   }
   ```
2. **dream.mjs 做的事**：
   - 启动 mock LLM server（固定响应，如 "echo" 模式返回用户输入）
   - 创建临时工作区（`os.tmpdir() + /routedev-dream-<random>/`）
   - 注入测试项目数据（seed 项目树 + 对话历史）
   - 启动 Electron 主进程（指向临时工作区）
   - 启动 headless Playwright（可选，用于 UI e2e）
   - 运行 e2e 测试套件
   - 测试后清理临时目录
3. **e2e 测试串行**（借鉴 tau `go test -p 1`）：
   - Electron 单实例限制，e2e 必须串行
   - vitest `--serial` flag 或自定义 runner
4. **mock LLM 策略**：
   - "echo" 模式：返回用户输入（测试基本流程）
   - "scripted" 模式：按预设脚本响应（测试多轮对话）
   - "record-replay" 模式：录制真实 LLM 响应，回放（回归测试）

### 为什么高难度
- Electron 主进程在测试环境启动复杂（vs. 纯 Node 测试）
- mock LLM 需要模拟流式响应 + 工具调用 + 多轮对话
- Playwright + Electron 集成有坑（`electron.serve` 或 `_electron.executablePath`）
- 临时工作区与真实工作区的行为差异（路径权限 / 文件系统特性）

### 预期价值
- 所有贡献者一行命令复现完整测试环境
- e2e 测试可自动化，不再靠人肉验证
- 回归测试覆盖 UI 交互（Phase 74 的前端改动可自动验证）
- mock LLM 让测试 deterministic（不依赖真实 LLM API）

---

## 75-C4：CLAUDE.md 式贡献者规范 + Skill 修改门槛

### 一句话解释
**建立 AI 贡献者规范——AI 必须披露身份、Skill 修改必须附 eval 证据、禁止批量 PR；"Skill 是塑造 agent 行为的代码，不是散文"。**

### 背景
Superpowers 项目的 `CLAUDE.md`（贡献者规范）有这些硬规则：

1. **"94% PR rejection rate"**——几乎每个被拒 PR 都是 agent 没读规范
2. **"Skills are not prose — they are code that shapes agent behavior"**——Skill 修改门槛极高，需 eval 证据
3. **PR 必须披露 model / harness / harness version / 所有 plugin**——隐藏 agent 身份是关闭理由
4. **"your human partner" 是刻意用词**，不是 "the user"——改写项目 voice 的 PR 会被拒
5. **禁止批量 PR**：一个 session 只解决一个 issue，禁止 trawl issue tracker

tau 项目也有类似规范（CONTRIBUTING.md 的 issue-driven workflow + `[scope]` commit）。

### RouteDev 现状
RouteDev 已有：
- `AGENTS.md`（AI 贡献者规范，但可能不够严格）
- `CONTRIBUTING.md`（Phase 75-A5 新增，含 AI 贡献者规范 3 条：披露 model/harness / Skill 修改附 eval / 禁止批量 PR）

**但缺少**：
- Skill 修改的 eval 证据标准（什么样的 eval 算"足够"）
- "skills are code" 的执行机制（如何强制 Skill 修改附 eval）
- PR 模板（强制披露字段）
- Skill 版本化与回滚机制（改坏了能回退）

### 落地思路
1. **新增 `AGENTS.md` 强化**（或新建 `CLAUDE.md` / `AI-CONTRIBUTING.md`）：
   - AI 贡献者必须在 PR 描述中披露：model / harness / harness version / 所有 plugin
   - Skill 修改必须附 eval 证据（before/after 对比 + 测试用例）
   - "Skill 是塑造 agent 行为的代码，不是散文"——修改需谨慎
   - 禁止批量 PR（一个 session 只解决一个 issue）
   - 禁止改写项目 voice（如 "your human partner" 用词）
2. **PR 模板**（`.github/pull_request_template.md`）：
   ```markdown
   ## 改动描述
   [一句话描述]

   ## AI 贡献者披露（如适用）
   - 模型：[model name + version]
   - Harness：[Trae / Cursor / Claude Code / ...]
   - Plugin：[列出所有启用的 plugin]

   ## Skill 修改 eval（如修改了 Skill）
   - Before：[行为描述 + 测试结果]
   - After：[行为描述 + 测试结果]
   - 测试用例：[链接或描述]

   ## 关联 issue
   Fixes #
   ```
3. **Skill 版本化**：
   - Skill frontmatter 加 `version` 字段
   - Skill 修改时 version 递增
   - 保留历史版本（`.routedev/skills/<name>/versions/<version>/SKILL.md`）
   - 出问题可回滚到上一版本
4. **CI 校验**：
   - PR 改动 Skill 文件 → 检查 PR 描述是否含 eval 证据
   - PR 改动 Skill 文件 → 检查 version 是否递增

### 为什么高难度
- 需要建立 PR 模板 + CI 校验流程
- Skill 版本化需要设计存储与回滚机制
- "eval 证据标准"需要定义（什么样的 eval 算"足够"）
- 文化层面：AI 贡献者规范的执行需要社区共识

### 预期价值
- 防止 AI 贡献者"乱改 Skill"导致 agent 行为退化
- Skill 修改可追溯、可回滚
- PR 透明化（AI 身份披露），便于 review
- 保护项目 voice 一致性

---

## 75-C5：双传输服务框架

### 一句话解释
**抽象一层 `Service` 接口，让模块既能 in-process 调用（同进程函数调用），又能跨进程 IPC（Electron 主/渲染通信），为未来拆 worker 进程留余地。**

### 背景
tau 项目的每个服务同时暴露 P2P stream + HTTP 路由，客户端透明选择：

> 每个服务同时暴露 P2P stream（`streams.New(...)`）和 HTTP 路由（`srv.setupHTTPRoutes()`），客户端透明选择

这种"双传输"设计让服务可以在单进程运行（开发时），也可以跨进程/跨机器运行（生产时），客户端代码不用改。

### RouteDev 现状
RouteDev 的 Electron 主/渲染进程通信**耦合在 ipcMain 上**：

```typescript
// 现状：直接用 ipcMain.handle / ipcRenderer.invoke
ipcMain.handle('routedev:chat:send', async (event, ...args) => {
  return await chatService.send(...args);
});

// 渲染进程
const result = await window.routedev.chat.send(...args);
```

**问题**：
- 服务调用与 IPC 传输耦合——服务只能跨进程调用，不能 in-process 调用
- 测试时必须启动 Electron 主进程才能测服务
- 未来如果要拆 worker 进程（如把 LLM 调用放到独立进程避免阻塞主进程），需要大改
- 服务依赖 IPC 序列化（不能传函数 / 不能传 Symbol / 大对象要深拷贝）

### 落地思路
1. **定义 `Service` 接口**：
   ```typescript
   interface Service {
     readonly name: string;
     // in-process 调用（同进程函数调用）
     invoke(method: string, ...args: unknown[]): Promise<unknown>;
     // 跨进程 IPC 调用（Electron ipcRenderer.invoke）
     invokeIPC(method: string, ...args: unknown[]): Promise<unknown>;
   }
   ```
2. **服务注册表**：
   ```typescript
   class ServiceRegistry {
     private services = new Map<string, Service>();
     register(service: Service) { ... }
     get(name: string): Service | undefined { ... }
   }
   ```
3. **服务实现示例**：
   ```typescript
   class ChatService implements Service {
     readonly name = 'chat';
     async invoke(method: string, ...args: unknown[]) {
       // in-process 直接调用
       if (method === 'send') return await this.send(...args);
     }
     async invokeIPC(method: string, ...args: unknown[]) {
       // 跨进程通过 ipcRenderer.invoke
       return await ipcRenderer.invoke(`routedev:${this.name}:${method}`, ...args);
     }
     private async send(...) { ... }
   }
   ```
4. **调用方透明选择**：
   ```typescript
   // 渲染进程：默认走 IPC
   const chat = registry.get('chat');
   await chat.invokeIPC('send', message);

   // 主进程：默认走 in-process
   await chat.invoke('send', message);

   // 测试：in-process，无需启动 Electron
   await chat.invoke('send', message);
   ```
5. **为未来 worker 进程留余地**：
   - 当 LLM 调用拆到 worker 进程时，只需让 `invokeIPC` 支持新的传输（`worker.postMessage`），调用方代码不变

### 为什么高难度
- 需要重构现有所有 `ipcMain.handle` / `window.routedev.*` 调用
- 服务接口设计需要平衡类型安全与灵活性
- 现有 preload 脚本的 `contextBridge.exposeInMainWorld` 暴露面需要重新设计
- 重构范围大，可能影响所有 IPC 调用点

### 预期价值
- 服务可在 in-process / IPC / worker 进程间透明切换
- 测试时无需启动 Electron，直接 in-process 调用
- 为未来 worker 进程拆分（LLM 调用 / 文件索引 / 代码分析）留余地
- 服务依赖注入更清晰（registry 模式）

---

## 第三波落地优先级建议

| 优先级 | 项 | 理由 |
|--------|-----|------|
| 1 | 75-C4 贡献者规范 | 最轻量，只需文档 + PR 模板 + CI 校验，无架构改动 |
| 2 | 75-C1 模型路由 | 直接影响成本，且 75-A3 已铺好 model 字段基础 |
| 3 | 75-C3 一键测试环境 | 解锁 e2e 自动化，长期 ROI 高 |
| 4 | 75-C2 Skill 沙箱 | 需要沙箱运行时选型 + 性能调优，但解锁 Skill 可执行逻辑 |
| 5 | 75-C5 双传输框架 | 重构范围最大，建议在其他项稳定后再做 |

---

## 总结

第三波 5 项的共同主题是**"为 RouteDev 长期演化打基础"**：

- 75-C1 优化**成本**（模型路由按形态分层）
- 75-C2 扩展**能力**（Skill 从纯 prompt 升级为 prompt + 可执行逻辑）
- 75-C3 强化**质量**（一键测试环境解锁 e2e 自动化）
- 75-C4 保护**协作**（AI 贡献者规范 + Skill 修改门槛）
- 75-C5 提升**架构**（双传输框架为 worker 进程拆分留余地）

这 5 项不需要同时做，建议按优先级在 Phase 76-80 逐步启动。每项启动前应单独写详细 plan（参考 Phase 75 文档格式），评估范围与风险后再执行。
