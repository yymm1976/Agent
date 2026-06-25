# RouteDev CI 集成安全规范

> 适用范围：GitHub Actions / GitLab CI / Jenkins 等 CI 系统中运行 RouteDev 的场景
> 版本：v1.0（Phase 47 Task 9）
> 关联陷阱：#141（config Base64 传输）、#16（环境变量 fail-fast）

## 1. 密钥管理

### 1.1 API Key 必须走 CI Secrets

**禁止**将 API Key 写入以下位置：
- `config.yaml` 文件（即使 Base64 编码也不行）
- workflow YAML 的 `with:` 字段
- 代码仓库的任何文件

**正确做法**：通过 CI 系统的 Secrets 机制注入环境变量。

GitHub Actions 示例：
```yaml
env:
  ROUTEDEV_API_KEY: ${{ secrets.ROUTEDEV_API_KEY }}
```

RouteDev 配置文件中通过 `${ENV_VAR}` 引用：
```yaml
providers:
  - id: my-provider
    apiKey: ${ROUTEDEV_API_KEY}
```

### 1.2 config Base64 传输（陷阱 #141）

CI 环境下 config.yaml 内容需通过 Base64 编码传输，避免 YAML 多行字符串转义问题：
- workflow 的 `with.config` 字段只接受单行字符串
- 多行 YAML 直接传入会被 GitHub Actions runtime 错误解析
- Base64 编码后是纯 ASCII，无转义风险

生成 Base64 编码：
```bash
base64 -w 0 config.yaml  # Linux/macOS
certutil -encode config.yaml encoded.txt  # Windows（再去掉头尾）
```

在 workflow 中使用：
```yaml
with:
  config: ${{ secrets.ROUTEDEV_CONFIG_BASE64 }}
```

### 1.3 Secrets 最小化

仅授予 RouteDev 必需的 Secrets，**不要**复用其他敏感凭证：
- ✅ 独立的 `ROUTEDEV_API_KEY`
- ❌ 复用 `NPM_TOKEN` / `DOCKER_PASSWORD` 等

## 2. 权限最小化

### 2.1 工作模式选择

RouteDev 提供三种工作模式（`work-mode` input），按场景选择：

| 场景 | work-mode | 说明 |
|------|-----------|------|
| PR 代码审查 | `read-only` | 只读分析，不修改代码 |
| 自动修复 lint 错误 | `workspace-write` | 读写工作区，但禁止网络/git 写 |
| 全自动重构（高风险） | `full-access` | 全部权限，**生产环境禁止使用** |

**强制规则**：
- PR 审查场景**必须**使用 `read-only`
- 自动修复场景**推荐**使用 `workspace-write`
- `full-access` 仅限本地开发或隔离沙箱环境，**禁止**在 CI 中使用

### 2.2 GitHub Actions permissions 最小化

workflow 的 `permissions:` 字段必须显式声明，**禁止**使用默认的 `write-all`：

```yaml
# ✅ 正确：PR 审查只需读代码 + 发评论
permissions:
  contents: read
  pull-requests: write

# ❌ 错误：权限过大
permissions: write-all
```

### 2.3 工具白名单

通过 `allowed-tools` input 限制 RouteDev 可调用的工具：

```yaml
# PR 审查：仅允许只读工具
allowed-tools: 'file_read,file_search,code_search,list_directory'

# 自动修复：允许读写文件，但禁止 shell/git
allowed-tools: 'file_read,file_write,file_edit,file_search,code_search'
```

## 3. 输出处理

### 3.1 --json 输出可能含代码内容

RouteDev `exec --json` 输出 JSONL 事件流，其中：
- `tool_call_result` 事件包含工具返回内容（可能含文件内容）
- `done` 事件包含最终答案（可能含代码片段）

**敏感信息脱敏建议**：
1. 不要将完整 stdout 直接发布到 PR 评论
2. 仅提取 `done` 事件的 `content` 字段
3. 对 `tool_call_result` 中的文件内容做截断（如超过 4000 字符截断）
4. 检查输出中是否包含 API Key、密码等模式（正则匹配）

