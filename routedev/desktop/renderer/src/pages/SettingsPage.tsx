// desktop/renderer/src/pages/SettingsPage.tsx
// 设置页面：Provider / 模型 / 路由规则 / 安全 / 命令与工具 / 可观测性 / 记忆 / MCP / 外观 / 归档对话 / 关于

import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import {
  Plus, Trash2, Shield, Eye, EyeOff, Zap, X,
  CheckCircle2, AlertCircle, Archive, RotateCcw, Folder, BookOpen, RefreshCw,
  ChevronDown, ChevronRight, Map as MapIcon, Webhook, Code, Wand2,
  Gauge, Brain, Lightbulb, Users,
} from 'lucide-react';
import type {
  AppConfig, ModelConfig, RouterRule,
} from '../../../shared/config-types.js';
import type { ConfigSaveResult, ExperimentInfo } from '../../../shared/ipc-types.js';
import {
  parseStringList, constructMcpServer, mcpServerToForm, EMPTY_MCP_FORM,
  EMPTY_PROVIDER, EMPTY_MODEL, EMPTY_RULE, SEARCH_ENGINES,
  type McpFormState,
} from './settings-helpers.js';
import { Button } from '../components/ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select, SelectItem } from '../components/ui/select.js';
import { Badge } from '../components/ui/badge.js';
import { Switch } from '../components/ui/switch.js';
import { Alert, AlertTitle, AlertDescription } from '../components/ui/alert.js';
import { ConfirmDialog, AlertBanner } from '../components/ui/dialog.js';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { useSettingsDraft } from '../hooks/useSettingsDraft.js';
import { useAutoSave, type SaveResult } from '../hooks/useAutoSave.js';
import { useSkillsManager, type ConfirmDialogState } from '../hooks/useSkillsManager.js';
import { useHooksManager } from '../hooks/useHooksManager.js';
import { useMcpCatalog } from '../hooks/useMcpCatalog.js';
import { SettingsPersonaTab } from '../components/settings/SettingsPersonaTab.js';
import { SettingsVoiceTab } from '../components/settings/SettingsVoiceTab.js';
import { SettingsConversationTab } from '../components/settings/SettingsConversationTab.js';
import { SettingsExperimentTab } from '../components/settings/SettingsExperimentTab.js';
import { SettingsGoalTab } from '../components/settings/SettingsGoalTab.js';
import { SettingsReviewerTab } from '../components/settings/SettingsReviewerTab.js';
import { SettingsDelegationTab } from '../components/settings/SettingsDelegationTab.js';
import { SettingsPhase52IntegrationTab } from '../components/settings/SettingsPhase52IntegrationTab.js';
import { SettingsPhase53IntegrationTab } from '../components/settings/SettingsPhase53IntegrationTab.js';
import { SettingsResultSchemaTab } from '../components/settings/SettingsResultSchemaTab.js';
import { SettingsConfigLayeringTab } from '../components/settings/SettingsConfigLayeringTab.js';
import { SettingsPacksTab } from '../components/settings/SettingsPacksTab.js';
import { SettingsArchivedTab } from '../components/settings/SettingsArchivedTab.js';
import { SettingsSubAgentsTab } from '../components/settings/SettingsSubAgentsTab.js';
import { SettingsSecurityTab } from '../components/settings/SettingsSecurityTab.js';
import { SettingsMcpTab } from '../components/settings/SettingsMcpTab.js';
import { SettingsAppearanceTab } from '../components/settings/SettingsAppearanceTab.js';
import { SettingsSkillsTab } from '../components/settings/SettingsSkillsTab.js';
import { SettingsMemoryTab } from '../components/settings/SettingsMemoryTab.js';
import { SettingsProvidersTab } from '../components/settings/SettingsProvidersTab.js';
import { SettingsRouterTab } from '../components/settings/SettingsRouterTab.js';
import { SettingsCommandsTab } from '../components/settings/SettingsCommandsTab.js';
import { SettingsOptimizationTab } from '../components/settings/SettingsOptimizationTab.js';
import { SettingsExecutionTab } from '../components/settings/SettingsExecutionTab.js';
import { SettingsCodemapTab } from '../components/settings/SettingsCodemapTab.js';
import { SettingsPoliciesTab } from '../components/settings/SettingsPoliciesTab.js';
import { SettingsHooksTab } from '../components/settings/SettingsHooksTab.js';
import { SettingsExpertiseTab, SettingsAboutTab, SettingsMarketTab } from '../components/settings/SettingsMiscTabs.js';
import { SettingsHeader } from '../components/settings/SettingsHeader.js';
import { SettingsNav, type TabId } from '../components/settings/SettingsNav.js';
import { SaveToast } from '../components/settings/SaveToast.js';

