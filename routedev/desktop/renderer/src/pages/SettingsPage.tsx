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
import { SettingsAdvancedSection } from '../components/settings/SettingsAdvancedSection.js';

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
  const [activeTab, setActiveTab] = useState<TabId>('models');
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
    draft, setDraft, dirtyRef,
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
    updatePrompts, updateProjectMemory, updateMemory,
    updateMcp, updateMcpServer, removeMcpServer, submitMcpForm, openAddMcp, openEditMcp,
    updateGeneral, updateBackgroundBehavior, updateUi,
    updateTrust, updateQuality, updateExpertise,
    updateSubAgents, updateSubAgentsGateRules,
    toggleApiKey, handleTestConnection,
    handleRefreshModels, refreshingModels, remoteModels,
  } = useSettingsDraft({ config, onClearSaveResult: () => setSaveResult(null) });

  // --- Phase 74-G：自动保存 + 实时预览 + 卸载恢复 + 保存提示已迁移到 useAutoSave hook ---
  const { saving, handleSave } = useAutoSave({
    draft, setDraft, dirtyRef,
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
  } = useMcpCatalog({ activeTab, updateDraft, draft });

  // Phase 88 重构：移除 advancedExpanded 折叠组，改为四层分组扁平展示

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
        // Bug #7 修复：导入后标记 dirtyRef=true，触发 700ms 自动保存
        // 否则导入的配置只在 draft 中，不会写入磁盘，用户以为已保存但实际未保存
        dirtyRef.current = true;
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
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4">
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
      <div className="flex flex-1 min-h-0 gap-4 overflow-hidden">
        {/* 左侧标签导航栏（Phase 88 重构：四层分组） */}
        <SettingsNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
        />

        {/* 右侧内容区（relative 定位，子 tab 内容用 absolute inset-0 填充，避免 flexbox 高度抖动） */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
      {/* ===== 模型与路由（providers + router） ===== */}
      {activeTab === 'models' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
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
            handleRefreshModels={handleRefreshModels}
            refreshingModels={refreshingModels}
            remoteModels={remoteModels}
            openAddModel={openAddModel}
            openEditModel={openEditModel}
            removeModel={removeModel}
            modelEditor={modelEditor}
            setModelEditor={setModelEditor}
            confirmModelEditor={confirmModelEditor}
          />
          <SettingsAdvancedSection
            title="高级路由"
            description="什么时候切换模型；通常保持默认即可"
          >
            <SettingsRouterTab
              draft={draft}
              updateDraft={updateDraft}
              updateBudget={updateBudget}
              updateRule={updateRule}
              addRule={addRule}
              removeRule={removeRule}
            />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 外观与交互（基本=appearance，高级=conversation/persona/voice） ===== */}
      {activeTab === 'appearance' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
          <SettingsAppearanceTab
            draft={draft}
            updateGeneral={updateGeneral}
            updateUi={updateUi}
            updateBackgroundBehavior={updateBackgroundBehavior}
            updateUpdates={updateUpdates}
          />
          <SettingsAdvancedSection
            title="更多对话选项"
            description="需要时调整对话显示、回复风格或语音"
          >
            <SettingsConversationTab draft={draft} updateDraft={updateDraft} />
            <SettingsPersonaTab draft={draft} updateDraft={updateDraft} />
            <SettingsVoiceTab draft={draft} updateDraft={updateDraft} />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 安全与治理（基本=security，高级=policies/phase52-53/expertise/分层/packs） ===== */}
      {activeTab === 'security' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
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
          <SettingsAdvancedSection
            title="高级安全选项"
            description="一般保持默认；只在需要自定义规则时修改"
          >
            <SettingsPoliciesTab draft={draft} updateDraft={updateDraft} />
            <SettingsPhase52IntegrationTab draft={draft} updateDraft={updateDraft} />
            <SettingsPhase53IntegrationTab draft={draft} updateDraft={updateDraft} />
            <SettingsExpertiseTab draft={draft} updateExpertise={updateExpertise} />
            <SettingsConfigLayeringTab draft={draft} updateDraft={updateDraft} />
            <SettingsResultSchemaTab draft={draft} updateDraft={updateDraft} />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 执行与记忆（基本=execution，高级=memory/checkpoint） ===== */}
      {activeTab === 'execution' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
          <SettingsExecutionTab
            draft={draft}
            updateExecution={updateExecution}
            updateQuality={updateQuality}
          />
          <SettingsAdvancedSection
            title="恢复与记忆"
            description="保存进度，方便中断后继续"
          >
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
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== Agent 编排（基本=subagents+commands，高级=goal/experiment/reviewer/delegation） ===== */}
      {activeTab === 'orchestration' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
          <SettingsSubAgentsTab
            draft={draft}
            updateSubAgents={updateSubAgents}
            updateSubAgentsGateRules={updateSubAgentsGateRules}
            agentProfiles={agentProfiles}
            setAgentProfiles={setAgentProfiles}
            expandedAgentId={expandedAgentId}
            setExpandedAgentId={setExpandedAgentId}
          />
          <SettingsCommandsTab
            draft={draft}
            updateSecurity={updateSecurity}
            updateAutonomy={updateAutonomy}
            updatePhase48Integration={updatePhase48Integration}
          />
          <SettingsAdvancedSection
            title="高级自动化"
            description="目标、实验和审查流程；一般不需要调整"
          >
            <SettingsGoalTab draft={draft} updateDraft={updateDraft} />
            <SettingsExperimentTab draft={draft} updateDraft={updateDraft} />
            <SettingsReviewerTab draft={draft} updateDraft={updateDraft} />
            <SettingsDelegationTab draft={draft} updateDraft={updateDraft} />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 插件生态（基本=mcp，高级=skills/hooks/codemap/market） ===== */}
      {activeTab === 'plugins' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
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
          <SettingsAdvancedSection
            title="更多扩展"
            description="钩子、代码地图和市场；按需启用"
          >
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
            <SettingsCodemapTab draft={draft} updateDraft={updateDraft} />
            <SettingsMarketTab draft={draft} updateDraft={updateDraft} />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 统计与归档（基本=archived，高级=optimization） ===== */}
      {activeTab === 'misc' && (
        <div className="absolute inset-0 space-y-4 overflow-y-auto pr-2">
          <SettingsArchivedTab />
          <SettingsAdvancedSection
            title="用量与缓存"
            description="查看用量；其余选项通常保持默认"
          >
            <SettingsOptimizationTab
              draft={draft}
              updateTokenTracking={updateTokenTracking}
              updateSafety={updateSafety}
              updateConciseThinking={updateConciseThinking}
              updatePrompts={updatePrompts}
            />
          </SettingsAdvancedSection>
        </div>
      )}

      {/* ===== 关于 ===== */}
      {activeTab === 'about' && (
        <SettingsAboutTab />
      )}

        </div>
      </div>
    </div>
    <AlertBanner message={alertMsg} onDismiss={() => setAlertMsg(null)} />
    </>
  );
}
