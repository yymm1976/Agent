// desktop/renderer/src/components/settings/SettingsSubAgentsTab.tsx
// Phase 74-G：子 Agent 设置 Tab（派遣配置 + 内置/自定义 Profile 管理）
// 从 SettingsPage.tsx 迁移

import type { Dispatch, SetStateAction } from 'react';
import { useState, useEffect } from 'react';
import { Users, Plus, Trash2, Eye, ChevronDown, ChevronRight, Upload } from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import type { AgentProfileUI } from '../../pages/settings-helpers.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';
import { Badge } from '../ui/badge.js';
import { Switch } from '../ui/switch.js';
import { SettingsAdvancedSection } from './SettingsAdvancedSection.js';
import { ProfileVersionPanel } from './ProfileVersionPanel.js';

// Phase 94：内置 Profile 不再硬编码，统一通过 IPC 从主进程 AgentProfileManager 拉取
// 与 src/agents/profiles/builtin-templates.ts 保持单一数据源，避免再次脱节

interface SettingsSubAgentsTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新子 Agent 派遣配置 */
  updateSubAgents: (patch: Partial<AppConfig['subAgents']>) => void;
  /** 更新角色门控规则 */
  updateSubAgentsGateRules: (patch: {
    researcherMaxParallel?: number;
    executorMaxParallel?: number;
    reviewerMaxParallel?: number;
  }) => void;
  /** 用户自定义 Agent Profile 列表 */
  agentProfiles: AgentProfileUI[];
  /** 设置自定义 Agent Profile 列表 */
  setAgentProfiles: Dispatch<SetStateAction<AgentProfileUI[]>>;
  /** 当前展开的 Profile id */
  expandedAgentId: string | null;
  /** 设置当前展开的 Profile id */
  setExpandedAgentId: Dispatch<SetStateAction<string | null>>;
}

/**
 * 子 Agent 设置 Tab
 * 包含：派遣总开关/并行上限/默认角色 + 内置 Profile 展示 + 自定义 Profile 增删改
 */
