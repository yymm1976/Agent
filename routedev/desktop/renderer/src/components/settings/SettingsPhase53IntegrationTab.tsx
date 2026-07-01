// desktop/renderer/src/components/settings/SettingsPhase53IntegrationTab.tsx
// Phase 53 代码卫生与安全治理加固（含 10 个子任务）
// 本 Tab 聚合关键子任务的核心字段，便于快速启用 / 调参。
import type { AppConfig, Phase53IntegrationConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsPhase53IntegrationTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

/** 简易逗号分隔字符串解析为字符串数组 */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SettingsPhase53IntegrationTab({ draft, updateDraft }: SettingsPhase53IntegrationTabProps) {
  const cfg: Phase53IntegrationConfig = draft.phase53Integration ?? ({} as Phase53IntegrationConfig);

  // 整体聚合更新：透传 patch 后再回写
  const update = (patch: Partial<Phase53IntegrationConfig>) => {
    updateDraft({ phase53Integration: { ...cfg, ...patch } });
  };

  // 策略引擎（Task 3）
  const policyEngine = cfg.policyEngine ?? {};
  const updatePolicyEngine = (patch: Partial<typeof policyEngine>) => {
    update({ policyEngine: { ...policyEngine, ...patch } });
  };

  // 哈希链审计（Task 4）
  const auditChain = cfg.auditChain ?? {};
  const updateAuditChain = (patch: Partial<typeof auditChain>) => {
    update({ auditChain: { ...auditChain, ...patch } });
  };

  // MCP 安全扫描（Task 5）
  const mcpSecurityScan = cfg.mcpSecurityScan ?? {};
  const updateMcpSecurityScan = (patch: Partial<typeof mcpSecurityScan>) => {
    update({ mcpSecurityScan: { ...mcpSecurityScan, ...patch } });
  };

  // 技能安全门控（Task 6）
  const skillSecurityGate = cfg.skillSecurityGate ?? {};
  const updateSkillSecurityGate = (patch: Partial<typeof skillSecurityGate>) => {
    update({ skillSecurityGate: { ...skillSecurityGate, ...patch } });
  };

  // 配置保护守卫（Task 7）
  const configGuard = cfg.configGuard ?? {};
  const updateConfigGuard = (patch: Partial<typeof configGuard>) => {
    update({ configGuard: { ...configGuard, ...patch } });
  };

  // 前缀感知缓存（Task 8）
  const prefixCache = cfg.prefixCache ?? {};
  const updatePrefixCache = (patch: Partial<typeof prefixCache>) => {
    update({ prefixCache: { ...prefixCache, ...patch } });
  };

  // 上下文预算监控（Task 9）
  const budgetMonitor = cfg.budgetMonitor ?? {};
  const updateBudgetMonitor = (patch: Partial<typeof budgetMonitor>) => {
    update({ budgetMonitor: { ...budgetMonitor, ...patch } });
  };

  // DAG 工作流引擎（Task 10）
  const dagEngine = cfg.dagEngine ?? {};
  const updateDagEngine = (patch: Partial<typeof dagEngine>) => {
    update({ dagEngine: { ...dagEngine, ...patch } });
  };

  // 熔断器（Task 11）
  const circuitBreaker = cfg.circuitBreaker ?? {};
  const updateCircuitBreaker = (patch: Partial<typeof circuitBreaker>) => {
    update({ circuitBreaker: { ...circuitBreaker, ...patch } });
  };

  // Doctor 健康检查（Task 12）
  const doctor = cfg.doctor ?? {};
  const updateDoctor = (patch: Partial<typeof doctor>) => {
    update({ doctor: { ...doctor, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* Task 3：策略引擎接入 */}
      <Card>
        <CardHeader>
          <CardTitle>策略引擎（Task 3）</CardTitle>
          <CardDescription>策略引擎接入：deny/allow 默认策略 + deny-overrides 冲突解决 + 规则文件路径。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-policy-enabled">启用策略引擎</Label>
              <p className="text-xs text-rd-textMuted">开启后路由前先经过策略评估。</p>
            </div>
            <Switch
              id="p53-policy-enabled"
              checked={policyEngine.enabled ?? false}
              onCheckedChange={(checked) => updatePolicyEngine({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-policy-default">默认策略（deny / allow）</Label>
            <Input
              id="p53-policy-default"
              type="text"
              value={policyEngine.defaultPolicy ?? 'deny'}
              onChange={(e) => {
                const v = e.target.value === 'allow' ? 'allow' : 'deny';
                updatePolicyEngine({ defaultPolicy: v });
              }}
            />
            <p className="text-xs text-rd-textMuted">无匹配规则时的兜底策略。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-policy-rules">规则文件路径（YAML）</Label>
            <Input
              id="p53-policy-rules"
              type="text"
              value={policyEngine.rulesFile ?? '.routedev/policies.yaml'}
              onChange={(e) => updatePolicyEngine({ rulesFile: e.target.value })}
            />
            <p className="text-xs text-rd-textMuted">预留字段，当前规则通过 addPolicy API 注入。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 4：哈希链审计 */}
      <Card>
        <CardHeader>
          <CardTitle>哈希链审计（Task 4）</CardTitle>
          <CardDescription>AuditLogger 写入 SHA-256 链式哈希，溢出时保留接缝哈希。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-audit-enabled">启用哈希链审计</Label>
              <p className="text-xs text-rd-textMuted">开启后审计日志以链式哈希形式写入。</p>
            </div>
            <Switch
              id="p53-audit-enabled"
              checked={auditChain.enabled ?? false}
              onCheckedChange={(checked) => updateAuditChain({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-audit-log">审计日志文件路径</Label>
            <Input
              id="p53-audit-log"
              type="text"
              value={auditChain.logFile ?? '.routedev/audit-chain.jsonl'}
              onChange={(e) => updateAuditChain({ logFile: e.target.value })}
            />
            <p className="text-xs text-rd-textMuted">可选，默认沿用 AuditLogger 的 storageDir。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-audit-seal">溢出接缝哈希数（≥1）</Label>
            <Input
              id="p53-audit-seal"
              type="number"
              min={1}
              value={auditChain.overflowSealCount ?? 1}
              onChange={(e) => updateAuditChain({ overflowSealCount: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">溢出时保留的接缝哈希数量。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 5：MCP 安全扫描 */}
      <Card>
        <CardHeader>
          <CardTitle>MCP 安全扫描（Task 5）</CardTitle>
          <CardDescription>MCP 工具注册前扫描 4 类威胁，按阈值阻断；可配置已知工具名用于仿冒检测。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-mcp-enabled">启用 MCP 安全扫描</Label>
              <p className="text-xs text-rd-textMuted">开启后 MCP 工具注册前必须通过扫描。</p>
            </div>
            <Switch
              id="p53-mcp-enabled"
              checked={mcpSecurityScan.enabled ?? false}
              onCheckedChange={(checked) => updateMcpSecurityScan({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-mcp-threshold">阻断阈值（low / medium / high / critical）</Label>
            <Input
              id="p53-mcp-threshold"
              type="text"
              value={mcpSecurityScan.blockThreshold ?? 'high'}
              onChange={(e) => updateMcpSecurityScan({ blockThreshold: e.target.value as 'low' | 'medium' | 'high' | 'critical' })}
            />
            <p className="text-xs text-rd-textMuted">severity ≥ 此级别的发现会阻止注册。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-mcp-known">已知工具名（逗号分隔）</Label>
            <Input
              id="p53-mcp-known"
              type="text"
              value={(mcpSecurityScan.knownToolNames ?? []).join(', ')}
              onChange={(e) => updateMcpSecurityScan({ knownToolNames: splitList(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">用于仿冒检测，例如：<code>fs.read, fs.write</code>。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 6：技能安全门控 */}
      <Card>
        <CardHeader>
          <CardTitle>技能安全门控（Task 6）</CardTitle>
          <CardDescription>第三方技能安装前通过 17 类漏洞扫描，分数 ≤ 阈值时自动安装。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-skill-enabled">启用技能安全门控</Label>
              <p className="text-xs text-rd-textMuted">开启后第三方技能安装前必须通过扫描。</p>
            </div>
            <Switch
              id="p53-skill-enabled"
              checked={skillSecurityGate.enabled ?? false}
              onCheckedChange={(checked) => updateSkillSecurityGate({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-skill-threshold">自动安装分数阈值（0-100）</Label>
            <Input
              id="p53-skill-threshold"
              type="number"
              min={0}
              max={100}
              value={skillSecurityGate.autoInstallThreshold ?? 50}
              onChange={(e) => updateSkillSecurityGate({ autoInstallThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">超过此值的发现需用户确认后才能安装。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-skill-baseline">基线抑制文件路径</Label>
            <Input
              id="p53-skill-baseline"
              type="text"
              value={skillSecurityGate.baselineFile ?? '.routedev/skill-baseline.json'}
              onChange={(e) => updateSkillSecurityGate({ baselineFile: e.target.value })}
            />
            <p className="text-xs text-rd-textMuted">Glob + SHA-256 指纹基线，预留字段。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 7：配置保护守卫 */}
      <Card>
        <CardHeader>
          <CardTitle>配置保护守卫（Task 7）</CardTitle>
          <CardDescription>阻止 Agent 弱化自身的安全约束，首次触发可降级为 info。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-guard-enabled">启用配置保护守卫</Label>
              <p className="text-xs text-rd-textMuted">开启后阻止 Agent 修改受保护的安全配置。</p>
            </div>
            <Switch
              id="p53-guard-enabled"
              checked={configGuard.enabled ?? false}
              onCheckedChange={(checked) => updateConfigGuard({ enabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-guard-warn">首次触发降级为 info</Label>
              <p className="text-xs text-rd-textMuted">避免首次误报阻塞流程。</p>
            </div>
            <Switch
              id="p53-guard-warn"
              checked={configGuard.warnOnFirst ?? true}
              onCheckedChange={(checked) => updateConfigGuard({ warnOnFirst: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-guard-patterns">受保护文件 pattern（逗号分隔）</Label>
            <Input
              id="p53-guard-patterns"
              type="text"
              value={(configGuard.protectedPatterns ?? []).join(', ')}
              onChange={(e) => updateConfigGuard({ protectedPatterns: splitList(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">用户可扩展，将追加到默认 pattern 之后。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 8：前缀感知缓存 */}
      <Card>
        <CardHeader>
          <CardTitle>前缀感知缓存（Task 8）</CardTitle>
          <CardDescription>借鉴 LMCache 的内容可寻址分块缓存，按 blockSize 分块并写入 L1 内存缓存。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-cache-enabled">启用前缀感知缓存</Label>
              <p className="text-xs text-rd-textMuted">开启后按分块命中前缀，减少重复 Token 计算。</p>
            </div>
            <Switch
              id="p53-cache-enabled"
              checked={prefixCache.enabled ?? false}
              onCheckedChange={(checked) => updatePrefixCache({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-cache-block">分块大小（Token，64-1024）</Label>
            <Input
              id="p53-cache-block"
              type="number"
              min={64}
              max={1024}
              value={prefixCache.blockSize ?? 256}
              onChange={(e) => updatePrefixCache({ blockSize: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-cache-l1">L1 内存缓存最大块数（≥100）</Label>
            <Input
              id="p53-cache-l1"
              type="number"
              min={100}
              value={prefixCache.l1MaxSize ?? 1000}
              onChange={(e) => updatePrefixCache({ l1MaxSize: Number(e.target.value) })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Task 9：上下文预算监控 */}
      <Card>
        <CardHeader>
          <CardTitle>上下文预算监控（Task 9）</CardTitle>
          <CardDescription>Token 耗尽、成本超支、范围蔓延、工具循环时注入告警。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-budget-enabled">启用预算监控</Label>
              <p className="text-xs text-rd-textMuted">开启后达到阈值时自动注入告警。</p>
            </div>
            <Switch
              id="p53-budget-enabled"
              checked={budgetMonitor.enabled ?? false}
              onCheckedChange={(checked) => updateBudgetMonitor({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-budget-ratio">Token 预警比例（0.1-1）</Label>
            <Input
              id="p53-budget-ratio"
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={budgetMonitor.tokenWarnRatio ?? 0.75}
              onChange={(e) => updateBudgetMonitor({ tokenWarnRatio: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">达到此比例时触发 warn 级告警。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-budget-cost">会话成本上限（美元）</Label>
            <Input
              id="p53-budget-cost"
              type="number"
              min={0.01}
              step={1}
              value={budgetMonitor.costLimitPerSession ?? 10}
              onChange={(e) => updateBudgetMonitor({ costLimitPerSession: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-budget-loop">工具循环阈值（≥3）</Label>
            <Input
              id="p53-budget-loop"
              type="number"
              min={3}
              value={budgetMonitor.toolLoopThreshold ?? 5}
              onChange={(e) => updateBudgetMonitor({ toolLoopThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">连续相同工具调用达到此次数后告警。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 10：DAG 工作流引擎 */}
      <Card>
        <CardHeader>
          <CardTitle>DAG 工作流引擎（Task 10）</CardTitle>
          <CardDescription>拓扑排序 + 并行执行 + 变量替换，失败超阈值后请求人类介入。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-dag-enabled">启用 DAG 工作流引擎</Label>
              <p className="text-xs text-rd-textMuted">开启后工作流按 DAG 调度执行。</p>
            </div>
            <Switch
              id="p53-dag-enabled"
              checked={dagEngine.enabled ?? false}
              onCheckedChange={(checked) => updateDagEngine({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-dag-parallel">最大并行度（1-10）</Label>
            <Input
              id="p53-dag-parallel"
              type="number"
              min={1}
              max={10}
              value={dagEngine.maxParallel ?? 3}
              onChange={(e) => updateDagEngine({ maxParallel: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-dag-retry">重试上限（0-5）</Label>
            <Input
              id="p53-dag-retry"
              type="number"
              min={0}
              max={5}
              value={dagEngine.retryLimit ?? 2}
              onChange={(e) => updateDagEngine({ retryLimit: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-dag-human">人类升级阈值（≥1）</Label>
            <Input
              id="p53-dag-human"
              type="number"
              min={1}
              value={dagEngine.humanEscalationThreshold ?? 3}
              onChange={(e) => updateDagEngine({ humanEscalationThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">连续失败此次数后请求人类介入。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 11：熔断器 */}
      <Card>
        <CardHeader>
          <CardTitle>熔断器（Task 11）</CardTitle>
          <CardDescription>三态机：closed / open / half_open，连续失败超阈值后熔断。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-cb-enabled">启用熔断器</Label>
              <p className="text-xs text-rd-textMuted">开启后失败累计达到阈值时熔断。</p>
            </div>
            <Switch
              id="p53-cb-enabled"
              checked={circuitBreaker.enabled ?? false}
              onCheckedChange={(checked) => updateCircuitBreaker({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-cb-failure">失败阈值（≥1）</Label>
            <Input
              id="p53-cb-failure"
              type="number"
              min={1}
              value={circuitBreaker.failureThreshold ?? 5}
              onChange={(e) => updateCircuitBreaker({ failureThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">连续失败此次数后熔断。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-cb-reset">恢复超时（毫秒，≥1000）</Label>
            <Input
              id="p53-cb-reset"
              type="number"
              min={1000}
              value={circuitBreaker.resetTimeout ?? 60000}
              onChange={(e) => updateCircuitBreaker({ resetTimeout: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-cb-halfopen">HALF-OPEN 试探次数（≥1）</Label>
            <Input
              id="p53-cb-halfopen"
              type="number"
              min={1}
              value={circuitBreaker.halfOpenMaxAttempts ?? 1}
              onChange={(e) => updateCircuitBreaker({ halfOpenMaxAttempts: Number(e.target.value) })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Task 12：Doctor 健康检查 */}
      <Card>
        <CardHeader>
          <CardTitle>Doctor 健康检查（Task 12）</CardTitle>
          <CardDescription>启动时可自动运行健康检查，超时时间可调。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p53-doctor-startup">启动时自动运行 doctor</Label>
              <p className="text-xs text-rd-textMuted">开启后每次启动自动执行健康检查。</p>
            </div>
            <Switch
              id="p53-doctor-startup"
              checked={doctor.runOnStartup ?? false}
              onCheckedChange={(checked) => updateDoctor({ runOnStartup: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p53-doctor-timeout">探测超时（毫秒，≥1000）</Label>
            <Input
              id="p53-doctor-timeout"
              type="number"
              min={1000}
              value={doctor.probeTimeout ?? 10000}
              onChange={(e) => updateDoctor({ probeTimeout: Number(e.target.value) })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsPhase53IntegrationTab;
