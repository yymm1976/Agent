// desktop/renderer/src/pages/TokenPage.tsx
// Token 可视化页面：饼图展示组件占比 + 柱状图展示会话时间线

import { BarChart3, Cpu, FileText, History, List, MessageSquare, Wrench } from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { TokenProfileSnapshot } from '../../../../src/agent/token-profiler.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';

interface TokenPageProps {
  tokenSnapshots: TokenProfileSnapshot[];
}

// 与 Tailwind 设计系统一致的 Token 色值
const CHART_COLORS = {
  primary: '#4f46e5',
  success: '#16a34a',
  warning: '#f59e0b',
  danger: '#dc2626',
  muted: '#475569',
};

const COMPONENT_CONFIG: Array<{
  key: keyof TokenProfileSnapshot;
  label: string;
  color: string;
  dotClass: string;
}> = [
  { key: 'systemPrompt', label: '系统提示词', color: CHART_COLORS.primary, dotClass: 'bg-rd-primary' },
  { key: 'conversationHistory', label: '对话历史', color: CHART_COLORS.danger, dotClass: 'bg-rd-danger' },
  { key: 'toolDefinitions', label: '工具定义', color: CHART_COLORS.muted, dotClass: 'bg-rd-textMuted' },
  { key: 'toolResults', label: '工具结果', color: CHART_COLORS.warning, dotClass: 'bg-rd-warning' },
  { key: 'userMessage', label: '用户消息', color: CHART_COLORS.success, dotClass: 'bg-rd-success' },
];

const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  color: '#f8fafc',
  fontSize: '12px',
};

export function TokenPage({ tokenSnapshots }: TokenPageProps) {
  if (tokenSnapshots.length === 0) {
    return (
      <Card className="flex h-full flex-col items-center justify-center text-rd-textMuted">
        <BarChart3 size={48} className="mb-4 text-rd-primary/50" />
        <p className="text-lg font-medium text-rd-text">暂无 Token 数据</p>
        <p className="mt-1 text-sm">发起一次对话后，这里会显示各组件的 Token 占比</p>
      </Card>
    );
  }

  const latest = tokenSnapshots[tokenSnapshots.length - 1];
  const totalEstimated = tokenSnapshots.reduce((sum, s) => sum + s.totalEstimated, 0);
  const avgEstimated = Math.round(totalEstimated / tokenSnapshots.length);

  const pieData = COMPONENT_CONFIG.map((c) => ({
    name: c.label,
    value: (latest[c.key] as number) || 0,
    color: c.color,
    dotClass: c.dotClass,
  }));

  const timelineData = tokenSnapshots.map((s, idx) => ({
    index: idx + 1,
    time: new Date(s.timestamp).toLocaleTimeString(),
    total: s.totalEstimated,
    model: s.modelId,
  }));

  const statItems = [
    { label: '系统提示词', value: latest.systemPrompt || 0, icon: <FileText size={20} className="text-rd-primary" />, className: 'border-rd-primary/20 bg-rd-primary/10 text-rd-primary' },
    { label: '对话历史', value: latest.conversationHistory || 0, icon: <History size={20} className="text-rd-danger" />, className: 'border-rd-danger/20 bg-rd-danger/10 text-rd-danger' },
    { label: '工具定义', value: latest.toolDefinitions || 0, icon: <List size={20} className="text-rd-textMuted" />, className: 'border-rd-border bg-rd-surface text-rd-textMuted' },
    { label: '工具结果', value: latest.toolResults || 0, icon: <Wrench size={20} className="text-rd-warning" />, className: 'border-rd-warning/20 bg-rd-warning/10 text-rd-warning' },
    { label: '用户消息', value: latest.userMessage || 0, icon: <MessageSquare size={20} className="text-rd-success" />, className: 'border-rd-success/20 bg-rd-success/10 text-rd-success' },
    { label: '总计估算', value: latest.totalEstimated || 0, icon: <Cpu size={20} className="text-rd-primary" />, className: 'border-rd-primary/20 bg-rd-primary/10 text-rd-primary' },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto">
      {/* 统计卡片：六个指标 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {statItems.map((item) => (
          <Card key={item.label} className="flex items-center gap-3 p-5">
            {item.icon}
            <div>
              <div className="text-xs text-rd-textMuted">{item.label}</div>
              <Badge className={item.className}>{item.value.toLocaleString()}</Badge>
            </div>
          </Card>
        ))}
      </div>

      {/* 饼图：最新快照五分表分布 */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Cpu size={18} className="text-rd-primary" />
            <CardTitle className="text-base">
              最新快照分布：{latest.modelId}（共 {latest.totalEstimated.toLocaleString()} tokens）
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-4 md:flex-row">
            <div className="h-72 w-full md:flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={40}
                    paddingAngle={2}
                  >
                    {pieData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} stroke="#ffffff" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => `${Number(value).toLocaleString()} tokens`}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex w-full flex-col justify-center gap-2 md:w-60">
              {pieData.map((entry) => {
                const percent =
                  latest.totalEstimated > 0 ? (entry.value / latest.totalEstimated) * 100 : 0;
                return (
                  <div key={entry.name} className="flex items-center gap-2 text-sm">
                    <span className={`h-3 w-3 shrink-0 rounded-sm ${entry.dotClass}`} />
                    <span className="flex-1 text-rd-text">{entry.name}</span>
                    <span className="text-rd-textMuted">{entry.value.toLocaleString()}</span>
                    <span className="w-12 text-right text-xs text-rd-textMuted">
                      {percent.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 柱状图：会话时间线 */}
      <Card className="flex-1">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-rd-warning" />
            <CardTitle className="text-base">会话时间线：每次 LLM 调用的 Token 总量</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timelineData}>
                <XAxis
                  dataKey="index"
                  stroke="#94a3b8"
                  fontSize={12}
                  label={{
                    value: '调用序号',
                    position: 'insideBottom',
                    offset: -2,
                    fill: '#94a3b8',
                    fontSize: 11,
                  }}
                />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: '#e2e8f0', opacity: 0.5 }}
                  formatter={(value) => [`${Number(value).toLocaleString()} tokens`, '总量']}
                  labelFormatter={(label) => {
                    const item = timelineData.find((d) => d.index === Number(label));
                    return item ? `#${item.index} ${item.time} · ${item.model}` : `#${label}`;
                  }}
                />
                <Bar dataKey="total" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
