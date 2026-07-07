// desktop/renderer/src/components/settings/SettingsChannelsTab.tsx
// Phase 74-G：渠道集成设置 Tab（Webhook 安全 + 渠道服务 + 渠道列表 + 新增渠道）
// 从 SettingsPage.tsx 迁移

import type { Dispatch, SetStateAction } from 'react';
import { Trash2, Plus, X, Eye, EyeOff } from 'lucide-react';
import type { AppConfig, ChannelType } from '../../../../../src/config/schema.js';
import { getChannelOptionFields } from '../../pages/settings-helpers.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Badge } from '../ui/badge.js';

interface SettingsChannelsTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新渠道配置 */
  updateChannels: (patch: Partial<AppConfig['channels']>) => void;
  /** Webhook authToken 显示/隐藏切换 */
  showChannelAuthToken: boolean;
  /** 设置 Webhook authToken 显示/隐藏 */
  setShowChannelAuthToken: Dispatch<SetStateAction<boolean>>;
  /** 渠道编辑索引（null=无编辑） */
  editingChannelIdx: number | null;
  /** 设置渠道编辑索引 */
  setEditingChannelIdx: Dispatch<SetStateAction<number | null>>;
  /** 渠道凭据值 */
  channelCreds: Record<string, string>;
  /** 设置渠道凭据值 */
  setChannelCreds: Dispatch<SetStateAction<Record<string, string>>>;
  /** 渠道凭据显示/隐藏状态 */
  showChannelCreds: Record<string, boolean>;
  /** 设置渠道凭据显示/隐藏状态 */
  setShowChannelCreds: Dispatch<SetStateAction<Record<string, boolean>>>;
  /** 是否显示新增渠道表单 */
  showAddChannel: boolean;
  /** 设置是否显示新增渠道表单 */
  setShowAddChannel: Dispatch<SetStateAction<boolean>>;
  /** 新增渠道表单状态 */
  newChannel: { id: string; type: ChannelType };
  /** 设置新增渠道表单状态 */
  setNewChannel: Dispatch<SetStateAction<{ id: string; type: ChannelType }>>;
  /** 删除渠道 */
  removeChannel: (index: number) => void;
  /** 保存渠道凭据 */
  saveChannelOptions: (index: number) => void;
  /** 添加渠道 */
  addChannel: () => void;
}

/**
 * 渠道集成设置 Tab
 * 包含：Webhook 安全、渠道服务配置、渠道列表（含凭据编辑）、新增渠道表单
 */
