// desktop/renderer/src/components/settings/SettingsTabNav.tsx
// 设置页右侧 Tab 内容区：根据 activeTab 切换渲染对应的 Tab 组件
// 从 SettingsPage.tsx 迁移（仅移动代码，不改逻辑）

import type { AppConfig } from '../../../../shared/config-types.js';
import { SettingsProvidersTab } from './SettingsProvidersTab.js';
import { SettingsRouterTab } from './SettingsRouterTab.js';
import { SettingsAppearanceTab } from './SettingsAppearanceTab.js';
import { SettingsConversationTab } from './SettingsConversationTab.js';
import { SettingsPersonaTab } from './SettingsPersonaTab.js';
import { SettingsVoiceTab } from './SettingsVoiceTab.js';
import { SettingsSecurityTab } from './SettingsSecurityTab.js';
import { SettingsPoliciesTab } from './SettingsPoliciesTab.js';
import { SettingsPhase52IntegrationTab } from './SettingsPhase52IntegrationTab.js';
import { SettingsPhase53IntegrationTab } from './SettingsPhase53IntegrationTab.js';
import { SettingsExpertiseTab, SettingsAboutTab, SettingsMarketTab } from './SettingsMiscTabs.js';
import { SettingsConfigLayeringTab } from './SettingsConfigLayeringTab.js';
import { SettingsResultSchemaTab } from './SettingsResultSchemaTab.js';
import { SettingsExecutionTab } from './SettingsExecutionTab.js';
import { SettingsMemoryTab } from './SettingsMemoryTab.js';
import { SettingsSubAgentsTab } from './SettingsSubAgentsTab.js';
import { SettingsCommandsTab } from './SettingsCommandsTab.js';
import { SettingsGoalTab } from './SettingsGoalTab.js';
import { SettingsExperimentTab } from './SettingsExperimentTab.js';
import { SettingsReviewerTab } from './SettingsReviewerTab.js';
import { SettingsDelegationTab } from './SettingsDelegationTab.js';
import { SettingsMcpTab } from './SettingsMcpTab.js';
import { SettingsSkillsTab } from './SettingsSkillsTab.js';
import { SettingsHooksTab } from './SettingsHooksTab.js';
import { SettingsCodemapTab } from './SettingsCodemapTab.js';
import { SettingsArchivedTab } from './SettingsArchivedTab.js';
import { SettingsOptimizationTab } from './SettingsOptimizationTab.js';
import { SettingsAdvancedSection } from './SettingsAdvancedSection.js';
import { SettingsRemoteTab } from './SettingsRemoteTab.js';
import { type TabId } from './SettingsNav.js';
import type { useSettingsDraft } from '../../hooks/useSettingsDraft.js';
import type { useSkillsManager } from '../../hooks/useSkillsManager.js';
import type { useHooksManager } from '../../hooks/useHooksManager.js';
import type { useMcpCatalog } from '../../hooks/useMcpCatalog.js';

/** useSettingsDraft hook 返回值类型（用于复用，避免在 props 中重复声明 60+ 个字段） */
type DraftApi = ReturnType<typeof useSettingsDraft>;
/** useSkillsManager hook 返回值类型 */
type SkillsApi = ReturnType<typeof useSkillsManager>;
/** useHooksManager hook 返回值类型 */
type HooksApi = ReturnType<typeof useHooksManager>;
/** useMcpCatalog hook 返回值类型 */
type McpCatalogApi = ReturnType<typeof useMcpCatalog>;

interface SettingsTabNavProps {
  /** 当前激活的 Tab id */
  activeTab: TabId;
  /** 当前配置草稿（已在主组件 early return 后保证非空） */
  draft: AppConfig;
  /** useSettingsDraft 返回的全部字段（含更新函数和状态）。 */
  draftApi: DraftApi;
  /** useSkillsManager 返回的全部字段 */
  skillsApi: SkillsApi;
  /** useHooksManager 返回的全部字段 */
  hooksApi: HooksApi;
  /** useMcpCatalog 返回的全部字段 */
  mcpCatalogApi: McpCatalogApi;
  /** 替代原生 alert 的消息 setter（来自主组件 state，传给 SettingsSkillsTab） */
  setAlertMsg: (msg: string | null) => void;
  /** 保存当前 draft 并让主进程重新加载配置。 */
  applyConfig: () => Promise<void>;
}

