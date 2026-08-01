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
import { ConfirmDialog } from '../components/ui/dialog.js';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { useSettingsDraft } from '../hooks/useSettingsDraft.js';
import { useAutoSave, type SaveResult } from '../hooks/useAutoSave.js';
import { useSkillsManager, type ConfirmDialogState } from '../hooks/useSkillsManager.js';
import { useHooksManager } from '../hooks/useHooksManager.js';
import { useMcpCatalog } from '../hooks/useMcpCatalog.js';
import { SettingsHeader } from '../components/settings/SettingsHeader.js';
import { SettingsNav, type TabId } from '../components/settings/SettingsNav.js';
import { SaveToast } from '../components/settings/SaveToast.js';
// Phase 92：Tab 内容渲染与对话框已拆分到独立组件
import { SettingsTabNav } from '../components/settings/SettingsTabNav.js';
import { SettingsDialogs } from '../components/settings/SettingsDialogs.js';

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
  const draftApi = useSettingsDraft({ config, onClearSaveResult: () => setSaveResult(null) });
  const { draft, setDraft, dirtyRef } = draftApi;

  // --- Phase 74-G：自动保存 + 实时预览 + 卸载恢复 + 保存提示已迁移到 useAutoSave hook ---
  const { saving, handleSave } = useAutoSave({
    draft, setDraft, dirtyRef,
    config, saveConfig, reloadConfig,
    saveResult, setSaveResult,
  });

  // --- Phase 74-G：Skills/Hooks/MCP 管理已迁移到对应 hook ---
  const skillsApi = useSkillsManager({ activeTab, setAlertMsg, setConfirmDialog });
  const hooksApi = useHooksManager({ activeTab, setAlertMsg, setConfirmDialog });
  const mcpCatalogApi = useMcpCatalog({ activeTab, updateDraft: draftApi.updateDraft, draft });

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
  // --- Phase 92：Tab 内容渲染已迁移到 SettingsTabNav.tsx ---

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

        {/* 右侧内容区（Phase 92：迁移到 SettingsTabNav；relative 定位，子 tab 内容用 absolute inset-0 填充，避免 flexbox 高度抖动） */}
        <SettingsTabNav
          activeTab={activeTab}
          draft={draft}
          draftApi={draftApi}
          skillsApi={skillsApi}
          hooksApi={hooksApi}
          mcpCatalogApi={mcpCatalogApi}
          setAlertMsg={setAlertMsg}
          applyConfig={async () => {
            await handleSave();
          }}
        />
      </div>
    </div>
    {/* 错误提示横幅（Phase 92：迁移到 SettingsDialogs） */}
    <SettingsDialogs alertMsg={alertMsg} onDismiss={() => setAlertMsg(null)} />
    </>
  );
}
