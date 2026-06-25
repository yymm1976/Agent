// desktop/renderer/src/store/useProjectsStore.ts
// 项目与对话的状态管理 + localStorage 持久化
// 结构：projects[] -> conversations[] -> messages[]
// 每个项目可包含多个对话，对话内消息复用 useRouteDevStore 的 ChatMessage 类型

import { create } from 'zustand';
import type { ChatMessage } from './useRouteDevStore.js';

// ===== 类型定义 =====
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  /** 关联的磁盘文件夹路径（可选，用户新建项目时选择） */
  path?: string;
  conversations: Conversation[];
  expanded: boolean;
  createdAt: number;
}

/** 归档对话：保留原对话内容 + 归属项目信息，便于还原 */
export interface ArchivedConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** 原归属项目 ID */
  projectId: string;
  /** 原归属项目名（冗余存储，项目被删除后仍可显示） */
  projectName: string;
  /** 归档时间 */
  archivedAt: number;
}

interface ProjectsState {
  projects: Project[];
  archivedConversations: ArchivedConversation[];
  currentProjectId: string | null;
  currentConversationId: string | null;

  // 项目操作
  addProject: (name?: string, path?: string) => string;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  toggleProjectExpanded: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  /** 设置项目关联的磁盘文件夹路径 */
  setProjectPath: (id: string, path: string) => void;
  /** 确保"未分类"项目存在（用于无项目关联的快速对话），返回其 id */
  ensureDefaultProject: () => string;

  // 对话操作
  addConversation: (projectId: string, title?: string) => string;
  /**
   * 新建对话并写入第一条用户消息（用于"新建任务"页面：发送后才创建对话，避免空白对话堆积）
   * 返回新对话 ID，并自动切换为当前对话
   */
  createConversationWithFirstMessage: (projectId: string, firstMessage: ChatMessage) => string;
  /**
   * 分支对话：新建对话，复制源对话中截至某条消息的所有消息到新对话
   * 用于从某条消息分叉出新的对话分支
   */
  forkConversationFromMessage: (
    sourceProjectId: string,
    sourceConvId: string,
    upToMessageId: string,
    targetProjectId?: string,
  ) => string;
  renameConversation: (projectId: string, convId: string, title: string) => void;
  /** 归档对话（移到归档列表，可还原） */
  archiveConversation: (projectId: string, convId: string) => void;
  /** 永久删除对话（不可恢复） */
  deleteConversation: (projectId: string, convId: string) => void;
  reorderConversations: (projectId: string, fromIndex: number, toIndex: number) => void;
  /** 检查项目下是否已有空对话（用于限制创建多个空对话） */
  hasEmptyConversation: (projectId: string) => boolean;

  // 归档操作
  /** 还原归档对话到原项目 */
  restoreConversation: (archivedId: string) => void;
  /** 永久删除归档对话 */
  deleteArchivedConversation: (archivedId: string) => void;

  // 当前选中
  selectConversation: (projectId: string, convId: string) => void;

  // 消息操作（与 useRouteDevStore 联动）
  setMessages: (projectId: string, convId: string, messages: ChatMessage[]) => void;
  getMessages: (projectId: string, convId: string) => ChatMessage[];

