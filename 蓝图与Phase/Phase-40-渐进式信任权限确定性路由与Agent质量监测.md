# Phase 40 — 渐进式信任权限、确定性路由与 Agent 质量监测

> **版本目标：** v3.2.0
> **前置依赖：** Phase 38 完成（v3.0.0）；Phase 39 完成（v3.1.0）
> **新增测试要求：** ≥ 32 个
> **研究依据：** PRODUCT-INSIGHT-2026-06-24.md（字节跳动 Agent 实践手册解析 + 社区痛点调研）；AI编程Agent用户痛点研究报告.md（20 痛点 × 25+ 来源）；DEEP_RESEARCH_agent_frameworks_2026-06-23.md（框架对标调研）
> **核心命题：** RouteDev 的权限系统、模型路由和质量监测存在三个系统性缺口——(1) PermissionEngine 是扁平三态系统（`deny | confirm | auto`），所有操作要么完全放行要么逐一确认，缺少中间地带，而 TrustGradientManager 已实现 7 级信任梯度但从未接入生产路径（死代码）；(2) ScenarioClassifier 将所有请求都送入 LLM 分类，即使是 `/cost`、`/history` 这类确定性操作也消耗 Token，没有"零 LLM"快速通道；(3) ModelRouter 的熔断器只跟踪可用性（连续失败次数），不感知输出质量，AuditLogger 只记录过程指标不反映用户满意度，知识图谱的 `improve()` 没有自动触发源。本 Phase 从字节跳动 Agent 实践手册的"混合决策"和"数据闭环"方法论、以及社区痛点调研的"权限极化"和"Token 成本"反馈中提取五个落地方向——其中最紧迫的是构建管道被 Windows Defender 锁文件导致反复失败、产物目录无限膨胀的问题（Task 0，最高优先级）。

---

## 研究背景：三个缺口的来源与验证

### 1. 权限系统的"扁平困境" — 死代码与生产断裂

**现状：** `PermissionEngine`（`src/tools/permission-engine.ts`）提供三态决策：`deny | confirm | auto`，通过 `check(toolName, args, mode): PermissionCheckResult` 执行。`createDefaultEngine()` 工厂函数（`app-init.ts` 第 471 行）加载预定义的 `DEFAULT_DENY_RULES`、`DEFAULT_CONFIRM_RULES`、`DEFAULT_AUTO_RULES`。规则按 `toolPattern` 匹配，`argsPredicate` 提供参数级过滤。

与此同时，`TrustGradientManager`（`src/tools/trust-gradient.ts`）已实现完整的 7 级信任梯度：`plan | default | acceptEdits | acceptAll | auto | bypassPermissions | trusted`。它拥有精密的会话级临时授权机制——`TemporaryGrant` 记录（TTL 30 分钟、SHA-256 参数哈希、最多 1000 条 LRU 淘汰）和 `checkOperation()` 方法。但它是**死代码**：`app-init.ts` 从未实例化 TrustGradientManager，`ServiceContext` 没有 `trustGradientManager` 字段，PermissionEngine 的 `check()` 方法不查询信任梯度。

**社区验证：** 痛点 11（权限系统两极化）被 UpGuard 安全研究定性为"供应链攻击的主要向量"。42% 的开发者在 YOLO 模式（完全信任）和频繁确认（完全不信）之间挣扎。社区呼唤"智能确认"——只对高风险操作确认，对低风险操作自动放行。

**字节手册验证：** 手册第 8.2.2 节的混合决策模式强调"规则明确的任务用规则引擎处理"——权限判断本质上就是规则明确的任务，不应该每次都经过 LLM。

**类比：** 现在的 PermissionEngine 像一个只有"开"和"关"两个档位的灯——要么全亮（YOLO），要么全暗（频繁确认）。TrustGradientManager 是一个已经造好的调光器（7 级亮度），但没有接上电线。

### 2. 分类器的"全量 LLM 浪费" — 确定性操作也消耗 Token

**现状：** `ScenarioClassifier`（`src/router/classifier.ts`）定义 4 级分类：`ScenarioTier = 'simple' | 'medium' | 'complex' | 'reasoning'`。分类策略优先级链为：命令正则匹配 → LLM 分类 → 关键词回退 → 硬回退 `complex`（confidence 0.3）。所有未被命令正则命中的输入都需要调用 LLM 进行分类。

`TaskComplexityAnalyzer`（`src/agent/complexity-analyzer.ts`）有独立的规则优先层，但它是一个独立模块，不与 ScenarioClassifier 共享分类结果。

**社区验证：** 痛点 4（Token 成本不可控）是 42% 开发者的头号困扰。一位开发者"做个小工具烧掉 800 万 Token"的案例被广泛传播。痛点 13（效率悖论）表明资深开发者用 AI 反而慢了 19%——部分原因是简单操作也被送到 LLM 处理，增加了不必要的延迟。

**字节手册验证：** 手册第 8.2.2 节明确描述"规则引擎 + 大模型"混合决策：对于规则明确的简单任务，采用规则引擎快速响应（0.5 秒内）；对于复杂推理任务，才调用大模型。

