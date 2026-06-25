// desktop/renderer/src/components/settings/SettingsConversationTab.tsx
// Phase 44：对话消息树持久化设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsConversationTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsConversationTab({ draft, updateDraft }: SettingsConversationTabProps) {
  const conversation = draft.conversation;

  const updateConversation = (patch: Partial<typeof conversation>) => {
    updateDraft({ conversation: { ...conversation, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>对话持久化</CardTitle>
          <CardDescription>控制消息树、分支与撤销栈的持久化行为</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="conversation-persist">持久化消息树</Label>
              <p className="text-xs text-rd-textMuted">将对话消息树保存到磁盘，重启后可恢复。</p>
            </div>
            <Switch
              id="conversation-persist"
              checked={conversation.persistTree}
              onCheckedChange={(checked) => updateConversation({ persistTree: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="conversation-auto-snapshot">自动快照</Label>
              <p className="text-xs text-rd-textMuted">节点变更时自动写入快照，避免异常退出丢失。</p>
            </div>
            <Switch
              id="conversation-auto-snapshot"
              checked={conversation.autoSnapshot}
              onCheckedChange={(checked) => updateConversation({ autoSnapshot: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="conversation-max-nodes">最大节点数</Label>
            <Input
              id="conversation-max-nodes"
              type="number"
              min={100}
              value={conversation.maxNodes}
              onChange={(e) => updateConversation({ maxNodes: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">单棵消息树最多保留的节点数。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="conversation-max-branches">最大分支数</Label>
            <Input
              id="conversation-max-branches"
              type="number"
              min={5}
              value={conversation.maxBranches}
              onChange={(e) => updateConversation({ maxBranches: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">单棵树最多保留的并行分支数。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="conversation-undo-size">撤销栈大小</Label>
            <Input
              id="conversation-undo-size"
              type="number"
              min={0}
              value={conversation.undoStackSize}
              onChange={(e) => updateConversation({ undoStackSize: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">0 表示禁用撤销。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