  // 持久化
  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = 'routedev-projects';
const ARCHIVE_STORAGE_KEY = 'routedev-archived-conversations';

// 生成唯一 ID
function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 从 localStorage 加载项目
function loadFromLocalStorage(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

// 从 localStorage 加载归档对话
function loadArchivedFromLocalStorage(): ArchivedConversation[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ArchivedConversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

// 保存项目到 localStorage
function saveToLocalStorage(projects: Project[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (err) {
    console.error('[projects] 持久化失败:', err);
  }
}

// 保存归档对话到 localStorage
function saveArchivedToLocalStorage(archived: ArchivedConversation[]): void {
  try {
    localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(archived));
  } catch (err) {
    console.error('[archived] 持久化失败:', err);
  }
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  archivedConversations: [],
  currentProjectId: null,
  currentConversationId: null,

  addProject: (name, path) => {
    const id = genId('proj');
    const now = Date.now();
    const project: Project = {
      id,
      name: name || '新项目',
      path,
      conversations: [],
      expanded: true,
      createdAt: now,
    };
    const projects = [...get().projects, project];
    set({ projects, currentProjectId: id });
    saveToLocalStorage(projects);
    return id;
  },

  renameProject: (id, name) => {
    const projects = get().projects.map((p) =>
      p.id === id ? { ...p, name } : p,
    );
    set({ projects });
    saveToLocalStorage(projects);
  },

  deleteProject: (id) => {
    const state = get();
    const projects = state.projects.filter((p) => p.id !== id);
    const currentProjectId =
      state.currentProjectId === id ? (projects[0]?.id ?? null) : state.currentProjectId;
    const currentConversationId =
      state.currentProjectId === id ? null : state.currentConversationId;
    set({ projects, currentProjectId, currentConversationId });
    saveToLocalStorage(projects);
  },

  toggleProjectExpanded: (id) => {
    const projects = get().projects.map((p) =>
      p.id === id ? { ...p, expanded: !p.expanded } : p,
    );
    set({ projects });
    saveToLocalStorage(projects);
  },

  reorderProjects: (fromIndex, toIndex) => {
    const projects = [...get().projects];
    if (fromIndex < 0 || fromIndex >= projects.length) return;
    if (toIndex < 0 || toIndex >= projects.length) return;
    const [moved] = projects.splice(fromIndex, 1);
    projects.splice(toIndex, 0, moved);
    set({ projects });
    saveToLocalStorage(projects);
  },

  setProjectPath: (id, path) => {
    const projects = get().projects.map((p) =>
      p.id === id ? { ...p, path } : p,
    );
    set({ projects });
    saveToLocalStorage(projects);
  },

  ensureDefaultProject: () => {
    // 查找已有的"未分类"项目（无 path 的同名项目）
    const existing = get().projects.find((p) => p.name === '未分类' && !p.path);
    if (existing) return existing.id;
    // 不存在则创建
    const id = genId('proj');
    const now = Date.now();
    const project: Project = {
      id,
      name: '未分类',
      conversations: [],
      expanded: true,
      createdAt: now,
    };
    const projects = [...get().projects, project];
    set({ projects });
    saveToLocalStorage(projects);
    return id;
  },

  addConversation: (projectId, title) => {
    const id = genId('conv');
    const now = Date.now();
    const conv: Conversation = {
      id,
      title: title || '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const projects = get().projects.map((p) =>
      p.id === projectId
        ? { ...p, conversations: [...p.conversations, conv], expanded: true }
        : p,
    );
    set({ projects, currentProjectId: projectId, currentConversationId: id });
    saveToLocalStorage(projects);
    return id;
  },

  createConversationWithFirstMessage: (projectId, firstMessage) => {
    const id = genId('conv');
    const now = Date.now();
    // 用第一条消息前 30 字作为对话标题
    const titleText = firstMessage.content?.trim() || '新对话';
    const title = titleText.length > 30 ? titleText.slice(0, 30) + '…' : titleText;
    const conv: Conversation = {
      id,
      title,
      messages: [firstMessage],
      createdAt: now,
      updatedAt: now,
    };
    const projects = get().projects.map((p) =>
      p.id === projectId
        ? { ...p, conversations: [...p.conversations, conv], expanded: true }
        : p,
    );
    set({ projects, currentProjectId: projectId, currentConversationId: id });
    saveToLocalStorage(projects);
    return id;
  },

  forkConversationFromMessage: (sourceProjectId, sourceConvId, upToMessageId, targetProjectId) => {
    const state = get();
    const sourceProject = state.projects.find((p) => p.id === sourceProjectId);
    const sourceConv = sourceProject?.conversations.find((c) => c.id === sourceConvId);
    if (!sourceConv || !sourceProject) return '';
    // 找到截断点：包含 upToMessageId 及之前的所有消息
    const upToIndex = sourceConv.messages.findIndex((m) => m.id === upToMessageId);
    if (upToIndex < 0) return '';
    const copiedMessages = sourceConv.messages.slice(0, upToIndex + 1);
    // 深拷贝消息并重新生成 ID，避免分支与原对话消息 ID 冲突
    const forkedMessages: ChatMessage[] = copiedMessages.map((m) => ({
      ...m,
      id: `${m.role[0]}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      isStreaming: false,
    }));
    // 目标项目：未传则用源项目
    const destProjectId = targetProjectId ?? sourceProjectId;
    const id = genId('conv');
    const now = Date.now();
    // 用最后一条用户消息前 30 字作为标题
    const lastUserMsg = [...forkedMessages].reverse().find((m) => m.role === 'user');
    const titleText = lastUserMsg?.content?.trim() || sourceConv.title;
    const title = (titleText.length > 30 ? titleText.slice(0, 30) + '…' : titleText) + ' (分支)';
    const conv: Conversation = {
      id,
      title,
      messages: forkedMessages,
      createdAt: now,
      updatedAt: now,
    };
    const projects = get().projects.map((p) =>
      p.id === destProjectId
        ? { ...p, conversations: [...p.conversations, conv], expanded: true }
        : p,
    );
    set({ projects, currentProjectId: destProjectId, currentConversationId: id });
    saveToLocalStorage(projects);
    return id;
  },

  renameConversation: (projectId, convId, title) => {
    const projects = get().projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            conversations: p.conversations.map((c) =>
              c.id === convId ? { ...c, title } : c,
            ),
          }
        : p,
    );
    set({ projects });
    saveToLocalStorage(projects);
  },

  archiveConversation: (projectId, convId) => {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    const conv = project?.conversations.find((c) => c.id === convId);
    if (!conv || !project) return;
    // 移到归档列表
    const archived: ArchivedConversation = {
      id: conv.id,
      title: conv.title,
      messages: conv.messages,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      projectId: project.id,
      projectName: project.name,
      archivedAt: Date.now(),
    };
    const projects = state.projects.map((p) =>
      p.id === projectId
        ? { ...p, conversations: p.conversations.filter((c) => c.id !== convId) }
        : p,
    );
    const archivedConversations = [...state.archivedConversations, archived];
    const currentConversationId =
      state.currentConversationId === convId ? null : state.currentConversationId;
    set({ projects, archivedConversations, currentConversationId });
    saveToLocalStorage(projects);
    saveArchivedToLocalStorage(archivedConversations);
  },

  deleteConversation: (projectId, convId) => {
    const state = get();
    const projects = state.projects.map((p) =>
      p.id === projectId
        ? { ...p, conversations: p.conversations.filter((c) => c.id !== convId) }
        : p,
    );
    const currentConversationId =
      state.currentConversationId === convId ? null : state.currentConversationId;
    set({ projects, currentConversationId });
    saveToLocalStorage(projects);
  },

  hasEmptyConversation: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return false;
    return project.conversations.some((c) => c.messages.length === 0);
  },

  restoreConversation: (archivedId) => {
    const state = get();
    const archived = state.archivedConversations.find((a) => a.id === archivedId);
    if (!archived) return;
    // 还原到原项目（若项目已被删除，则不还原，用户需先创建同名项目）
    const project = state.projects.find((p) => p.id === archived.projectId);
    if (!project) return;
    const restoredConv: Conversation = {
      id: archived.id,
      title: archived.title,
      messages: archived.messages,
      createdAt: archived.createdAt,
      updatedAt: archived.updatedAt,
    };
    const projects = state.projects.map((p) =>
      p.id === archived.projectId
        ? { ...p, conversations: [...p.conversations, restoredConv], expanded: true }
        : p,
    );
    const archivedConversations = state.archivedConversations.filter((a) => a.id !== archivedId);
    set({ projects, archivedConversations });
    saveToLocalStorage(projects);
    saveArchivedToLocalStorage(archivedConversations);
  },

  deleteArchivedConversation: (archivedId) => {
    const state = get();
    const archivedConversations = state.archivedConversations.filter((a) => a.id !== archivedId);
    set({ archivedConversations });
    saveArchivedToLocalStorage(archivedConversations);
  },

  reorderConversations: (projectId, fromIndex, toIndex) => {
    const projects = get().projects.map((p) => {
      if (p.id !== projectId) return p;
      const convs = [...p.conversations];
      if (fromIndex < 0 || fromIndex >= convs.length) return p;
      if (toIndex < 0 || toIndex >= convs.length) return p;
      const [moved] = convs.splice(fromIndex, 1);
      convs.splice(toIndex, 0, moved);
      return { ...p, conversations: convs };
    });
    set({ projects });
    saveToLocalStorage(projects);
  },

  selectConversation: (projectId, convId) => {
    set({ currentProjectId: projectId, currentConversationId: convId });
  },

  setMessages: (projectId, convId, messages) => {
    const projects = get().projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            conversations: p.conversations.map((c) =>
              c.id === convId ? { ...c, messages, updatedAt: Date.now() } : c,
            ),
          }
        : p,
    );
    set({ projects });
    saveToLocalStorage(projects);
  },

  getMessages: (projectId, convId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return [];
    const conv = project.conversations.find((c) => c.id === convId);
    return conv?.messages ?? [];
  },

  loadFromStorage: () => {
    const projects = loadFromLocalStorage();
    const archivedConversations = loadArchivedFromLocalStorage();
    // 若没有任何项目，自动创建一个默认项目 + 对话
    if (projects.length === 0) {
      const now = Date.now();
      const defaultConv: Conversation = {
        id: genId('conv'),
        title: '新对话',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      const defaultProject: Project = {
        id: genId('proj'),
        name: '默认项目',
        conversations: [defaultConv],
        expanded: true,
        createdAt: now,
      };
      set({
        projects: [defaultProject],
        archivedConversations,
        currentProjectId: defaultProject.id,
        currentConversationId: defaultConv.id,
      });
      saveToLocalStorage([defaultProject]);
    } else {
      // 恢复上次选中的对话，若无则选第一个项目的第一个对话
      const firstProj = projects[0];
      const firstConv = firstProj?.conversations[0];
      set({
        projects,
        archivedConversations,
        currentProjectId: firstProj?.id ?? null,
        currentConversationId: firstConv?.id ?? null,
      });
    }
  },

  saveToStorage: () => {
    saveToLocalStorage(get().projects);
  },
}));