**类比：** ScenarioClassifier 像一个餐厅服务员——客人要一杯水也要去问主厨（LLM）该怎么做，而不是直接从饮水机接一杯。确定性路由就是给服务员一本"常见饮品直接上"的手册。

### 3. 质量监测的"盲区" — 只看有没有响应，不管响应好不好

**现状：** `ModelRouter`（`src/router/router.ts`）的熔断器（Netflix Hystrix 模式）跟踪每个模型的连续失败次数，5 次连续失败触发 30 秒熔断期。9 级 fallback 链确保路由总有模型可用。但 `recordModelFailure()` / `recordModelSuccess()` 只关心"模型是否返回了响应"，不关心"响应质量如何"——模型返回了错误的代码也算"成功"。

`AuditLogger`（`src/harness/audit-logger.ts`）的 `log(action, target, details, result?, agentId?, confirmation?)` 签名有 20+ 种 `AuditAction` 值，但没有 `user_feedback`、`satisfaction` 等字段。`TrajectorySummary` 追踪过程指标（步数、Token 消耗、工具调用次数），但不追踪结果质量。

**社区验证：** 痛点 14（AI 出 Bug 时调试困难）指出 Agent 出现"行为幻觉"——声称执行了但实际没有。痛点 9（96% 开发者不信任 AI 代码）说明需要一个持续证明 Agent 价值的机制。

**字节手册验证：** 手册第 16 章的量化验收标准建立了三维评估——业务价值（效率提升率）、技术性能（稳定性）、合规安全。手册第 8.2.3 节的"数据闭环"方法论要求建立"用户反馈 → 数据监测 → 模型优化"的闭环。

**类比：** ModelRouter 的熔断器像一个只检查"水管有没有出水"的质检员——它不管出来的是清水还是浑水。质量监测是给这个质检员加一套水质检测设备。

---

## Task 0：构建管道加固与自动清理（≥ 2 测试）— 最高优先级

### 0.1 问题定义

`electron-builder` 打包时，其 Go 二进制 `app-builder.exe` 调用 `EnsureEmptyDir` 清空输出目录（`release-v3/win-unpacked/`），但 Windows Defender（`MsMpEng.exe`）的实时扫描会立刻锁住新生成的 `app.asar` 文件。这导致 electron-builder 报错 `The process cannot access the file because it is being used by another process`，构建失败。

执行人被迫采用"换目录名"的变通策略（`release-v3` → `release-v3b` → `release-v3c`），每次构建都在新目录产生 300-400 MB 产物，旧目录因文件锁无法清理。截至本次审计，项目根目录积累了 12 个 stale release 目录，占用近 2 GB 磁盘空间。`electron-builder.yml` 虽然有注释"固定输出目录，避免 release-v12/release-v13 并存导致误启动旧版本"，但锁文件问题使这个设计意图无法执行。

**类比：** 这像一个面包房每次烤好面包（构建产物），卫生检查员（Defender）就冲过来检查，把面包锁在烤箱里不让拿出来。面包房的应对方法是每烤一次就换一个烤箱（换目录名），但旧烤箱里的面包拿不出来，烤箱越积越多。真正的解法是让卫生检查员跳过这个面包房（排除项），或者等检查完再锁门（重试机制）。

**三维优先级评估：** 业务价值 3 分（直接阻断开发效率）+ 实现成本 1 分（脚本级改动）+ 紧急程度 3 分（每次构建都可能失败）= 7/10，但因阻断性最高，执行顺序排第一。

### 0.2 设计方向

**方向一：Windows Defender 排除项引导。** 在 `scripts/` 中新增 `setup-dev-env.ps1` 脚本，执行 `Add-MpPreference -ExclusionPath` 将项目目录加入 Defender 排除列表。脚本需要检测管理员权限并在不足时提示用户以管理员身份运行。此脚本应在 `README.md` 的"开发环境搭建"章节中引导执行人首次克隆后运行。

**方向二：构建前清理脚本（pre-build hook）。** 在 `package.json` 中新增 `predist:electron` 脚本（npm 的 pre-hook 机制会在 `dist:electron` 之前自动执行），内容：

1. 终止所有 Electron/RouteDev 相关进程（`taskkill /F /IM RouteDev.exe` 等，忽略不存在的情况）
2. 等待 2 秒让文件句柄释放
3. 尝试删除 `release-v3/win-unpacked/` 目录（用 Node.js 的 `fs.rmSync` 带 `{ recursive: true, force: true, maxRetries: 3, retryDelay: 1000 }` 参数）
4. 如果删除失败（仍被锁），自动切换到备用目录名（`release-v3-{timestamp}`），而不是简单递增版本号

**方向三：构建后清理 stale 目录。** 在 `electron-builder.yml` 中配置 `afterPack` 钩子脚本，构建成功后自动清理所有名称匹配 `release-v*` 但不是当前输出目录的文件夹。逻辑：枚举项目根目录 → 匹配 stale 模式 → 跳过当前 `directories.output` 的值 → 删除其余目录。

**方向四：electron-builder 重试包装。** 如果以上方案仍偶尔失败（Defender 扫描有时在排除项生效前就锁住文件），可以编写一个 Node.js 包装脚本替代直接调用 `electron-builder`：最多重试 3 次，每次重试前等待 5 秒并尝试清理输出目录。