export function SettingsSubAgentsTab({
  draft,
  updateSubAgents,
  updateSubAgentsGateRules,
  agentProfiles,
  setAgentProfiles,
  expandedAgentId,
  setExpandedAgentId,
}: SettingsSubAgentsTabProps) {
  // 导入状态提示
  const [importStatus, setImportStatus] = useState<'idle' | 'importing' | 'success' | 'error'>('idle');
  const [importMessage, setImportMessage] = useState('');
  // Phase 94：内置 Profile 通过 IPC 动态拉取，避免硬编码与源代码脱节
  const [builtinProfiles, setBuiltinProfiles] = useState<AgentProfileUI[]>([]);
  /** 版本面板刷新信号（回滚成功后递增，强制重新加载版本列表） */
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);

  /** 将 IPC Profile 详情映射为 UI 结构 */
  const mapDetailToUI = (d: {
    id: string;
    name: string;
    role: AgentProfileUI['role'];
    modelId: string;
    description: string;
    systemPrompt?: string;
    allowedTools: readonly string[] | string[];
    forbiddenTools: readonly string[] | string[];
    canChallenge: boolean;
    challengeSeverity: AgentProfileUI['challengeSeverity'];
    outputFormat: AgentProfileUI['outputFormat'];
    maxTokens: number;
    maxSteps: number;
    isBuiltin: boolean;
  }): AgentProfileUI => ({
    id: d.id,
    name: d.name,
    role: d.role,
    modelId: d.modelId,
    description: d.description,
    systemPrompt: d.systemPrompt ?? '',
    allowedTools: [...d.allowedTools],
    forbiddenTools: [...d.forbiddenTools],
    canChallenge: d.canChallenge,
    challengeSeverity: d.challengeSeverity,
    outputFormat: d.outputFormat,
    maxTokens: d.maxTokens,
    maxSteps: d.maxSteps,
    isBuiltin: d.isBuiltin,
  });

  // 挂载时拉取内置 Profile（list 不含 systemPrompt，需对内置项逐个 get 详情）
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await window.routedev.profile.list();
        const builtins = (list ?? []).filter((p) => p.isBuiltin);
        const details = await Promise.all(
          builtins.map((p) => window.routedev.profile.get(p.id)),
        );
        if (!mounted) return;
        setBuiltinProfiles(
          details
            .filter((d): d is NonNullable<typeof d> => d !== null)
            .map(mapDetailToUI),
        );
      } catch (err) {
        // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
        console.error('[SettingsSubAgentsTab] 加载内置 Profile 失败:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * 版本回滚成功后：重新拉取该 Profile 详情，刷新编辑区字段
   */
  const handleVersionRollbackSuccess = async (profileId: string) => {
    try {
      const detail = await window.routedev.profile.get(profileId);
      if (!detail) return;
      const mapped = mapDetailToUI(detail);
      setAgentProfiles((prev) =>
        prev.map((p) => (p.id === profileId ? mapped : p)),
      );
      setVersionRefreshKey((k) => k + 1);
    } catch (err) {
      // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
      console.error('[SettingsSubAgentsTab] 回滚后刷新 Profile 失败:', err);
    }
  };

  /** 从外部 SKILL.md 文件导入 Profile */
  const handleImport = async () => {
    setImportStatus('importing');
    setImportMessage('');
    try {
      const result = await window.routedev.profile.import();
      if (!result.success) {
        // 用户取消选择不算错误
        if (result.error === '用户取消选择') {
          setImportStatus('idle');
          return;
        }
        setImportStatus('error');
        setImportMessage(result.error || '导入失败');
        return;
      }
      // 导入成功后获取完整 Profile 详情（含 systemPrompt）
      if (result.id) {
        const detail = await window.routedev.profile.get(result.id);
        if (detail) {
          const newProfile: AgentProfileUI = {
            id: detail.id,
            name: detail.name,
            role: detail.role,
            modelId: detail.modelId,
            description: detail.description,
            systemPrompt: detail.systemPrompt,
            allowedTools: [...detail.allowedTools],
            forbiddenTools: [...detail.forbiddenTools],
            canChallenge: detail.canChallenge,
            challengeSeverity: detail.challengeSeverity,
            outputFormat: detail.outputFormat,
            maxTokens: detail.maxTokens,
            maxSteps: detail.maxSteps,
            isBuiltin: detail.isBuiltin,
          };
          setAgentProfiles([...agentProfiles, newProfile]);
          setExpandedAgentId(newProfile.id);
          setImportStatus('success');
          setImportMessage(`已导入：${newProfile.name}`);
        }
      }
    } catch (err) {
      setImportStatus('error');
      setImportMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      {/* 说明卡片 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-6">
          <div className="flex items-start gap-3">
            <Users size={20} className="mt-0.5 shrink-0 text-rd-primary" />
            <div>
              <Label>子 Agent 配置</Label>
              <p className="text-xs text-rd-textMuted mt-1">
                管理子 Agent 的角色 Profile：researcher（调研）、planner（拆需求）、executor（执行）、reviewer（审查）、verifier（验证）、synthesizer（合成）。
                每个 Profile 定义工具白名单、质疑权限、输出格式与 Token 预算，构成父 Agent 的委托契约。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <SettingsAdvancedSection title="派遣设置" description="子 Agent 并行上限、角色门控规则（已有默认值）">
      {/* Phase 43：子 Agent 派遣配置 */}
      <Card>
        <CardHeader>
          <CardTitle>派遣设置</CardTitle>
          <CardDescription>控制子 Agent 派遣的总开关、并行上限与默认角色</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="subagents-enabled">启用子 Agent 派遣</Label>
              <p className="text-xs text-rd-textMuted">关闭后父 Agent 不再派生子 Agent，所有任务在主线程完成。需同时启用 multiAgent Pack。</p>
            </div>
            <Switch
              id="subagents-enabled"
              checked={draft.subAgents.enabled}
              onCheckedChange={(checked) => updateSubAgents({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="subagents-max-parallel">最大并行子 Agent 数</Label>
            <Input
              id="subagents-max-parallel"
              type="number"
              min={1}
              max={10}
              value={draft.subAgents.maxParallel}
              onChange={(e) => updateSubAgents({ maxParallel: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">同时运行的子 Agent 上限（1-10）。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="subagents-default-role">默认角色</Label>
            <Select
              id="subagents-default-role"
              value={draft.subAgents.defaultRole}
              onChange={(e) => updateSubAgents({ defaultRole: e.target.value as typeof draft.subAgents.defaultRole })}
              disabled
            >
              <SelectItem value="researcher">researcher（调研）</SelectItem>
              <SelectItem value="executor">executor（执行）</SelectItem>
              <SelectItem value="reviewer">reviewer（审查）</SelectItem>
              <SelectItem value="custom">custom（自定义）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现。</p>
          </div>

          {/* 角色门控规则 */}
          <div className="space-y-3 rounded-lg border border-rd-border p-4">
            <p className="text-xs font-semibold text-rd-textSubtle">角色并行上限</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="subagents-researcher-max">researcher</Label>
                <Input
                  id="subagents-researcher-max"
                  type="number"
                  min={0}
                  value={draft.subAgents.gateRules?.researcherMaxParallel ?? 3}
                  onChange={(e) => updateSubAgentsGateRules({ researcherMaxParallel: Number(e.target.value) })}
                  disabled
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subagents-executor-max">executor</Label>
                <Input
                  id="subagents-executor-max"
                  type="number"
                  min={0}
                  value={draft.subAgents.gateRules?.executorMaxParallel ?? 2}
                  onChange={(e) => updateSubAgentsGateRules({ executorMaxParallel: Number(e.target.value) })}
                  disabled
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subagents-reviewer-max">reviewer</Label>
                <Input
                  id="subagents-reviewer-max"
                  type="number"
                  min={0}
                  value={draft.subAgents.gateRules?.reviewerMaxParallel ?? 2}
                  onChange={(e) => updateSubAgentsGateRules({ reviewerMaxParallel: Number(e.target.value) })}
                  disabled
                />
              </div>
            </div>
            <p className="text-xs text-rd-textMuted">暂未实现，当前用内置默认值。</p>
          </div>
        </CardContent>
      </Card>
      </SettingsAdvancedSection>

      {/* 内置配置区 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-rd-text">内置配置</h3>
          <Badge variant="outline">不可删除</Badge>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {builtinProfiles.map((profile) => (
            <Card key={profile.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Users size={16} className="text-rd-primary" />
                    {profile.name}
                  </CardTitle>
                  <Badge variant="primary">{profile.role}</Badge>
                </div>
                <CardDescription className="line-clamp-2">{profile.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-rd-textMuted">模型</span>
                  <span className="text-rd-text">{profile.modelId}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-rd-textMuted">输出格式</span>
                  <span className="text-rd-text">{profile.outputFormat}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-rd-textMuted">工具数</span>
                  <span className="text-rd-text">{profile.allowedTools.length}</span>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setExpandedAgentId(expandedAgentId === profile.id ? null : profile.id)}
                  >
                    <Eye size={14} /> 查看
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      const copy: AgentProfileUI = {
                        ...profile,
                        id: `${profile.id}-copy-${Date.now().toString(36)}`,
                        name: `${profile.name} 副本`,
                        isBuiltin: false,
                        role: 'custom',
                        allowedTools: [...profile.allowedTools],
                        forbiddenTools: [...profile.forbiddenTools],
                      };
                      setAgentProfiles([...agentProfiles, copy]);
                      setExpandedAgentId(copy.id);
                    }}
                  >
                    <Plus size={14} /> 复制
                  </Button>
                </div>
                {expandedAgentId === profile.id && (
                  <div className="mt-3 space-y-3 rounded-lg bg-rd-surfaceHover/50 p-3">
                    <div className="space-y-1">
                      <Label className="text-xs">System Prompt（仅供参考，实际由内置模板生成）</Label>
                      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-rd-surface p-2 text-xs text-rd-text">
                        {profile.systemPrompt}
                      </pre>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">工具白名单</Label>
                      <p className="text-xs text-rd-text">{profile.allowedTools.join(', ')}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">禁止工具</Label>
                      <p className="text-xs text-rd-text">{profile.forbiddenTools.join(', ') || '无'}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-rd-textMuted">Token 预算：</span>
                        <span className="text-rd-text">{profile.maxTokens}</span>
                      </div>
                      <div>
                        <span className="text-rd-textMuted">最大步数：</span>
                        <span className="text-rd-text">{profile.maxSteps}</span>
                      </div>
                      <div>
                        <span className="text-rd-textMuted">允许质疑：</span>
                        <span className="text-rd-text">{profile.canChallenge ? '是' : '否'}</span>
                      </div>
                      <div>
                        <span className="text-rd-textMuted">质疑级别：</span>
                        <span className="text-rd-text">{profile.challengeSeverity}</span>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* 我的配置区 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-rd-text">我的配置</h3>
            <Badge variant="outline">{agentProfiles.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            {/* 导入外部 SKILL.md 文件 */}
            <Button
              variant="outline"
              size="sm"
              disabled={importStatus === 'importing'}
              onClick={handleImport}
            >
              <Upload size={14} />
              {importStatus === 'importing' ? '导入中...' : '导入'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const newProfile: AgentProfileUI = {
                  id: `custom-${Date.now().toString(36)}`,
                  name: '新建 Profile',
                  role: 'custom',
                  modelId: 'default',
                  description: '自定义子 Agent Profile',
                  systemPrompt: '# 角色定位\n请描述该子 Agent 的角色与职责。\n\n# 绝对规则\n- 服从父 Agent 委托契约。\n\n# 禁止事项\n- 禁止越权操作。\n\n# 输出格式\n请定义输出格式。\n\n# 质疑权利\n可对错误指令提出质疑。',
                  allowedTools: ['read_file'],
                  forbiddenTools: [],
                  canChallenge: true,
                  challengeSeverity: 'warning',
                  outputFormat: 'custom',
                  maxTokens: 32000,
                  maxSteps: 20,
                  isBuiltin: false,
                };
                setAgentProfiles([...agentProfiles, newProfile]);
                setExpandedAgentId(newProfile.id);
              }}
            >
              <Plus size={14} /> 新建
            </Button>
          </div>
        </div>

        {/* 导入状态提示 */}
        {importStatus === 'success' && (
          <div className="flex items-center justify-between rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600">
            <span>{importMessage}</span>
            <button className="text-xs text-green-600/70 hover:text-green-600" onClick={() => setImportStatus('idle')}>关闭</button>
          </div>
        )}
        {importStatus === 'error' && (
          <div className="flex items-center justify-between rounded-lg border border-rd-danger/30 bg-rd-danger/10 px-3 py-2 text-sm text-rd-danger">
            <span>导入失败：{importMessage}</span>
            <button className="text-xs text-rd-danger/70 hover:text-rd-danger" onClick={() => setImportStatus('idle')}>关闭</button>
          </div>
        )}

        {agentProfiles.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <Users size={32} className="mb-3 text-rd-textMuted" />
              <p className="text-sm text-rd-textMuted">
                还没有自定义子 Agent Profile。点击"新建"创建，或从内置配置复制一个开始。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {agentProfiles.map((profile, idx) => (
              <Card key={profile.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{profile.name || '未命名'}</CardTitle>
                      <Badge variant="outline">{profile.role}</Badge>
                      <Badge variant="primary">{profile.outputFormat}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setExpandedAgentId(expandedAgentId === profile.id ? null : profile.id)}
                      >
                        {expandedAgentId === profile.id ? (
                          <><ChevronDown size={14} /> 收起</>
                        ) : (
                          <><ChevronRight size={14} /> 展开</>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                        onClick={() => {
                          const next = agentProfiles.filter((_, i) => i !== idx);
                          setAgentProfiles(next);
                          if (expandedAgentId === profile.id) setExpandedAgentId(null);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                  <CardDescription>{profile.description}</CardDescription>
                </CardHeader>
                {expandedAgentId === profile.id && (
                  <CardContent className="space-y-4">
                    {/* 名称 */}
                    <div className="space-y-2">
                      <Label>名称</Label>
                      <Input
                        value={profile.name}
                        onChange={(e) => {
                          const next = [...agentProfiles];
                          next[idx] = { ...profile, name: e.target.value };
                          setAgentProfiles(next);
                        }}
                        placeholder="Profile 名称"
                      />
                    </div>

                    {/* 描述 */}
                    <div className="space-y-2">
                      <Label>描述</Label>
                      <Input
                        value={profile.description}
                        onChange={(e) => {
                          const next = [...agentProfiles];
                          next[idx] = { ...profile, description: e.target.value };
                          setAgentProfiles(next);
                        }}
                        placeholder="一句话描述该 Profile 的职责"
                      />
                    </div>

                    {/* 模型选择 */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>模型</Label>
                        <Input
                          value={profile.modelId}
                          onChange={(e) => {
                            const next = [...agentProfiles];
                            next[idx] = { ...profile, modelId: e.target.value };
                            setAgentProfiles(next);
                          }}
                          placeholder="default 或具体模型 id"
                        />
                        <p className="text-xs text-rd-textMuted">填 'default' 走路由器默认选择。</p>
                      </div>
                      <div className="space-y-2">
                        <Label>输出格式</Label>
                        <Select
                          value={profile.outputFormat}
                          onChange={(e) => {
                            const next = [...agentProfiles];
                            next[idx] = { ...profile, outputFormat: e.target.value as AgentProfileUI['outputFormat'] };
                            setAgentProfiles(next);
                          }}
                        >
                          <SelectItem value="research_report">research_report</SelectItem>
                          <SelectItem value="code_change">code_change</SelectItem>
                          <SelectItem value="review_report">review_report</SelectItem>
                          <SelectItem value="task_plan">task_plan</SelectItem>
                          <SelectItem value="verification_report">verification_report</SelectItem>
                          <SelectItem value="synthesis_report">synthesis_report</SelectItem>
                          <SelectItem value="custom">custom</SelectItem>
                        </Select>
                      </div>
                    </div>

                    {/* System Prompt */}
                    <div className="space-y-2">
                      <Label>System Prompt</Label>
                      <textarea
                        className="flex min-h-[120px] w-full rounded-xl border border-rd-border bg-rd-surface px-3 py-2 text-sm text-rd-text placeholder:text-rd-textMuted focus:border-rd-primary focus:outline-none focus:ring-1 focus:ring-rd-primary"
                        value={profile.systemPrompt}
                        onChange={(e) => {
                          const next = [...agentProfiles];
                          next[idx] = { ...profile, systemPrompt: e.target.value };
                          setAgentProfiles(next);
                        }}
                        placeholder="定义子 Agent 的角色、规则、禁止事项、输出格式、质疑权利"
                      />
                      <p className="text-xs text-rd-textMuted">支持 Markdown，建议包含：角色定位、绝对规则、禁止事项、输出格式、质疑权利。</p>
                    </div>

                    {/* 工具白名单 */}
                    <div className="space-y-2">
                      <Label>工具白名单（逗号分隔）</Label>
                      <Input
                        value={profile.allowedTools.join(', ')}
                        onChange={(e) => {
                          const tools = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                          const next = [...agentProfiles];
                          next[idx] = { ...profile, allowedTools: tools };
                          setAgentProfiles(next);
                        }}
                        placeholder="read_file, file_write, execute_command"
                      />
                      <p className="text-xs text-rd-textMuted">仅允许子 Agent 使用此处列出的工具。</p>
                    </div>

                    {/* Token 预算 & 最大步数 */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Token 预算</Label>
                        <Input
                          type="number"
                          value={String(profile.maxTokens)}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            const next = [...agentProfiles];
                            next[idx] = { ...profile, maxTokens: Number.isFinite(v) && v > 0 ? v : profile.maxTokens };
                            setAgentProfiles(next);
                          }}
                          placeholder="32000"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>最大步数</Label>
                        <Input
                          type="number"
                          value={String(profile.maxSteps)}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            const next = [...agentProfiles];
                            next[idx] = { ...profile, maxSteps: Number.isFinite(v) && v > 0 ? v : profile.maxSteps };
                            setAgentProfiles(next);
                          }}
                          placeholder="20"
                        />
                      </div>
                    </div>

                    {/* 允许质疑 Toggle & 质疑级别 */}
                    <div className="flex items-center justify-between gap-4 rounded-lg bg-rd-surfaceHover/50 p-3">
                      <div className="flex-1">
                        <p className="text-sm text-rd-text">允许质疑父 Agent</p>
                        <p className="text-xs text-rd-textMuted mt-1">开启后子 Agent 可对父 Agent 的指令提出质疑。</p>
                      </div>
                      <Switch
                        checked={profile.canChallenge}
                        onCheckedChange={(checked) => {
                          const next = [...agentProfiles];
                          next[idx] = { ...profile, canChallenge: checked };
                          setAgentProfiles(next);
                        }}
                      />
                    </div>
                    {profile.canChallenge && (
                      <div className="space-y-2">
                        <Label>质疑级别</Label>
                        <Select
                          value={profile.challengeSeverity}
                          onChange={(e) => {
                            const next = [...agentProfiles];
                            next[idx] = { ...profile, challengeSeverity: e.target.value as AgentProfileUI['challengeSeverity'] };
                            setAgentProfiles(next);
                          }}
                        >
                          <SelectItem value="warning">warning（仅记录）</SelectItem>
                          <SelectItem value="blocking">blocking（暂停流水线）</SelectItem>
                        </Select>
                      </div>
                    )}

                    {/* Phase 94：版本历史时间轴 + Diff + 回滚 */}
                    {!profile.isBuiltin && (
                      <div className="space-y-2 pt-2">
                        <Label>版本历史</Label>
                        <p className="text-xs text-rd-textMuted">
                          查看字段变更 Diff，并可一键回滚到历史版本（覆盖当前内容）。
                        </p>
                        <ProfileVersionPanel
                          profileId={profile.id}
                          refreshKey={versionRefreshKey}
                          onRollbackSuccess={(id) => {
                            void handleVersionRollbackSuccess(id);
                          }}
                        />
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
