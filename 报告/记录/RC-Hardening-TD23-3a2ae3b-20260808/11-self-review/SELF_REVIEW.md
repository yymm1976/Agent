# SELF_REVIEW — PHASE O

> 以未参与实现的 reviewer 身份复核本轮 diff。每个条目：查了什么 / 为什么可能出错 / 怎么验证 / 结果。

## 新代码 edge cases

1. **normalizeExecutableIdentity 的 wholeAsExecutable 分支**：validateExecution 传含空格盘符路径（无引号）时 strip 引号逻辑——`C:\Program Files\node.exe` 带引号传入（`"C:\Program Files\node.exe"`）→ strip ✓；不带引号 → 整体 ✓。**edge**：命令以引号开头但未以引号结尾（`"C:\Program Files\node.exe --v`）→ stripOuterQuotes 不匹配（end 不是 `"`）→ 整体含引号 → basename 错。**验证**：validateExecution 的 command 语义是"spawn 参数"，调用方应传裸路径；测试覆盖裸路径与带引号 ✓。结果：可接受（结构化接口契约）。
2. **checkRmPolicy 的 `--` 后 target**：`rm -rf -- /` → sawDoubleDash → targets=['/'] → 危险 ✓ 测试覆盖。**edge**：`rm --recursive /`（long 不带 -f）→ recursive=true → target '/' 危险 ✓。
3. **audit restoreChainHead 的尾行 JSON 部分损坏**：尾行非 JSON → catch → genesis 新链（旧记录 verify 失败 = tamper-evident ✓ 不静默修复）。**edge**：尾行是 JSON 但非 HashChainRecord（无 hash）→ 显式告警 + genesis ✓（测试覆盖损坏用例）。
4. **ensureRevisions 的 tmp 文件残留**：写入中途 crash → `.json.tmp` 残留 → 下次 readdir 会把它当版本文件（JSON parse 失败 → corrupt 跳过 ✓ 但文件名含 .tmp 结尾 `.json`？`file.json.tmp` endsWith('.json') = false → 忽略 ✓）。结果：安全。
5. **fixed-width base36 的 seq 溢出**：36^6 ≈ 2.1e9 次调用后进位——单进程内不可能；跨进程重启 seq 重置 + 随机分量区分 ✓。

## concurrency / lifecycle

1. **B1 清理顺序**：finally 中 currentReasoningEffort 清理在 emitEngineEvent(agent_end) 之后——agent_end 事件消费方读不到 run 参数 ✓ 正确顺序。
2. **restoreChainHead 与并发写**：多 logger 同 session 并发写（同文件 append）——JSONL append 原子性（单行）✓；chain head 竞争：两个 logger 同时 append 会各自用不同 previousHash → 链分叉（verify 失败）。**single-flight 下无此场景**；记录 P3。
3. **ensureRevisions 与 saveVersion 并发**：两进程同时 save → revision 竞争（都读 max=1 → 都写 2）→ 同 revision 两个版本。**单进程 single-flight 无此场景**；记录 P3（分布式锁非当前目标）。

## migration / compatibility

1. **AuditRecord 加 eventId 可选字段**：旧 JSONL 无 eventId → verifyChain canonical 含 eventId: undefined → JSON.stringify 丢键 → 旧记录 hash 与新 computeHash 不匹配？**旧记录是在旧算法下签名的**——verifyChain 重算用新 canonical → 旧记录 hash 必然不匹配 → **旧链 verify 失败**！这是 migration 风险：升级后历史审计链全部验证失败（tamper 误报）。
   **验证**：audit-logger 测试都是新写入的。**结果**：**确认风险**——GA 前需 migration（旧链重签或按算法版本验证）或文档化"升级后历史链失效"。
2. **VersionMeta.revision 必填**：旧持久化文件无 revision → JSON.parse 后 meta.revision undefined → ensureRevisions 迁移 ✓ 已处理。
3. **sandbox canonicalName 语义变化**：`rm` 白名单匹配 canonical（strip .com 等）——旧配置 `allowedCommands: ['format.com']` 现在匹配 'format'？白名单比较 `c === cmdNameFromFirst`——canonical 是 'format'，配置 'format.com' 不匹配！**旧配置兼容性**：用户白名单含扩展名形式会失效。记录 P3（配置迁移文档）。

## security / trust

1. **executableToken 盘符分支**：`C:\path\node.exe extra`（无引号含参数）→ split 空格取第一段 ✓；`C:\Program Files\node.exe`（无引号）→ 第一段 'C:\Program' ✗ 拒绝（需引号）——文档化契约 ✓（拒绝侧安全）。
2. **checkDangerousPolicy 的 shell 判定**：`bash script.sh`（无 -c）放行——脚本内容风险由脚本本身承担（工具层）。可接受（任务允许）。
3. **sanitizeFrame 泄露检查**：TD-23 trace 只记录 type/finish/usage/tool ids——无 content 全文 ✓。检查 R4-round1/2 文件确认无 reasoning 全文 ✓（已 grep 未见）。

## provider / protocol

1. **R6 真实帧序**：usage 尾块在 done 前 ✓；**done 事件不含 usage**（RouteDev 的 done 是流结束信号，usage 独立事件）——消费方（loop 的 LLMStreamResult.usage）从 usage 事件收集 ✓。
2. **R4 400 两次**：第一次 tools 格式（脚本错），第二次 messages 格式（脚本错）——**都非 RouteDev 协议 bug**；修正后 PASS。记录为真实协议观察（DeepSeek 严格校验请求体）。
3. **R9 取消**：SDK signal 透传 → HTTP abort → parser settle ✓ 真实验证。

## 自审结论

- **确认 1 个 migration 风险（P2）**：AuditRecord canonical hash 升级后历史链验证失败——需迁移或文档化
- 其余 edge cases 均可接受（拒绝侧安全 / 文档化契约 / single-flight 无并发场景）