### 0.3 配置设计

```typescript
// scripts/clean-release.ts
interface CleanOptions {
  // 保留的输出目录（来自 electron-builder.yml 的 directories.output）
  keep: string;
  
  // 匹配 stale 目录的正则
  stalePattern: RegExp;
  
  // 是否实际执行删除（false 时只打印将要删除的目录）
  dryRun: boolean;       // 默认: false
  
  // 最大重试次数（删除失败时）
  maxRetries: number;    // 默认: 3
  
  // 重试间隔（毫秒）
  retryDelayMs: number;  // 默认: 1000
}
```

### 0.4 思考引导

- `predist:electron` 钩子会在**每次** `pnpm run dist:electron` 时执行，包括正常构建。确保脚本在"没有 stale 目录"的正常情况下也能安静通过（不报错、不输出多余信息）。
- Defender 排除项需要管理员权限，但构建脚本不应该要求管理员权限。分离这两件事：排除项是一次性环境配置（手动运行），构建清理是每次自动执行。
- `afterPack` 钩子脚本的执行时机：是在 electron-builder 完成打包后、生成安装包前。如果在这个阶段清理 stale 目录，要注意不要删掉当前构建的产物。
- 重试包装脚本是否必要？如果 Defender 排除项生效，理论上不需要重试。但排除项可能被系统策略覆盖（企业环境），所以作为最后一道防线保留。建议默认不启用，只在排除项无效时手动开启。
- 在 `AGENTS.md` 中新增陷阱：执行人首次构建失败时，**不要手动改 `electron-builder.yml` 的 output 字段来绕过**——这正是导致 stale 目录膨胀的原因。应该先运行 `setup-dev-env.ps1`。

---

## Task 1：渐进式信任权限系统（≥ 8 测试）

### 1.1 问题定义

PermissionEngine 的三态系统无法表达"这个操作我之前确认过了，下次自动放行"这种渐进式信任场景。TrustGradientManager 已实现完整的 7 级信任梯度和临时授权机制，但从未接入生产路径。用户面临两难：要么每次操作都被打断确认（影响效率），要么开启 YOLO 模式承担安全风险。

社区痛点 11 将此定性为安全与效率的核心矛盾。审计报告 C-04（permission engine auto-file-wildcard 自动批准 file_write/edit）进一步证实了当前系统的粗放性。

**三维优先级评估：** 业务价值 4 分（解决头号 UX 痛点）+ 实现成本 2 分（死代码激活，改动量小）+ 紧急程度 2 分（安全审计 Critical 级）= 8/10，最高优先级。

### 1.2 设计方向

**方向一：TrustGradientManager 接线。** 在 `app-init.ts` 的 `createDefaultEngine()` 调用后实例化 TrustGradientManager，注入 `ServiceContext`（需要新增 `trustGradientManager?: TrustGradientManager` 字段）。PermissionEngine 的 `check()` 方法增加一个前置查询：如果 TrustGradientManager 的 `checkOperation()` 返回"临时放行"，则跳过 confirm 直接返回 auto。优先级：临时授权 > 静态规则 > 默认 confirm。

**方向二：五级操作风险分类。** 为 PermissionEngine 的规则系统引入 `riskLevel` 字段（`read | write | execute | network | push`），每个 `PermissionRule` 标记风险等级。TrustGradientManager 的各级别对应不同的风险容忍阈值：`default` 级别只自动放行 `read` 级操作，`acceptEdits` 级别放行 `read` + `write`，`acceptAll` 级别放行 `read` + `write` + `execute`，以此类推。

**方向三：偏好持久化。** 用户确认某类操作（如对 `file_write` 在 `src/` 目录下放行）后，TrustGradientManager 将该偏好写入 `.routedev/trust-preferences.json`。下次启动时加载，避免重复确认。偏好记录格式：`{ toolPattern, argsPattern, riskLevel, grantedAt, expiresAt? }`。

**方向四：`/trust` 命令。** 在 CommandRegistry 中注册 `/trust` 命令，功能包括：查看当前信任级别（`/trust status`）、手动调整级别（`/trust level acceptEdits`）、查看已记忆的偏好列表（`/trust prefs`）、清除偏好（`/trust reset`）。

**方向五：Windows 安全规则补全。** 当前 DEFAULT_DENY_RULES 的 Windows 路径归一化已处理反斜杠和系统目录检查，但缺少对 Windows 特有危险命令的 deny 规则：`format`（格式化磁盘）、`diskpart`（磁盘分区操作）、`reg delete`（注册表删除）、`bcdedit`（引导配置修改）、`netsh firewall`（防火墙规则修改）。这些应加入 DEFAULT_DENY_RULES 的 Windows 补充集。

### 1.3 配置设计

```typescript
// 新增配置字段（SettingsPage → Security 选项卡）
interface TrustSettings {
  // 初始信任级别（每次启动时恢复的基准级别）
  baseLevel: TrustLevel;           // 默认: 'default'
  
  // 是否启用临时授权（会话内自动记住已确认的操作）
  enableTemporaryGrants: boolean;  // 默认: true
  
  // 临时授权的 TTL（分钟）
  grantTTLMinutes: number;         // 默认: 30
  
  // 是否启用跨会话偏好持久化
  enablePersistentPreferences: boolean; // 默认: false（用户主动开启）
  
  // 偏好持久化的最大条目数
  maxPersistentGrants: number;     // 默认: 200
}
```

