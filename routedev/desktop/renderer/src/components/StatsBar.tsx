// desktop/renderer/src/components/StatsBar.tsx
// Phase 96+ A3.4：实时费用 + 缓存命中率状态条
//
// 设计目标：
//   1. 单行紧凑布局，最小占用屏幕空间（符合用户偏好「工具调用 UI 应有最小占用」）
//   2. 通过 IPC stats:get-snapshot 拉取主进程聚合快照（避免多通道往返）
//   3. 轮询频率自适应：生成中 1s，空闲 3s
//   4. 无数据时自动隐藏（首次启动 / 引擎未就绪）
//   5. 主题色与 rounded 风格与 Layout 一致
//
// 显示字段：
//   - tokens：累计输入 / 输出 token 数（k 单位）
//   - cost：会话累计费用（USD，4 位小数）
//   - cache：会话级缓存命中率（百分比）
//   - budget：日预算使用率（百分比，超限标红）

import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowUpDown, Coins, Database, Gauge } from 'lucide-react';
import type { StatsSnapshot } from '../../../shared/ipc-types.js';

/** 空快照（用于初始化 / 引擎未就绪时） */
const EMPTY_SNAPSHOT: StatsSnapshot = {
  tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  cost: { totalUsd: 0, byModel: {} },
  cache: {
    session: { hit: 0, miss: 0, total: 0, hitRate: 0 },
    turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
  },
  budgetUsagePercent: 0,
  activeModels: [],
  updatedAt: new Date().toISOString(),
};

/** 数值格式化：超过 1000 时显示 k 后缀，保留 1 位小数 */
function formatTokens(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** USD 费用格式化：< 0.01 时显示 4 位小数，否则 2 位 */
function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** 百分比格式化：0-1 范围转 0-100，保留整数 */
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

interface StatsBarProps {
  /** 是否正在生成回复（影响轮询频率） */
  isProcessing?: boolean;
  /** 轮询间隔（毫秒），默认空闲 3000 / 生成中 1000 */
  idleInterval?: number;
  activeInterval?: number;
}

/**
 * StatsBar：单行统计状态条
 *
 * 通过 IPC stats:get-snapshot 拉取主进程聚合的 token / cost / cache / budget 数据，
 * 自适应轮询频率（生成中加快刷新），无数据时返回 null 不渲染。
 */
export function StatsBar({
  isProcessing = false,
  idleInterval = 3000,
  activeInterval = 1000,
}: StatsBarProps) {
  const [snapshot, setSnapshot] = useState<StatsSnapshot>(EMPTY_SNAPSHOT);
  const [hasData, setHasData] = useState(false);
  // 用 ref 持有最新的 isProcessing，避免 effect 频繁重订阅
  const processingRef = useRef(isProcessing);
  processingRef.current = isProcessing;

  const fetchSnapshot = useCallback(async () => {
    const api = window.routedev as
      | { stats?: { getSnapshot?: () => Promise<StatsSnapshot> } }
      | undefined;
    try {
      const result = await api?.stats?.getSnapshot?.();
      if (!result) return;
      setSnapshot(result);
      // 有任何 token 消耗或费用时才显示
      const hasContent =
        result.tokens.totalTokens > 0 ||
        result.cost.totalUsd > 0 ||
        result.cache.session.total > 0;
      setHasData(hasContent);
    } catch {
      // fail-silent：IPC 异常时不打扰用户
    }
  }, []);

  useEffect(() => {
    // 首次挂载立即拉取一次
    void fetchSnapshot();
    // 自适应轮询：生成中加快频率
    const interval = processingRef.current ? activeInterval : idleInterval;
    const timer = setInterval(() => {
      void fetchSnapshot();
    }, interval);
    return () => clearInterval(timer);
  }, [fetchSnapshot, idleInterval, activeInterval, isProcessing]);

  // 无数据时不渲染，避免占用空间
  if (!hasData) return null;

  const budget = snapshot.budgetUsagePercent;
  const budgetOver = budget > 1;
  const budgetPctText = `${Math.round(budget * 100)}%`;

  // 单模型时不显示模型数，多模型时显示计数
  const modelCount = snapshot.activeModels.length;
  const showModelCount = modelCount > 1;

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-rd-textMuted"
      role="status"
      aria-label="会话统计"
      title={`更新于 ${new Date(snapshot.updatedAt).toLocaleTimeString()}`}
    >
      {/* Tokens */}
      <div className="flex items-center gap-1" title={`输入 ${snapshot.tokens.inputTokens} / 输出 ${snapshot.tokens.outputTokens}`}>
        <ArrowUpDown size={12} className="text-rd-primary/70" />
        <span>
          <span className="text-rd-text/80">{formatTokens(snapshot.tokens.inputTokens)}</span>
          <span className="mx-0.5 opacity-50">/</span>
          <span className="text-rd-text/80">{formatTokens(snapshot.tokens.outputTokens)}</span>
        </span>
      </div>

      <span className="h-3 w-px bg-rd-border/60" aria-hidden />

      {/* Cost */}
      <div className="flex items-center gap-1" title={`会话累计费用（USD）${modelCount > 0 ? ` · 模型: ${snapshot.activeModels.join(', ')}` : ''}`}>
        <Coins size={12} className="text-rd-primary/70" />
        <span className="text-rd-text/80">{formatUsd(snapshot.cost.totalUsd)}</span>
        {showModelCount && (
          <span className="ml-0.5 rounded bg-rd-surfaceHover px-1 text-[10px]">×{modelCount}</span>
        )}
      </div>

      <span className="h-3 w-px bg-rd-border/60" aria-hidden />

      {/* Cache hit rate */}
      <div
        className="flex items-center gap-1"
        title={`缓存命中: ${snapshot.cache.session.hit} / 总计 ${snapshot.cache.session.total}（本轮 ${Math.round(snapshot.cache.turn.hitRate * 100)}%）`}
      >
        <Database size={12} className="text-rd-primary/70" />
        <span className="text-rd-text/80">{formatPercent(snapshot.cache.session.hitRate)}</span>
      </div>

      {/* Budget（仅当 > 0 时显示，超限标红） */}
      {budget > 0 && (
        <>
          <span className="h-3 w-px bg-rd-border/60" aria-hidden />
          <div
            className="flex items-center gap-1"
            title={`日预算使用率${budgetOver ? '（已超限）' : ''}`}
          >
            <Gauge size={12} className={budgetOver ? 'text-rd-danger' : 'text-rd-primary/70'} />
            <span className={budgetOver ? 'text-rd-danger font-medium' : 'text-rd-text/80'}>
              {budgetPctText}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
