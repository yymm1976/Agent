# RouteDev 变更记录

所有版本变更记录。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## v0.0.1 (2026-06-18)

### 初始发布版本
将版本号重置为 0.0.1，作为项目对外发布的初始版本。本版本包含经过 29 个 Phase 迭代开发的完整功能集。

## v2.1.0 (2026-06-18)

### 安全加固与收尾闭环
Phase 29 是项目的最后一个开发 Phase，回应代码审查报告发现的安全缺口，将安全性从 5/10 提升到 7/10。

### 安全修复（12 项审查问题）
- **S1/S2/S3 命令解析绕过**：引入 `command-parser.ts` tokenize 解析，替代正则/子串匹配
  - `rm -rf "/"`（引号绕过）、`RM -rf /`（大写绕过）均被阻止
  - 新增 `find -delete`、`dd of=/dev/` deny 规则
  - `python program.py` 不再被误拦（子串匹配修复）
- **S5/S6 签名验证降级**：生产模式下 token/signingSecret 未配置时拒绝请求
- **S8 PKCS#7 padding oracle**：严格验证 padding 字节一致性，上界从 32 改为 16
- **S9 环境变量占位符**：`replaceEnvVars` 改为 fail-fast，启动时报错而非运行时 401
- **S11 API Key 占位符**：OpenAI/Anthropic 客户端空 key 时不构造假客户端，`isReady()` 返回 false
- **S12 vision 路径遍历**：`startsWith` 改为 `path.relative`，防止前缀匹配绕过
- **env 注入**：shell-exec 环境变量白名单过滤，阻止 `LD_PRELOAD`/`NODE_OPTIONS` 注入

### 架构修复（4 项）
- **A1 Slack 适配器注册**：ChannelManager 补充 `slack` case 分支
- **A2 末尾 import**：`manager.ts` 末尾 import 移至顶部
- **A4 搜索工具去重**：提取 `walkDir`/`isIgnoredPath`/`matchGlob` 到 `search-utils.ts`

### 运行时健壮性（4 项）
- **B1 isError 字符串匹配**：改为结构化错误标记识别，"修复了3个错误"不再误判
- **B3 isModelAvailable 恒 true**：实现真实检查（provider 配置 + API Key）
- **B4 分类器回退 simple**：改为 `complex`（保守策略，不确定时用强模型）
- **B10 rollback 无前置检查**：添加工作区干净检查，防止丢失未提交更改
- **B13 orchestrator 静默降级**：环检测时输出警告日志

### 边界案例（2 项）
- **B6 wechat parseInt NaN**：CreateTime/agentId 非数字时使用安全默认值

### 测试覆盖
- 新增 97 个测试（16 个测试文件），覆盖所有 Phase 29 修复
- 全量测试通过

### 文档同步
- AGENTS.md：更新陷阱警告（命令解析 tokenize、签名验证生产模式、env fail-fast、rollback 前置检查）
- CODEMAP.md：新增 `command-parser.ts` 和 `search-utils.ts` 条目
- README.md：版本号更新至 v2.1.0

## v2.0.0 (2026-06-18)

### 重大里程碑
经过 28 个 Phase 的迭代开发，RouteDev 正式发布 v2.0.0，达到商业交付标准。

### 核心能力
- **智能路由**：场景分类 → 模型选择 → 成本优化，全链路自动化
- **ReAct Agent Loop**：流式思考-行动循环，支持工具调用和多步任务
- **多 Agent 编排**：Orchestrator 分解任务，Worker 并行执行
- **Compose 管线**：需求→编码→测试→审查全流程自动编排
- **DurableExecutor**：长任务断点恢复，不怕中断
- **7 层安全防护**：权限→目录→命令→文件→网络→进程→审计
- **渐进式上下文**：5 阶段压缩 + 知识图谱 + 梦境整合
- **插件系统**：Theme/Tool/Hook/Router 四类插件，社区可扩展
- **渠道集成**：Telegram / Slack / 企业微信 / Discord

### Phase 28（质量验收与发布准备）
- 10 个 E2E 用户旅程测试
- 性能基线强制门（8 项指标）
- 安全终审（9 项审计，23 个测试）
- 测试覆盖率强化（33 个边界条件测试）
- 完整文档（CHANGELOG / ARCHITECTURE / PLUGIN_GUIDE / SECURITY_AUDIT）
- 蓝图合规度终审 ≥ 95%
- 版本号升级至 v2.0.0

### Phase 27（产品完善与商业交付标准）
- DurableExecutor 运行时集成 + /resume 交互式 UI
- RouterPlugin / ThemePlugin 接入
- 插件状态持久化
- DiffView 动作绑定（apply/reject）
- 通知持久化到审计日志
- Compose + HookRunner TracePanel 可视化
- notes.md 模块（Agent 唯一写通道）

### Phase 26（技术债务清零与架构加固）
- 路径遍历漏洞修复（code-search / file-search）
- 企业微信凭据脱敏
- ServiceContext 类型安全（消除 as any）
- /permissions 命令反映运行时规则
- 异步 I/O 替换同步写入（tracker / durable-executor）
- 自定义错误类体系（RouteDevError + 6 子类）
- 提示词模板五块结构改造

## v1.4.0 (2026-06-18)
Phase 27 完成版本。

## v1.3.0 (2026-06-18)
Phase 26 完成版本。

## v1.2.0 (2026-06-18)
Phase 25（UI 与交互优化）完成版本。

## v1.1.0 (2026-06-18)
Phase 24（功能补全与产品完善）完成版本。包含 CLI 设计系统、Compose 管线、DurableExecutor、HookRunner、/permissions、提示词规范、错误消息、Provider 校验等 8 个模块。

## v1.0.1 (2026-06-18)
Phase 0c（审计修复）完成版本。统一权限引擎、拆分 inferProviderId、收敛 App 组装、同步文档。

## v1.0.0 (2026-06-18)
Phase 20-23 完成版本。WorkModeController 三模式权限矩阵、PermissionEngine 三层权限、四类插件系统、TracePanel、SlackAdapter、SetupWizard 等。

## v0.8.0 - v0.1.0 (2026-06-17 ~ 2026-06-18)
Phase 01-19 迭代版本，涵盖项目骨架、核心类型、Router 层、CLI 对话、Agent Loop、工具框架、MCP 客户端、自主模式、检查点系统、多模态视觉、渠道集成、多 Agent 基础、可观测性、Prompt 模板系统、App 重构等。