### 1.4 思考引导

- TrustGradientManager 的 `checkOperation()` 和 PermissionEngine 的 `check()` 应该谁先调用？考虑"洋葱模型"（Phase 38 中间件）——权限检查应该在中间件管道的 `onActing` 阶段执行，TrustGradient 查询是 PermissionEngine 内部逻辑，不应暴露给中间件。
- 临时授权的 SHA-256 参数哈希当前用于精确匹配。如果用户对 `file_write` 在 `src/utils/` 下放行，但 Agent 写入 `src/utils/helpers/format.ts`，路径层级不同是否算匹配？建议采用"前缀匹配"而非"精确匹配"来适应目录层级。
- Windows deny 规则的添加需要考虑命令别名问题——`format.com`、`diskpart.exe` 等完整路径和短名称都应覆盖。与 Phase 38 的 `ShellInjectionGuard` 中间件协同：ShellInjectionGuard 拦截注入模式，deny 规则拦截危险命令本身。
- `trust-preferences.json` 的安全性：文件存储在 `.routedev/` 目录下，是否需要签名或完整性校验？如果攻击者能修改这个文件，就能提升自己的信任级别。建议加入 HMAC 校验。

---

## Task 2：确定性路由与混合决策（≥ 7 测试）

### 2.1 问题定义

ScenarioClassifier 的 4 级分类（`simple | medium | complex | reasoning`）将所有非命令正则匹配的输入都送入 LLM 分类。这意味着用户输入 `/cost`、`现在几点`、`列出 src 目录下的文件` 这类完全可以用规则处理的请求，也要消耗一次 LLM 分类调用的 Token。在高频使用场景下，这些"微消耗"累积可观。

此外，`ModelRouter` 的路由决策基于分类结果选择模型，但没有"完全不调用 LLM"的路径——即使任务本身是确定性的（如执行一条斜杠命令、返回帮助信息），仍然经过 LLM 路由。

**三维优先级评估：** 业务价值 3 分（降低简单任务 Token 消耗）+ 实现成本 2 分（扩展现有枚举+规则表）+ 紧急程度 3 分（42% 开发者成本焦虑的直接回应）= 8/10。

### 2.2 设计方向

**方向一：`deterministic` 分类级别。** 在 `ScenarioTier` 枚举中新增 `'deterministic'` 级别，优先级高于 `'simple'`。当输入被判定为 deterministic 时，跳过 LLM 分类，直接由规则引擎处理。`ClassificationResult` 的 `source` 字段增加 `'deterministic'` 来源标识。

**方向二：确定性快速通道规则表。** 在 ScenarioClassifier 的分类策略链中，在"命令正则匹配"之后、"LLM 分类"之前，插入一层"确定性规则匹配"。规则表覆盖以下场景：

- 斜杠命令查询类：`/cost`、`/history`、`/status`、`/help`、`/trust`、`/quality` → 直接返回预定义响应
- 简单信息查询：当前时间、系统状态、配置值读取 → 直接返回结果
- 纯文件读取操作（无分析需求）：`读取 xxx 文件` → 调用 file_read 工具，跳过 LLM 分析层

规则表应支持配置扩展，用户可以在 `.routedev/deterministic-rules.json` 中自定义规则。

**方向三：与 TaskComplexityAnalyzer 协调。** `TaskComplexityAnalyzer`（`src/agent/complexity-analyzer.ts`）已有独立的规则优先层。为避免两套规则系统并行造成维护负担，建议将确定性规则表作为共享基础设施——ScenarioClassifier 和 TaskComplexityAnalyzer 都从同一个规则源读取，只是使用方式不同（Classifier 用于分类，Analyzer 用于复杂度评估）。

**方向四：deterministic 路由策略。** ModelRouter 接收到 `tier: 'deterministic'` 的分类结果时，直接使用最低成本的模型（或本地规则引擎），不经过正常的路由决策链。这可以跳过模型 API 调用，实现零 Token 消耗和近零延迟。

### 2.3 配置设计

```typescript
// ScenarioTier 扩展
type ScenarioTier = 'deterministic' | 'simple' | 'medium' | 'complex' | 'reasoning';

// 确定性规则格式
interface DeterministicRule {
  // 匹配模式（正则或精确匹配）
  pattern: string;
  
  // 匹配类型
  matchType: 'exact' | 'regex' | 'startsWith';
  
  // 处理方式
  handler: 'direct-response' | 'tool-direct' | 'command-dispatch';
  
  // 预定义响应模板（handler 为 direct-response 时使用）
  responseTemplate?: string;
  
  // 目标工具名（handler 为 tool-direct 时使用）
  targetTool?: string;
  
  // 目标命令名（handler 为 command-dispatch 时使用）
  targetCommand?: string;
}

// 分类结果扩展
interface ClassificationResult {
  tier: ScenarioTier;
  confidence: number;
  reasoning: string;
  source: 'rule' | 'llm' | 'deterministic' | 'fallback';
  // 新增：匹配到的确定性规则 ID（如果 source 为 deterministic）
  matchedRuleId?: string;
}
```