/**
 * 设置页右侧 Tab 内容区
 *
 * 根据 activeTab 切换渲染对应的 Tab 组件组合（7 个 Tab 分组 + about）。
 * 外层容器 `relative min-w-0 flex-1 overflow-hidden`，内部各 Tab 用 `absolute inset-0` 填充，避免 flexbox 高度抖动。
 */
export function SettingsTabNav({
  activeTab, draft, draftApi, skillsApi, hooksApi, mcpCatalogApi, setAlertMsg, applyConfig,
}: SettingsTabNavProps) {
  // --- 从 draftApi 解构出 Tab 渲染所需字段（与原 SettingsPage 保持一致） ---
  const {
    updateDraft, updateProvider, addProvider, removeProvider,
    updateModel, openAddModel, openEditModel, confirmModelEditor, removeModel,
    updateRule, addRule, removeRule, updateBudget,
    updateSecurity, updateSecurityApproval,
    updateFsRule, addFsRule, removeFsRule,
    updateNetworkAllow, updateNetworkDeny,
    updateWebSearch, updateAdversarial,
    updateTokenTracking, updateSafety, updateConciseThinking, updatePrompts,
    updateCheckpoint, updateCheckpointTrigger, addCheckpointTrigger, removeCheckpointTrigger,
    updateGoalVerifier,
    updateExecution, updateQuality, updatePhase48Integration,
    updateProjectMemory, updateMemory,
    updateMcp, updateMcpServer, removeMcpServer, submitMcpForm, openAddMcp, openEditMcp,
    updateGeneral, updateBackgroundBehavior, updateUi, updateUpdates,
    updateTrust, updateExpertise,
    updateSubAgents, updateSubAgentsGateRules,
    updateAutonomy,
    toggleApiKey, handleTestConnection,
    handleRefreshModels, refreshingModels, remoteModels,
    showApiKeys, testingProvider, testResults,
    modelEditor, setModelEditor,
    mcpForm, setMcpForm, mcpEditingId, setMcpEditingId,
    agentProfiles, setAgentProfiles, expandedAgentId, setExpandedAgentId,
    selectedSearchEngine, setSelectedSearchEngine,
  } = draftApi;

  // --- 从 skillsApi 解构 ---
  const {
    skills,
    skillLoading,
    skillPreview, setSkillPreview,
    skillForm, setSkillForm,
    skillRouteTest, setSkillRouteTest,
    skillAiForm, setSkillAiForm,
    handleSkillReload, handleSkillToggle, handleSkillPreview,
    handleSkillDelete, handleSkillRouteTest, handleSkillCreate, handleSkillAiGenerate,
  } = skillsApi;

  // --- 从 hooksApi 解构 ---
  const {
    hooks,
    hookLoading,
    hookCreateForm, setHookCreateForm,
    refreshHooks, handleHookToggle, handleHookDelete, handleHookAiGenerate,
  } = hooksApi;

  // --- 从 mcpCatalogApi 解构 ---
  const {
    catalogEntries, catalogCategory, catalogSearch,
    handleCatalogCategoryChange, handleCatalogSearch,
    installingId, installResult, setInstallResult,
    installModal, setInstallModal,
    envInputs, setEnvInputs, headerInputs, setHeaderInputs,
    openInstallModal, handleInstall,
  } = mcpCatalogApi;

  return (
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

      {activeTab === 'remote' && (
        <div className="absolute inset-0 overflow-y-auto pr-2">
          <SettingsRemoteTab
            draft={draft}
            updateDraft={updateDraft}
            applyConfig={applyConfig}
          />
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
  );
}