export function SettingsChannelsTab({
  draft,
  updateChannels,
  showChannelAuthToken,
  setShowChannelAuthToken,
  editingChannelIdx,
  setEditingChannelIdx,
  channelCreds,
  setChannelCreds,
  showChannelCreds,
  setShowChannelCreds,
  showAddChannel,
  setShowAddChannel,
  newChannel,
  setNewChannel,
  removeChannel,
  saveChannelOptions,
  addChannel,
}: SettingsChannelsTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* Webhook 安全 */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook 安全</CardTitle>
          <CardDescription>
            控制 Webhook 入口的认证与 IP 信任策略，防止未授权调用与速率限制绕过。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Bearer Token 认证 */}
          <div className="space-y-2">
            <Label htmlFor="channel-auth-token">Bearer Token 认证</Label>
            <div className="flex gap-2">
              <Input
                id="channel-auth-token"
                type={showChannelAuthToken ? 'text' : 'password'}
                value={draft.channels.authToken ?? ''}
                onChange={(e) => updateChannels({ authToken: e.target.value || undefined })}
                placeholder="留空则进入开发模式，跳过认证"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowChannelAuthToken((v) => !v)}
                title={showChannelAuthToken ? '隐藏' : '显示'}
              >
                {showChannelAuthToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
            </div>
            <p className="text-xs text-rd-textMuted">
              配置后所有 Webhook 请求需带 <code>Authorization: Bearer &lt;token&gt;</code>；未配置时为开发模式，跳过认证。
            </p>
          </div>

          {/* 信任 X-Forwarded-For */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="channel-trust-proxy">信任 X-Forwarded-For</Label>
              <p className="text-xs text-rd-textMuted">
                反向代理场景才应启用；直连时禁用以防客户端伪造 IP 绕过速率限制。
              </p>
            </div>
            <Switch
              id="channel-trust-proxy"
              checked={draft.channels.trustProxy ?? false}
              onCheckedChange={(checked) => updateChannels({ trustProxy: checked })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>渠道服务</CardTitle>
          <CardDescription>Webhook 服务端口与响应限制</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="channel-port">端口</Label>
              <Input
                id="channel-port"
                type="number"
                value={draft.channels.port}
                onChange={(e) => updateChannels({ port: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">Webhook 服务监听的本地端口，外部渠道通过此端口推送消息。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-public">公开 URL</Label>
              <Input
                id="channel-public"
                value={draft.channels.publicUrl ?? ''}
                onChange={(e) => updateChannels({ publicUrl: e.target.value || undefined })}
              />
              <p className="text-xs text-rd-textMuted">对外暴露的回调地址（如内网穿透后的公网 URL），用于注册到第三方渠道。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-max">最大响应长度</Label>
              <Input
                id="channel-max"
                type="number"
                value={draft.channels.maxResponseLength}
                onChange={(e) => updateChannels({ maxResponseLength: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">单条渠道消息回复的最大字符数，超出会截断。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-timeout">请求超时（毫秒）</Label>
              <Input
                id="channel-timeout"
                type="number"
                value={draft.channels.requestTimeout}
                onChange={(e) => updateChannels({ requestTimeout: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">等待 Agent 处理渠道消息的最长时间，超时后返回错误。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {draft.channels.entries.map((entry, idx) => (
        <Card key={idx}>
          <CardContent className="py-6">
            <div className="flex items-center justify-between gap-4">
              <div className="grid flex-1 grid-cols-2 gap-4 md:grid-cols-3">
                <div className="space-y-1">
                  <div className="text-xs text-rd-textMuted">ID</div>
                  <div className="text-sm font-medium text-rd-text">{entry.id}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-rd-textMuted">类型</div>
                  <Badge variant="outline">{entry.type}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 md:justify-start">
                  <Label htmlFor={`channel-enabled-${idx}`}>启用</Label>
                  <Switch
                    id={`channel-enabled-${idx}`}
                    checked={entry.enabled}
                    onCheckedChange={(checked) => {
                      const entries = [...draft.channels.entries];
                      entries[idx] = { ...entry, enabled: checked };
                      updateChannels({ entries });
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (editingChannelIdx === idx) {
                      setEditingChannelIdx(null);
                      setChannelCreds({});
                    } else {
                      // 预填现有 options 值
                      const creds: Record<string, string> = {};
                      for (const field of getChannelOptionFields(entry.type)) {
                        creds[field.key] = entry.options[field.key] ?? '';
                      }
                      setChannelCreds(creds);
                      setEditingChannelIdx(idx);
                    }
                  }}
                >
                  {editingChannelIdx === idx ? '收起' : '编辑凭据'}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                  onClick={() => removeChannel(idx)}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>

            {/* 渠道凭据编辑区域（展开时显示） */}
            {editingChannelIdx === idx && (
              <div className="mt-4 space-y-3 border-t border-rd-border pt-4">
                {getChannelOptionFields(entry.type).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`ch-edit-${idx}-${field.key}`}>
                      {field.label}
                      {field.required && <span className="ml-1 text-rd-danger">*</span>}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`ch-edit-${idx}-${field.key}`}
                        type={field.sensitive && !showChannelCreds[`${idx}-${field.key}`] ? 'password' : 'text'}
                        value={channelCreds[field.key] ?? ''}
                        onChange={(e) => setChannelCreds({ ...channelCreds, [field.key]: e.target.value })}
                        placeholder={field.sensitive ? '支持 ${ENV_VAR} 环境变量引用' : ''}
                      />
                      {field.sensitive && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setShowChannelCreds({ ...showChannelCreds, [`${idx}-${field.key}`]: !showChannelCreds[`${idx}-${field.key}`] })}
                          title={showChannelCreds[`${idx}-${field.key}`] ? '隐藏' : '显示'}
                        >
                          {showChannelCreds[`${idx}-${field.key}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-rd-textMuted">{field.hint}</p>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveChannelOptions(idx)}>
                    保存凭据
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setEditingChannelIdx(null); setChannelCreds({}); }}>
                    取消
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {showAddChannel ? (
        <Card>
          <CardHeader>
            <CardTitle>新增渠道</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="channel-new-id">ID</Label>
                <Input
                  id="channel-new-id"
                  value={newChannel.id}
                  onChange={(e) => setNewChannel({ ...newChannel, id: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="channel-new-type">类型</Label>
                <Select
                  id="channel-new-type"
                  value={newChannel.type}
                  onChange={(e) => {
                    const type = e.target.value as ChannelType;
                    setNewChannel({ ...newChannel, type });
                    // 切换类型时清空凭据
                    setChannelCreds({});
                  }}
                >
                  <SelectItem value="wechat-work">企业微信</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  {/* Discord 适配器尚未实现，暂不显示选项 */}
                </Select>
                <p className="text-xs text-rd-textMuted">Discord 适配器开发中，暂不可选。</p>
              </div>
            </div>

            {/* 动态渲染渠道凭据字段 */}
            {getChannelOptionFields(newChannel.type).map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`ch-new-${field.key}`}>
                  {field.label}
                  {field.required && <span className="ml-1 text-rd-danger">*</span>}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`ch-new-${field.key}`}
                    type={field.sensitive && !showChannelCreds[`new-${field.key}`] ? 'password' : 'text'}
                    value={channelCreds[field.key] ?? ''}
                    onChange={(e) => setChannelCreds({ ...channelCreds, [field.key]: e.target.value })}
                    placeholder={field.sensitive ? '支持 ${ENV_VAR} 环境变量引用' : ''}
                  />
                  {field.sensitive && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setShowChannelCreds({ ...showChannelCreds, [`new-${field.key}`]: !showChannelCreds[`new-${field.key}`] })}
                      title={showChannelCreds[`new-${field.key}`] ? '隐藏' : '显示'}
                    >
                      {showChannelCreds[`new-${field.key}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-rd-textMuted">{field.hint}</p>
              </div>
            ))}

            <div className="flex items-center gap-2">
              <Button onClick={addChannel} disabled={!newChannel.id}>
                <Plus size={16} /> 添加
              </Button>
              <Button variant="ghost" onClick={() => { setShowAddChannel(false); setChannelCreds({}); }}>
                <X size={16} /> 取消
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button onClick={() => { setShowAddChannel(true); setChannelCreds({}); }} className="w-full">
          <Plus size={16} /> 添加渠道
        </Button>
      )}
    </div>
  );
}