### 2.4 思考引导

- `deterministic` 级别的误判风险：如果规则过于宽泛，可能把需要 LLM 分析的请求误判为确定性。例如用户说"帮我分析一下这个文件"虽然包含文件路径，但需要 LLM 理解分析需求。建议采用保守策略——只有精确匹配和高置信度正则才进入 deterministic 通道，模糊输入一律送入 LLM。
- `direct-response` 类型的响应模板需要国际化支持吗？当前 RouteDev 面向中文用户为主，但如果未来国际化，模板应该是 key-value 映射而不是硬编码字符串。建议预留 i18n 接口。
- 确定性规则表和 Phase 38 的 `PackageValidationMiddleware` 有潜在交集——当 deterministic 通道直接执行 `npm install` 类操作时，中间件管道仍应触发包名验证。确保 deterministic 快速通道不绕过安全中间件。
- TaskComplexityAnalyzer 的规则优先层和 ScenarioClassifier 的确定性规则表如果产生冲突（一个判定为 deterministic，另一个判定为 simple），以哪个为准？建议 deterministic 判定需要两方一致才生效，否则降级为 simple。

---

## Task 3：Agent 质量监测与隐式反馈闭环（≥ 8 测试）

### 3.1 问题定义

ModelRouter 的熔断器（5 次连续失败 → 30 秒熔断）只监测"模型有没有返回响应"，不监测"返回的响应好不好"。一个模型可能每次都成功返回，但返回的代码质量很差——当前系统无法感知这种情况。

AuditLogger 记录了 20+ 种操作类型，但缺少记录用户满意度的维度。用户执行 `/rollback`、在 Agent 输出后立刻手动修改、重复发送相同指令等行为都是强烈的不满信号，但这些信号没有被捕获。

KnowledgeGraph（Phase 38 补全了 `improve()` 方法）的反馈闭环需要自动触发源——目前 `improve()` 只能被显式调用，没有机制在用户行为中自动检测"这条知识被验证了"或"这条知识导致了错误"。

**三维优先级评估：** 业务价值 3 分（持续优化的数据基础）+ 实现成本 2 分（审计日志扩展+信号检测）+ 紧急程度 2 分（96% 不信任的长期回应）= 7/10。

### 3.2 设计方向

**方向一：质量信号采集中间件。** 利用 Phase 38 激活的中间件管道，新增 `QualitySignalMiddleware`（`onActing` 阶段），在每次工具调用完成后采集质量信号：

- 工具调用是否成功（基础信号）
- 工具结果是否包含错误模式（如编译错误、类型错误、运行时异常）
- 同一工具在短期内是否被重复调用（可能表示第一次结果不满意）

信号写入 `AuditLogger` 的新增字段，不阻断执行流。

**方向二：隐式反馈检测器。** 新增 `ImplicitFeedbackDetector` 模块，监听以下用户行为模式并生成反馈信号：

| 行为模式 | 信号类型 | 含义 |
|---------|---------|------|
| 用户在 Agent 输出后立刻手动编辑同文件 | `output_edited` | 输出质量不满意 |
| 用户执行 `/rollback` | `action_rolled_back` | 操作方向错误 |
| 用户重复发送语义相似的指令 | `intent_repeated` | Agent 没有理解意图 |
| 用户在 Agent 执行过程中主动打断 | `execution_interrupted` | Agent 方向偏离 |
| 用户连续 3 次拒绝确认对话框 | `confirmation_rejected` | 操作策略不被认可 |

每个信号携带 `severity`（`low | medium | high`）和 `context`（关联的文件路径、工具名、模型 ID）。

**方向三：AuditLogger 扩展。** 在 `AuditAction` 枚举中新增 `'user_feedback'` 和 `'quality_signal'`。`AuditEntry` 扩展字段：

```typescript
interface QualityMetadata {
  // 信号来源
  source: 'implicit' | 'explicit';
  
  // 信号类型
  signalType: 'output_edited' | 'action_rolled_back' | 'intent_repeated' 
            | 'execution_interrupted' | 'confirmation_rejected';
  
  // 严重程度
  severity: 'low' | 'medium' | 'high';
  
  // 关联的模型 ID（触发该信号的模型）
  modelId?: string;
  
  // 关联的知识图谱节点 ID（如果可追溯到某条知识）
  knowledgeNodeId?: string;
}
```

**方向四：质量聚合与模型反馈。** 新增 `QualityAggregator` 模块，按模型 ID 聚合质量信号：每个模型的"负面信号率"（负面信号次数 / 总调用次数）。当某模型的负面信号率超过阈值（如 40%）时，向 ModelRouter 发送降级建议。ModelRouter 的路由决策中增加"质量权重"维度——不只是"模型是否可用"（当前），还要考虑"模型最近表现好不好"。

这与字节手册 10.1.1 的"多模型 Fallback 机制"直接呼应——手册描述的是"当主模型响应准确率低于阈值时自动切换备用模型"。RouteDev 的变体是：用隐式反馈信号而非显式准确率来触发切换。

