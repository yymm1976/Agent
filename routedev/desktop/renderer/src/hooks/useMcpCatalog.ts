// desktop/renderer/src/hooks/useMcpCatalog.ts
// Phase 74-G：SettingsPage 的 MCP 插件市场 hook
// 从 SettingsPage.tsx 迁移，保留所有原逻辑与函数签名

import { useState, useEffect } from 'react';
import type { AppConfig } from '../../../shared/config-types.js';
import type { MCPCatalogEntry, MCPInstallResult } from '../../../shared/ipc-types.js';

interface UseMcpCatalogOptions {
  /** 当前激活的 Tab id（用于触发 MCP Tab 懒加载） */
  activeTab: string;
  /** 来自 useSettingsDraft 的 updateDraft 函数（安装成功后同步 mcp 配置） */
  updateDraft: (patch: Partial<AppConfig>) => void;
  /** 当前 draft（用于安装成功后合并新 server，避免整体替换丢失用户编辑） */
  draft: AppConfig | null;
}

/**
 * MCP 插件市场 hook
 * 包含：8 个 state + 5 个 handler + 进入 MCP Tab 加载 useEffect
 */
export function useMcpCatalog({ activeTab, updateDraft, draft }: UseMcpCatalogOptions) {
  const [catalogEntries, setCatalogEntries] = useState<MCPCatalogEntry[]>([]);
  const [catalogCategory, setCatalogCategory] = useState<string>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<{ id: string; success: boolean; error?: string } | null>(null);
  const [installModal, setInstallModal] = useState<MCPCatalogEntry | null>(null);
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [headerInputs, setHeaderInputs] = useState<Record<string, string>>({});

  // MCP 市场：进入 MCP Tab 时加载目录
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // 加载目录（按分类或搜索关键词）
  const refreshCatalog = async (category?: string, search?: string) => {
    try {
      const cat = category ?? catalogCategory;
      const q = (search ?? catalogSearch).trim();
      const result = q
        ? await window.routedev.mcp.catalog.search(q)
        : await window.routedev.mcp.catalog.list(cat === 'all' ? undefined : cat);
      setCatalogEntries(result.entries);
    } catch (err) {
      // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
      console.error('[MCP Market] 加载目录失败:', err);
      setCatalogEntries([]);
    }
  };

  // 切换分类
  const handleCatalogCategoryChange = (cat: string) => {
    setCatalogCategory(cat);
    setCatalogSearch('');
    refreshCatalog(cat, '');
  };

  // 搜索
  const handleCatalogSearch = (value: string) => {
    setCatalogSearch(value);
    if (value.trim()) {
      refreshCatalog(undefined, value);
    } else {
      refreshCatalog(catalogCategory, '');
    }
  };

  // 打开安装模态框
  const openInstallModal = (entry: MCPCatalogEntry) => {
    setInstallModal(entry);
    // 初始化 env/headers 输入框
    const envInit: Record<string, string> = {};
    for (const key of entry.requiredEnv ?? []) envInit[key] = '';
    setEnvInputs(envInit);
    const hdrInit: Record<string, string> = {};
    for (const key of entry.requiredHeaders ?? []) hdrInit[key] = '';
    setHeaderInputs(hdrInit);
    setInstallResult(null);
  };

  // 执行安装
  const handleInstall = async () => {
    if (!installModal) return;
    setInstallingId(installModal.id);
    setInstallResult(null);
    try {
      const result: MCPInstallResult = await window.routedev.mcp.install({
        catalogId: installModal.id,
        envValues: envInputs,
        headerValues: headerInputs,
      });
      setInstallResult({ id: installModal.id, success: result.success, error: result.error });
      if (result.success) {
        // 安装成功后同步 draft：合并磁盘新增的 server 到 draft，不整体替换 mcp 字段
        // 之前用 updateDraft({ mcp: newConfig.mcp }) 会丢失用户正在编辑的 MCP 改动
        const newConfig = await window.routedev.config.get();
        // 合并策略：保留 draft 中已有的 server，追加磁盘新增的 server
        const existingIds = new Set((draft?.mcp.servers ?? []).map((s) => s.id));
        const newServers = newConfig.mcp.servers.filter((s) => !existingIds.has(s.id));
        if (newServers.length > 0) {
          updateDraft({
            mcp: {
              ...draft!.mcp,
              servers: [...draft!.mcp.servers, ...newServers],
            },
          });
        }
      }
    } catch (err) {
      setInstallResult({ id: installModal.id, success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstallingId(null);
    }
  };

  return {
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
  };
}