示例脱敏脚本：
```javascript
function sanitize(text) {
  // 脱敏常见密钥格式
  return text
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***REDACTED***')
    .replace(/(?:api[_-]?key|token|secret)["\s:=]+["']?[\w-]+/gi, '$1***REDACTED***');
}
```

### 3.2 输出长度限制

GitHub PR 评论有 65536 字符上限，建议：
- 审查结果超过 60000 字符时拆分为多条评论
- 或将完整结果上传为 artifact，评论中只放摘要 + 链接

```yaml
- name: Upload Full Report
  uses: actions/upload-artifact@v4
  with:
    name: routedev-review-report
    path: review-report.json
```

### 3.3 日志脱敏

GitHub Actions 日志是公开的（对 PR 而言），RouteDev 的 stderr 可能包含：
- LLM API 错误信息（可能含请求片段）
- 文件路径（可能泄露项目结构）
- 工具调用堆栈

建议在 workflow 中过滤敏感日志：
```yaml
- name: RouteDev Review
  uses: ./
  env:
    ROUTEDEV_LOG_LEVEL: warn  # 仅输出 warn 及以上
```

## 4. 网络与执行环境

### 4.1 网络限制

CI 运行环境应限制 RouteDev 的网络访问：
- ✅ 允许访问 LLM API 端点（如 `api.openai.com`）
- ❌ 禁止访问内部服务（数据库、内网 API）
- ❌ 禁止访问元数据服务（`169.254.169.254`）

GitHub Actions 的 `read-only` 工作模式会拦截 `web_fetch` / `web_search` 工具，但 LLM API 调用不受影响（属于路由层，非工具层）。

### 4.2 执行超时

CI 任务必须设置超时，避免 RouteDev 陷入死循环：
```yaml
- name: RouteDev Review
  uses: ./
  with:
    prompt: '...'
    # 通过 action input 设置超时（默认 600 秒）
```

workflow 级别也建议设置 `timeout-minutes`：
```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15  # 整个 job 超时
```

### 4.3 资源限制

GitHub Actions runner 资源有限（2 CPU / 7GB RAM），RouteDev 任务复杂度应控制：
- 单次任务 token 预算 ≤ 100K
- 单次任务工具调用 ≤ 50 次
- 通过 config.yaml 的 `router.budget.dailyLimit` 限制

## 5. 审计与可观测性

### 5.1 启用 token 追踪

```yaml
optimization:
  tokenTracking:
    enabled: true
    persistSession: true
    outputDir: ".routedev/token-logs"
```

CI 任务结束后上传 token 日志为 artifact：
```yaml
- name: Upload Token Logs
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: routedev-token-logs
    path: .routedev/token-logs/
```

### 5.2 审计日志

RouteDev 的 `audit-logger` 会记录所有工具调用，CI 环境下应：
- 将审计日志上传为 artifact（保留 90 天）
- 对敏感操作（`shell_exec` / `git_op`）设置告警

## 6. 禁止事项清单

| # | 禁止行为 | 风险 | 替代方案 |
|---|---------|------|---------|
| 1 | API Key 写入 config.yaml 文件 | 密钥泄露 | 走 Secrets 环境变量 |
| 2 | CI 中使用 `full-access` 模式 | 任意代码执行 | 使用 `read-only` 或 `workspace-write` |
| 3 | workflow 使用 `permissions: write-all` | 权限过大 | 显式声明最小权限 |
| 4 | 直接发布完整 stdout 到 PR 评论 | 泄露代码内容 | 仅提取 `done` 事件内容 |
| 5 | 不设置 timeout | 任务卡死 | workflow + action 双重超时 |
| 6 | config 不 Base64 编码 | YAML 解析错误 | 强制 Base64 传输 |
| 7 | 复用其他敏感 Secrets | 凭证扩散 | 独立 RouteDev 专用 Secret |

## 7. 检查清单（CI 集成前必填）

- [ ] API Key 通过 Secrets 注入，未硬编码
- [ ] config 通过 Base64 传输（陷阱 #141）
- [ ] work-mode 按场景选择（PR 审查用 read-only）
- [ ] workflow permissions 显式声明且最小化
- [ ] 设置了 workflow 和 action 双重超时
- [ ] 输出脱敏逻辑已实现
- [ ] token 日志上传为 artifact
- [ ] 审计日志保留策略已确认