**方向五：`/quality` 命令。** 在 CommandRegistry 中注册 `/quality` 命令，展示质量仪表盘：

- 各模型的调用次数、成功率、负面信号率
- 最近 N 次隐式反馈信号的时间线
- 总体任务完成率估算（基于 rollback 和重复指令比例）

**方向六：KnowledgeGraph `improve()` 自动触发。** 当隐式反馈检测器生成信号时，如果当前上下文中有关联的知识图谱节点（例如 Agent 基于某条知识做出了决策），自动调用 `improve()`：`output_edited` 和 `action_rolled_back` 信号触发 `outcome: 'incorrect'`（降低置信度），连续无负面信号的调用触发 `outcome: 'correct'`（提升置信度）。

### 3.3 配置设计

```typescript
// 质量监测配置
interface QualityMonitorSettings {
  // 是否启用隐式反馈检测
  enableImplicitFeedback: boolean;    // 默认: true
  
  // 负面信号率降级阈值（超过此比例建议 ModelRouter 降级）
  negativeSignalThreshold: number;    // 默认: 0.4
  
  // 质量信号保留天数（过期自动清理）
  signalRetentionDays: number;        // 默认: 30
  
  // 是否自动触发 KnowledgeGraph improve()
  autoImproveKnowledgeGraph: boolean; // 默认: true
  
  // 隐式反馈检测的去抖时间（毫秒）
  // 例如：用户编辑输出后 5 秒内又撤销，不算 output_edited
  debounceMs: number;                 // 默认: 3000
}
```

### 3.4 思考引导

- 隐式反馈的误判问题是核心难点。用户手动编辑 Agent 输出不一定是"不满意"——可能只是补充细节或调整格式。建议引入"编辑距离"阈值：只有编辑幅度超过一定比例（如 30% 行被修改）才算 `output_edited` 信号。
- `execution_interrupted` 信号的检测时机：在 Agent 的 tool-call 循环中，用户中断是通过什么机制实现的？需要检查当前 loop.ts 的中断处理路径，确保信号采集不影响中断响应速度。
- QualityAggregator 的模型反馈和 ModelRouter 的熔断器应该独立运作还是统一？建议保持独立——熔断器处理"可用性"（硬故障），QualityAggregator 处理"质量"（软评估）。两者的输出共同影响路由决策，但触发条件和恢复机制不同。
- `/quality` 命令的输出格式：CLI 端应该使用纯文本表格（兼容终端），Desktop 端可以渲染图表。考虑 Phase 34 的 OutputStyle 系统对输出格式的影响。
- `improve()` 的自动触发频率需要控制——如果每次工具调用都触发，可能产生大量小幅度置信度调整，造成知识图谱"噪声"。建议采用批量模式：每 N 次信号聚合后一次性调用 `improve()`。

---

## Task 4：用户经验适配层（≥ 5 测试）

### 4.1 问题定义

社区调研痛点 13（效率悖论）和痛点 15（初级产出暴增、审查瓶颈）揭示了一个关键矛盾：不同经验水平的开发者对 Agent 行为的期望截然不同。初级开发者希望 Agent 主动解释每步操作、附带详细注释、操作前询问确认；资深开发者希望 Agent 最小化输出、批量操作、减少确认步骤。

当前 RouteDev 对所有用户采用相同的行为模式。字节手册第 9.2.2 节的三级人才培养路径（新手 0-6 月 → 骨干 6-18 月 → 专家 18 月+）提供了分级适配的参考模型。

**三维优先级评估：** 业务价值 3 分（解决效率悖论）+ 实现成本 2 分（配置层 + prompt 注入）+ 紧急程度 1 分（非阻塞性增强）= 6/10。

### 4.2 设计方向

**方向一：`userExpertise` 配置。** 在 Settings 中新增用户经验等级配置：

```typescript
type UserExpertise = 'beginner' | 'intermediate' | 'expert';
```

首次启动时通过引导式问答帮助用户选择等级（3 个问题，基于回答自动推荐）。用户可以随时在 Settings 中修改。

**方向二：行为差异化。** 三个等级在以下维度差异化 Agent 行为：

| 维度 | beginner | intermediate | expert |
|------|----------|-------------|--------|
| 解释详细度 | 每步操作附带意图说明 | 仅关键决策附带说明 | 最小化输出，仅结果摘要 |
| 确认频率 | 所有 write/execute 操作前确认 | 仅 execute/network 操作确认 | 仅 push/delete 操作确认 |
| 代码注释 | 生成代码附带详细注释 | 仅在复杂逻辑处注释 | 不主动添加注释 |
| 批量操作 | 禁用（逐步执行） | 启用（最多 3 个文件） | 启用（无限制） |
| 错误处理 | 立即报告，建议修复方案 | 尝试自动修复，失败后报告 | 静默重试（最多 2 次），仍失败才报告 |
| 学习提示 | 操作后附带"为什么这样做"的简短解释 | 仅在用户追问时解释 | 不解释 |

**方向三：与 OutputStyle 协同。** Phase 34 的 OutputStyle 系统控制输出格式（`concise | detailed | structured`）。`userExpertise` 应该影响 OutputStyle 的默认值但不锁定它：`beginner` 默认 `detailed`，`intermediate` 默认 `structured`，`expert` 默认 `concise`。用户可以在 Settings 中独立修改 OutputStyle，覆盖默认值。

