// desktop/renderer/src/components/settings/SettingsArchivedTab.tsx
// 归档对话面板：从 useProjectsStore 读取归档列表，支持还原与永久删除
// Phase 74-G：从 SettingsPage.tsx 物理迁移 ArchivedConversationsPanel（原 L5563-5673）

import { useState } from 'react';
import { Archive, Folder, RotateCcw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/dialog.js';
import { useProjectsStore } from '../../store/useProjectsStore.js';

export function SettingsArchivedTab() {
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