interface SettingsPageProps {
  config: AppConfig | null;
  saveConfig: (cfg: AppConfig) => Promise<ConfigSaveResult>;
  /** 热重载配置（可选，saveConfig 内部已自动 reload） */
  reloadConfig?: () => Promise<void>;
  /** 返回对话页 */
  onBack: () => void;
}

// Phase 74-G：TabId 类型已迁移到 SettingsNav.tsx

// Phase 74-G：AgentProfileUI、deepClone、EMPTY_PROVIDER/MODEL/RULE 已迁移到 settings-helpers.ts
// Phase 74-G：SANDBOX_LEVEL_OPTIONS / TOOL_CATEGORIES / DEFAULT_APPROVAL_MAP 已迁移到 SettingsSecurityTab.tsx
// Phase 74-G：BUILTIN_AGENT_PROFILES 已迁移到 SettingsSubAgentsTab.tsx
// Phase 74-G：SEARCH_ENGINES 已迁移到 settings-helpers.ts
// Phase 74-G：APP_VERSION 已迁移到 SettingsMiscTabs.tsx（关于 Tab 内部使用）

export function SettingsPage({ config, saveConfig, reloadConfig, onBack }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('providers');
  // 高级设置折叠状态（默认折叠，包含不常用的安全/渠道/归档/关于）
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  // 注：saving 已迁移到 useAutoSave hook（Phase 74-G）
  const [saveResult, setSaveResult] = useState<SaveResult>(null);

  // 替代原生 alert/confirm 的状态
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  // Phase 74-G：showExpertiseGuide 已迁移到 SettingsExpertiseTab 内部（纯 UI 状态）
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  // --- Phase 74-G：Skills/Hooks/MCP state 已迁移到对应 hook ---
  // 导入文件引用
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Phase 74-G：draft 状态 + 50 个 update* 函数迁移到 useSettingsDraft hook ---
  const {
    draft, setDraft, dirtyRef, skipSyncRef,
    selectedSearchEngine, setSelectedSearchEngine,
    showApiKeys, testingProvider, testResults,
    modelEditor, setModelEditor,
    mcpForm, setMcpForm, mcpEditingId, setMcpEditingId,
    agentProfiles, setAgentProfiles, expandedAgentId, setExpandedAgentId,
    updateDraft, updateProvider, addProvider, removeProvider,
    updateModel, openAddModel, openEditModel, confirmModelEditor, removeModel,
    updateRule, addRule, removeRule, updateBudget,
    updateSecurity, updateSecurityApproval,
    updatePermissionProfile, updateFsRule, addFsRule, removeFsRule,
    updateNetworkAllow, updateNetworkDeny,
    updateWebSearch, updateAutonomy,
    updateOptimization, updateTokenTracking, updateWorkflow, updateSafety, updateConciseThinking,
    updateCheckpoint, updateCheckpointTrigger, addCheckpointTrigger, removeCheckpointTrigger,
    updateGoalVerifier, updateAdversarial,
    updateExecution, updateUpdates, updatePhase48Integration, updatePhase49Integration,
    updateScheduler, updatePrompts, updateProjectMemory, updateMemory,
    updateMcp, updateMcpServer, removeMcpServer, submitMcpForm, openAddMcp, openEditMcp,
    updateGeneral, updateBackgroundBehavior, updateUi,
    updateTrust, updateQuality, updateExpertise,
    updateSubAgents, updateSubAgentsGateRules,
    updatePacks,
    toggleApiKey, handleTestConnection,
  } = useSettingsDraft({ config, onClearSaveResult: () => setSaveResult(null) });

  // --- Phase 74-G：自动保存 + 实时预览 + 卸载恢复 + 保存提示已迁移到 useAutoSave hook ---
  const { saving, handleSave } = useAutoSave({
    draft, setDraft, dirtyRef, skipSyncRef,
    config, saveConfig, reloadConfig,
    saveResult, setSaveResult,
  });

  // --- Phase 74-G：Skills/Hooks/MCP 管理已迁移到对应 hook ---
  const {
    skills, setSkills,
    skillPreview, setSkillPreview,
    skillForm, setSkillForm,
    skillRouteTest, setSkillRouteTest,
    skillLoading,
    skillAiForm, setSkillAiForm,
    refreshSkills,
    handleSkillToggle,
    handleSkillPreview,
    handleSkillCreate,
    handleSkillDelete,
    handleSkillRouteTest,
    handleSkillReload,
    handleSkillAiGenerate,
  } = useSkillsManager({ activeTab, setAlertMsg, setConfirmDialog });

  const {
    hooks, setHooks,
    hookLoading,
    hookCreateForm, setHookCreateForm,
    refreshHooks,
    handleHookToggle,
    handleHookDelete,
    handleHookAiGenerate,
  } = useHooksManager({ activeTab, setAlertMsg, setConfirmDialog });

  const {
    catalogEntries, setCatalogEntries,
    catalogCategory, setCatalogCategory,
    catalogSearch, setCatalogSearch,
    installingId,
    installResult, setInstallResult,
    installModal, setInstallModal,
    envInputs, setEnvInputs,
    headerInputs, setHeaderInputs,
    refreshCatalog,
    handleCatalogCategoryChange,
    handleCatalogSearch,
    openInstallModal,
    handleInstall,
  } = useMcpCatalog({ activeTab, updateDraft });

  // 当 activeTab 属于高级设置时，自动展开折叠组，避免用户在导航栏"丢失"当前页面
  useEffect(() => {
    if (['security', 'archived', 'about'].includes(activeTab)) {
      setAdvancedExpanded(true);
    }
  }, [activeTab]);

  // --- Phase 74-G：以下 useEffect 已迁移到对应 hook ---
  // - config→draft 同步（useSettingsDraft）
  // - draft 首次加载后推断默认搜索引擎（useSettingsDraft）
  // - 700ms 防抖自动保存 / 主题预览 / 卸载恢复 / 保存提示 3 秒消失（useAutoSave）
  // - Skills/Hooks/MCP Tab 懒加载（useSkillsManager / useHooksManager / useMcpCatalog）
  // --- Phase 74-G：Skills/Hooks/MCP handler 已迁移到对应 hook ---

  if (!draft) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-rd-textMuted">
        配置加载中...
      </div>
    );
  }


  // --- 导出配置 ---
  const handleExport = () => {
    const json = JSON.stringify(draft, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `routedev-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- 导入配置 ---
  const handleImport = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as AppConfig;
        setDraft(parsed);
        setSaveResult(null);
      } catch {
        setSaveResult({ success: false, message: '导入失败：JSON 解析错误' });
      }
    };
    reader.readAsText(file);
    // 重置 input 以便重复导入同一文件
    e.target.value = '';
  };

  // --- Phase 74-G：handleSave 已迁移到 useAutoSave hook ---
  // --- Phase 74-G：mainTabs / advancedTabs 已迁移到 SettingsNav.tsx ---

  return (
    <>
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden p-6">
      {/* 顶部：标题 + 标签栏 + 导入导出 + 保存（Phase 74-G：迁移到 SettingsHeader） */}
      <SettingsHeader
        onBack={onBack}
        fileInputRef={fileInputRef}
        handleImport={handleImport}
        handleExport={handleExport}
        saving={saving}
      />

      {/* 保存提示：顶部居中浮动 toast，3 秒自动消失（Phase 74-G：迁移到 SaveToast） */}
      <SaveToast saveResult={saveResult} />

      {/* 下方 flex 布局：左侧标签导航 + 右侧内容区 */}
      <div className="flex flex-1 min-h-0 gap-6 overflow-hidden">
        {/* 左侧标签导航栏（Phase 74-G：迁移到 SettingsNav） */}
        <SettingsNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          advancedExpanded={advancedExpanded}
          setAdvancedExpanded={setAdvancedExpanded}
        />

        {/* 右侧内容区（relative 定位，子 tab 内容用 absolute inset-0 填充，避免 flexbox 高度抖动） */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
      {/* ===== Provider & 模型 ===== */}
      {activeTab === 'providers' && (
        <SettingsProvidersTab
          draft={draft}
          updateDraft={updateDraft}
          addProvider={addProvider}
          removeProvider={removeProvider}
          updateProvider={updateProvider}
          showApiKeys={showApiKeys}
          toggleApiKey={toggleApiKey}
          handleTestConnection={handleTestConnection}
          testingProvider={testingProvider}
          testResults={testResults}
          openAddModel={openAddModel}
          openEditModel={openEditModel}
          removeModel={removeModel}
          modelEditor={modelEditor}
          setModelEditor={setModelEditor}
          confirmModelEditor={confirmModelEditor}
        />
      )}

      {/* ===== 路由规则 ===== */}
      {activeTab === 'router' && (
        <SettingsRouterTab
          draft={draft}
          updateDraft={updateDraft}
          updateBudget={updateBudget}
          updateRule={updateRule}
          addRule={addRule}
          removeRule={removeRule}
        />
      )}

      {/* ===== 安全设置 ===== */}
      {activeTab === 'security' && (
        <SettingsSecurityTab
          draft={draft}
          updateSecurity={updateSecurity}
          updateSecurityApproval={updateSecurityApproval}
          updateFsRule={updateFsRule}
          addFsRule={addFsRule}
          removeFsRule={removeFsRule}
          updateNetworkAllow={updateNetworkAllow}
          updateNetworkDeny={updateNetworkDeny}
          updateWebSearch={updateWebSearch}
          updateAdversarial={updateAdversarial}
          updateTrust={updateTrust}
          selectedSearchEngine={selectedSearchEngine}
          setSelectedSearchEngine={setSelectedSearchEngine}
        />
      )}

      {/* ===== 命令与工具黑白名单 ===== */}
      {activeTab === 'commands' && (
        <SettingsCommandsTab
          draft={draft}
          updateSecurity={updateSecurity}
          updateAutonomy={updateAutonomy}
          updatePhase48Integration={updatePhase48Integration}
          updatePhase49Integration={updatePhase49Integration}
          updateScheduler={updateScheduler}
        />
      )}

      {/* ===== 可观测性 ===== */}
      {activeTab === 'optimization' && (
        <SettingsOptimizationTab
          draft={draft}
          updateTokenTracking={updateTokenTracking}
          updateSafety={updateSafety}
          updateConciseThinking={updateConciseThinking}
          updatePrompts={updatePrompts}
        />
      )}

      {/* ===== 执行配置（并发 / 熔断 / 检查点提示） ===== */}
      {activeTab === 'execution' && (
        <SettingsExecutionTab
          draft={draft}
          updateExecution={updateExecution}
          updateQuality={updateQuality}
        />
      )}

      {/* ===== 记忆与检查点 ===== */}
      {activeTab === 'memory' && (
        <SettingsMemoryTab
          draft={draft}
          updateCheckpoint={updateCheckpoint}
          updateCheckpointTrigger={updateCheckpointTrigger}
          addCheckpointTrigger={addCheckpointTrigger}
          removeCheckpointTrigger={removeCheckpointTrigger}
          updateGoalVerifier={updateGoalVerifier}
          updateProjectMemory={updateProjectMemory}
          updateMemory={updateMemory}
        />
      )}

      {/* ===== 插件与 MCP ===== */}
      {activeTab === 'mcp' && (
        <SettingsMcpTab
          draft={draft}
          updateMcp={updateMcp}
          updateMcpServer={updateMcpServer}
          removeMcpServer={removeMcpServer}
          submitMcpForm={submitMcpForm}
          openAddMcp={openAddMcp}
          openEditMcp={openEditMcp}
          mcpForm={mcpForm}
          setMcpForm={setMcpForm}
          mcpEditingId={mcpEditingId}
          setMcpEditingId={setMcpEditingId}
          catalogEntries={catalogEntries}
          catalogCategory={catalogCategory}
          catalogSearch={catalogSearch}
          handleCatalogCategoryChange={handleCatalogCategoryChange}
          handleCatalogSearch={handleCatalogSearch}
          installingId={installingId}
          installResult={installResult}
          setInstallResult={setInstallResult}
          installModal={installModal}
          setInstallModal={setInstallModal}
          envInputs={envInputs}
          setEnvInputs={setEnvInputs}
          headerInputs={headerInputs}
          setHeaderInputs={setHeaderInputs}
          openInstallModal={openInstallModal}
          handleInstall={handleInstall}
        />
      )}

      {/* ===== Phase 37：Skill 技能管理 ===== */}
      {activeTab === 'skills' && (
        <SettingsSkillsTab
          skills={skills}
          skillLoading={skillLoading}
          skillPreview={skillPreview}
          setSkillPreview={setSkillPreview}
          skillForm={skillForm}
          setSkillForm={setSkillForm}
          skillRouteTest={skillRouteTest}
          setSkillRouteTest={setSkillRouteTest}
          skillAiForm={skillAiForm}
          setSkillAiForm={setSkillAiForm}
          handleSkillReload={handleSkillReload}
          handleSkillToggle={handleSkillToggle}
          handleSkillPreview={handleSkillPreview}
          handleSkillDelete={handleSkillDelete}
          handleSkillRouteTest={handleSkillRouteTest}
          handleSkillCreate={handleSkillCreate}
          handleSkillAiGenerate={handleSkillAiGenerate}
          setAlertMsg={setAlertMsg}
        />
      )}

      {/* ===== 外观 ===== */}
      {activeTab === 'appearance' && (
        <SettingsAppearanceTab
          draft={draft}
          updateGeneral={updateGeneral}
          updateUi={updateUi}
          updateBackgroundBehavior={updateBackgroundBehavior}
          updateUpdates={updateUpdates}
        />
      )}

      {/* ===== Phase 40：用户体验 ===== */}
      {activeTab === 'expertise' && (
        <SettingsExpertiseTab draft={draft} updateExpertise={updateExpertise} />
      )}

      {/* ===== 归档对话 ===== */}
      {activeTab === 'archived' && (
        <SettingsArchivedTab />
      )}

      {/* ===== 关于 ===== */}
      {activeTab === 'about' && (
        <SettingsAboutTab />
      )}

      {/* ===== 代码地图（Phase 39） ===== */}
      {activeTab === 'codemap' && (
        <SettingsCodemapTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 策略引擎（Phase 42） ===== */}
      {activeTab === 'policies' && (
        <SettingsPoliciesTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 市场（Phase 42） ===== */}
      {activeTab === 'market' && (
        <SettingsMarketTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 人格（Phase 45） ===== */}
      {activeTab === 'persona' && (
        <SettingsPersonaTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 语音（Phase 45） ===== */}
      {activeTab === 'voice' && (
        <SettingsVoiceTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 对话持久化（Phase 44） ===== */}
      {activeTab === 'conversation' && (
        <SettingsConversationTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 并行实验（Phase 44） ===== */}
      {activeTab === 'experiment' && (
        <SettingsExperimentTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== /goal 流程（Phase 43） ===== */}
      {activeTab === 'goal' && (
        <SettingsGoalTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 审查分级（Phase 51 Task 1/7） ===== */}
      {activeTab === 'reviewer' && (
        <SettingsReviewerTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 委托策略（Phase 51 Task 2/3/4） ===== */}
      {activeTab === 'delegation' && (
        <SettingsDelegationTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 安全与治理（合并 Phase 52 + Phase 53） ===== */}
      {activeTab === 'phase53Integration' && (
        <>
          <SettingsPhase52IntegrationTab draft={draft} updateDraft={updateDraft} />
          <SettingsPhase53IntegrationTab draft={draft} updateDraft={updateDraft} />
        </>
      )}

      {/* ===== 子 Agent 结果 Schema（Phase 51 Task 10，I-1） ===== */}
      {activeTab === 'resultSchema' && (
        <SettingsResultSchemaTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 配置分层（Phase 51 Task 8，I-1） ===== */}
      {activeTab === 'configLayering' && (
        <SettingsConfigLayeringTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 能力分层（Phase 81 Task 5）：Core / Extended / Standard / Freeze ===== */}
      {activeTab === 'packs' && (
        <SettingsPacksTab
          draft={draft}
          updatePacks={updatePacks}
          onNavigate={setActiveTab}
        />
      )}

      {/* ===== Hooks（Phase 39） ===== */}
      {activeTab === 'hooks' && (
        <SettingsHooksTab
          hooks={hooks}
          hookLoading={hookLoading}
          hookCreateForm={hookCreateForm}
          setHookCreateForm={setHookCreateForm}
          refreshHooks={refreshHooks}
          handleHookToggle={handleHookToggle}
          handleHookDelete={handleHookDelete}
          handleHookAiGenerate={handleHookAiGenerate}
        />
      )}

      {/* ===== 子 Agent 配置 ===== */}
      {activeTab === 'subagents' && (
        <SettingsSubAgentsTab
          draft={draft}
          updateSubAgents={updateSubAgents}
          updateSubAgentsGateRules={updateSubAgentsGateRules}
          agentProfiles={agentProfiles}
          setAgentProfiles={setAgentProfiles}
          expandedAgentId={expandedAgentId}
          setExpandedAgentId={setExpandedAgentId}
        />
      )}

        </div>
      </div>
    </div>
    <AlertBanner message={alertMsg} onDismiss={() => setAlertMsg(null)} />
    </>
  );
}

// ===== 归档对话面板 =====
// 从 useProjectsStore 读取归档列表，支持还原与永久删除
function ArchivedConversationsPanel() {
  const archivedConversations = useProjectsStore((s) => s.archivedConversations);
  const restoreConversation = useProjectsStore((s) => s.restoreConversation);
  const deleteArchivedConversation = useProjectsStore((s) => s.deleteArchivedConversation);
  const projects = useProjectsStore((s) => s.projects);
  // 替代原生 confirm 的状态
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    variant?: 'default' | 'danger';
    onConfirm: () => void;
  } | null>(null);

  // 格式化时间戳
  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  if (archivedConversations.length === 0) {
    return (
      <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-rd-primary/10 text-rd-primary">
            <Archive size={32} />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-rd-text">没有归档对话</h3>
          <p className="max-w-md text-sm text-rd-textMuted">
            在左侧项目侧边栏中右键对话选择"归档"，对话会移到此页面。归档后可随时还原到原项目。
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 space-y-3 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>归档对话</CardTitle>
          <CardDescription>
            共 {archivedConversations.length} 条归档对话。可还原到原项目或永久删除。
          </CardDescription>
        </CardHeader>
      </Card>

      {archivedConversations.map((conv) => {
        // 检查原项目是否还存在
        const projectExists = projects.some((p) => p.id === conv.projectId);
        return (
          <Card key={conv.id}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Folder size={16} className="shrink-0 text-rd-textMuted" />
                    <span className="truncate font-medium text-rd-text">{conv.title}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-rd-textMuted">
                    <span>原项目: {conv.projectName}</span>
                    <span>归档于: {formatTime(conv.archivedAt)}</span>
                    <span>消息数: {conv.messages?.length ?? 0}</span>
                    {!projectExists && (
                      <Badge variant="outline" className="text-rd-warning">原项目已删除</Badge>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restoreConversation(conv.id)}
                    disabled={!projectExists}
                    title={projectExists ? '还原到原项目' : '原项目已被删除，无法还原'}
                  >
                    <RotateCcw size={14} /> 还原
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                    onClick={() => {
                      setConfirmDialog({
                        message: `确认永久删除归档对话"${conv.title}"？此操作不可恢复。`,
                        variant: 'danger',
                        onConfirm: () => {
                          setConfirmDialog(null);
                          deleteArchivedConversation(conv.id);
                        },
                      });
                    }}
                  >
                    <Trash2 size={14} /> 永久删除
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
      <ConfirmDialog
        open={confirmDialog !== null}
        message={confirmDialog?.message ?? ''}
        variant={confirmDialog?.variant}
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