**方向四：System Prompt 注入。** `userExpertise` 通过 `onSystemPrompt` 中间件阶段（Phase 38 激活）注入到系统提示词中。不同等级注入不同的行为指令片段：

- `beginner`：注入"请在每次操作前简要说明意图，在代码中包含解释性注释，在操作完成后总结学到了什么"
- `intermediate`：注入"请在关键架构决策时说明理由，对复杂逻辑添加注释"
- `expert`：注入"请最小化文本输出，批量执行操作，仅在遇到异常时详细说明"

**方向五：引导式等级选择。** 首次启动时展示 3 个问题：

1. "你对当前项目使用的编程语言/框架的熟悉程度？" → 高/中/低
2. "你希望 Agent 在操作前征求你的确认吗？" → 总是/仅复杂操作/尽量不
3. "你使用 AI 编程工具的经验？" → 新手/有基础/熟练

根据回答加权计算推荐等级。用户可以选择接受推荐或手动选择。

### 4.3 配置设计

```typescript
interface UserExpertiseSettings {
  // 用户经验等级
  level: UserExpertise;                // 默认: 'intermediate'
  
  // 是否允许 Agent 根据行为自动建议等级调整
  enableAutoSuggestion: boolean;       // 默认: true
  
  // 覆盖 OutputStyle 默认值（null 表示使用 expertise 默认值）
  outputStyleOverride: OutputStyle | null;  // 默认: null
  
  // 各维度的独立覆盖（允许细粒度调整）
  overrides?: {
    explanationDetail?: 'none' | 'key-only' | 'full';
    confirmationFrequency?: 'always' | 'risky-only' | 'minimal';
    batchOperationLimit?: number;  // 0 = 禁用, -1 = 无限制
  };
}
```

### 4.4 思考引导

- `userExpertise` 和 Task 1 的 TrustLevel 有交互：`expert` 用户的默认信任级别是否应该更高？建议解耦——信任级别由安全策略决定，经验等级由行为偏好决定。一个 beginner 用户也可能选择高信任级别（"我相信 Agent 的判断"），一个 expert 用户也可能选择低信任级别（"我要审查每步操作"）。
- 自动等级调整建议的触发条件：如果用户频繁手动编辑 Agent 输出（beginner 特征），系统建议升级到 intermediate？还是建议保持 beginner 并增加解释？这需要谨慎设计——错误的建议可能冒犯用户。建议采用"用户主动询问时再建议"的保守策略。
- System Prompt 注入的长度控制：beginner 的指令片段最长（需要详细的行为约束），expert 的最短。这些注入的 token 数量需要纳入 ContextCompactor 的预算管理——不能因为 beginner 的系统提示词更长就挤占用户上下文空间。
- 引导式等级选择的 3 个问题需要在 CLI 端和 Desktop 端分别设计交互：CLI 端使用交互式选择题（类似 Ink 的 Select 组件），Desktop 端使用卡片式 UI。
- 考虑与 Phase 37 的需求澄清追问系统的交互：`beginner` 用户在收到 Agent 追问时可能需要更多上下文来理解问题，追问的措辞应该根据经验等级调整。

---

## Task 5：集成测试与文档同步（≥ 2 测试）

### 5.1 跨 Task 集成测试

验证四个 Task 之间的协同工作流：

**测试场景一：deterministic 命令 + 渐进式信任联动。** 用户输入 `/trust prefs`（deterministic 命令），TrustGradientManager 的偏好列表读取是 read 级操作，应该被自动放行（不弹确认）。验证 deterministic 通道正确路由到直接响应，且权限检查正确识别为 read 级自动放行。

**测试场景二：隐式反馈 + 质量聚合 + 模型降级联动。** 模拟连续 5 次 Agent 输出被用户手动编辑（`output_edited` 信号），QualityAggregator 计算负面信号率超过阈值，向 ModelRouter 发送降级建议。验证下次路由决策选择了备用模型。

**测试场景三：userExpertise + 权限确认联动。** `beginner` 用户执行 file_write 操作时，即使 TrustGradientManager 有临时授权，系统仍应弹出确认（因为 beginner 的行为差异化要求确认所有 write 操作）。验证 userExpertise 的确认频率设置能覆盖 TrustGradientManager 的自动放行。

**测试场景四：deterministic 通道 + 安全中间件联动。** 通过 deterministic 通道执行的 `npm install` 命令仍应触发 Phase 38 的 PackageValidationMiddleware。验证确定性快速通道不绕过安全中间件。

### 5.2 EXECUTION_STATUS 更新

完成后更新 EXECUTION_STATUS.md 的 Phase 40 行状态和规划摘要。

### 5.3 BLUEPRINT 兼容性检查

确认四个 Task 的设计方向与 BLUEPRINT.md 的核心原则一致：模型路由（Task 2 增强）、本地优先（Task 1 本地偏好持久化）、渐进式安全（Task 1 + Task 3）、用户体验分层（Task 4）。

---

## 新增陷阱警告

1. **陷阱 #53：TrustGradientManager 和 PermissionEngine 的优先级冲突。** 如果 TrustGradientManager 的临时授权和 PermissionEngine 的 deny 规则冲突（例如某工具被 deny 规则禁止，但有临时授权），应以 deny 为准。执行顺序：deny 检查 → trust gradient 检查 → confirm/auto 检查。绝不能让临时授权绕过 deny 规则。

2. **陷阱 #54：deterministic 通道的 LLM 分类器旁路。** 新增 `'deterministic'` 到 `ScenarioTier` 后，所有消费 `ClassificationResult` 的模块都需要处理这个新值。特别是 ModelRouter 的 `route()` 方法——如果它不认识 `deterministic`，可能会走到 fallback 链或抛出错误。检查 `src/router/router.ts` 中所有 switch/if 分支。

3. **陷阱 #55：隐式反馈的去抖与竞态。** `output_edited` 信号需要区分"用户在 Agent 输出后编辑"和"用户本来就在编辑，Agent 恰好完成了"。时间窗口太短会漏报，太长会误报。建议参考 Agent 输出完成的精确时间戳，只在完成后 N 秒内的编辑才算信号。

4. **陷阱 #56：userExpertise 注入 System Prompt 的 Token 预算。** beginner 级别的行为指令片段约 80-120 tokens，expert 约 20-30 tokens。这些额外 tokens 需要从 ContextCompactor 的预算中扣除，否则 beginner 用户的有效上下文窗口比 expert 小——这与"beginner 需要更多帮助"的初衷矛盾。

5. **陷阱 #57：QualityAggregator 的冷启动问题。** 新用户没有历史质量数据，QualityAggregator 无法提供有意义的模型质量评估。建议设置冷启动期（前 50 次调用），期间不使用质量权重，仅依赖可用性路由。

6. **陷阱 #58：`trust-preferences.json` 的并发写入。** 如果用户同时打开多个 RouteDev 实例（Desktop 端多窗口），多个进程可能同时读写 `trust-preferences.json`。需要文件锁或原子写入（write-to-temp + rename）来避免数据损坏。

7. **陷阱 #59：构建失败时不要改 output 目录名。** 当 `electron-builder` 报 `The process cannot access the file because it is being used by another process` 时，根因是 Windows Defender 锁 `app.asar`，而不是输出目录名冲突。手动改 `electron-builder.yml` 的 `directories.output` 字段只会产生更多 stale 目录。正确做法：先运行 `scripts/setup-dev-env.ps1` 添加 Defender 排除项，然后重试构建。

---

## 思考引导总结

本 Phase 的五个 Task 分为两层：基础设施保障（Task 0）和用户价值闭环（Task 1-4）。

**Task 0（构建加固）** 解决"能不能顺利构建"——这是所有后续 Task 的前提。如果构建管道不稳定，其他 Task 的代码写得再好也无法验证。根因是 Windows Defender 锁文件，解决方案分三层：排除项（治本）、pre-build 清理（治标）、重试包装（兜底）。执行人接到 Phase 40 后应该**第一件事就跑 `setup-dev-env.ps1`**，而不是先写代码。

**Task 1（渐进式信任）** 解决"安全与效率的平衡"——用户不需要在 YOLO 和频繁确认之间二选一。核心设计决策是"信任是可以积累的"：用户确认过的操作模式，下次自动放行。这与字节手册"混合决策"理念一致——规则能处理的不用 LLM，已确认过的不再打断。

**Task 2（确定性路由）** 解决"Token 浪费"——简单操作不应该消耗 LLM 资源。这是字节手册"规则引擎 + 大模型"混合决策在 RouteDev 中的直接实现。关键边界是保守策略：宁可多送一次 LLM，也不要把需要分析的请求误判为确定性。

**Task 3（质量监测）** 解决"Agent 好不好用"——从只看"有没有响应"升级到看"响应好不好"。这是字节手册"数据闭环迭代"方法论的落地。隐式反馈检测器是核心创新——不需要用户主动评价，从行为模式中自动推断满意度。

**Task 4（经验适配）** 解决"一刀切的效率悖论"——不同水平的开发者需要不同的 Agent 行为。这直接回应了社区调研中最具差异化的痛点：初级开发者需要引导，资深开发者需要效率。

执行顺序建议：**Task 0（构建加固）→ Task 1 → Task 2 → Task 3 → Task 4**。Task 0 最先执行（5 分钟搞定环境配置），Task 1 和 Task 2 是基础设施层（权限和路由）可以并行开发，Task 3 是监测层（质量信号依赖路由数据），Task 4 是适配层（行为差异化依赖权限和监测的反馈）。Task 3 和 Task 4 需要等前两者稳定后再接入。

与已有 Phase 的依赖关系：Task 1 依赖 Phase 38 的中间件管道（`onActing` 阶段的权限检查）；Task 3 依赖 Phase 38 的 `improve()` 方法和中间件的 `onActing` 阶段；Task 4 依赖 Phase 38 的 `onSystemPrompt` 阶段和 Phase 34 的 OutputStyle 系统；Task 2 相对独立，主要修改 `src/router/` 下的模块；Task 0 无外部依赖，纯构建脚本层面。
