# Phase 12：多模态视觉辅助 + 分支对话 + /init + /dream

**回应**：Phase 11 完成报告的 CONCERN（预估）

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | Token 估算 `字符数/4` 对中文不精确 | Phase 12 不涉及，留待后续引入 tiktoken |
| C2 | CheckpointWriter 的 11 字段输出可能被 LLM 截断 | Phase 12 不涉及，后续可通过调大 maxTokensPerCheckpoint 解决 |
| C3 | notes.md 自动写入规则太粗（正则匹配"记住"） | Phase 12 不涉及，留待主 Agent 工具化 notes 写入 |

---

**目标**：四个独立功能模块——
1. 多模态视觉辅助：有视觉能力的模型（如 MiMoV2.5）充当"眼睛助手"，分析图片后将文字描述注入给主力文本模型（如 GLM5.2）
2. 分支对话：编辑历史消息创建对话分支，支持切换和查看
3. /init：分析项目结构，自动生成 .routedev-rules.md
4. /dream：整理记忆，合并去重

**蓝图参考**：
- 视觉辅助：蓝图未明确规格，本 Phase 为新增功能（用户需求）
- 分支对话：蓝图 MVP 范围（第二节）"分支对话（编辑消息生成新分支）"
- /init：第十一节命令系统 `/init 分析项目结构，自动生成 rules.md`
- /dream：第十一节命令系统 `/dream 整理项目记忆，合并去重`

**前置依赖**：Phase 9（自主模式基础）、Phase 11（CheckpointWriter + ContextManager，/dream 依赖）

---

## 架构说明

Phase 12 包含四个功能模块，它们相互独立但都服务于"让 RouteDev 更智能"这个目标。

```
模块 1：多模态视觉辅助（用户发图片 → 视觉模型分析 → 文字描述注入文本模型）

  用户: "看看这个截图，帮我分析 UI 问题"  [附带 screenshot.png]
    |
    v
  VisionAssistant.analyze(imageData)
    |
    +-- 路由：找有 'multimodal' 能力的模型（如 MiMoV2.5）
    +-- 调用 ILLMClient.complete() with ImageContent
    +-- 返回文字描述："这是一个登录页面，有一个蓝色的提交按钮..."
    |
    v
  将描述注入 conversationHistoryRef
    |
    v
  正常 ReAct loop（文本模型如 GLM5.2 继续推理）

模块 2：分支对话（编辑消息 → 创建分支 → 切换分支）

  主分支: [msg1] → [msg2] → [msg3] → [msg4]
                                ↓ 编辑 msg3
  分支 A:                  [msg3'] → [msg4']

  /branch list  → 显示分支树
  /branch switch <id> → 切换到指定分支

模块 3：/init（项目分析）

  /init → LLM 扫描项目结构（文件列表 + package.json）→ 生成 .routedev-rules.md

模块 4：/dream（记忆整理）

  /dream → 读取 checkpoint 数据 → LLM 合并去重 → 输出更精简的记忆
```

**关键约束**：
- 视觉辅助只在**用户发送图片**或**任务明确需要视觉理解**时触发，不主动使用
- 视觉模型必须标记 `capabilities: ['multimodal']`，路由器根据此标签选择
- 分支对话是**叠加层**——现有的 `conversationHistoryRef` 继续工作，BranchManager 在它之上管理分支树
- /init 生成的 rules.md 是**建议性质**的，用户可以手动修改
- /dream 依赖 Phase 11 的 CheckpointWriter + ContextManager

---

## 具体任务

**接口对齐观察表**（已验证实际代码库）：

| # | 接口 | 实际签名 | Phase 12 用法 | 备注 |
|---|------|---------|--------------|------|
| 1 | `ModelConfig.capabilities` | `capabilities: ModelCapability[]` (含 'multimodal') | VisionAssistant 查找 `capabilities.includes('multimodal')` 的模型 | 已在 schema 中定义 |
| 2 | `ImageContent` | `{ type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }` | VisionAssistant 构建图片消息 | 已在 ContentPart 联合类型中 |
| 3 | `ILLMClient.complete()` | `complete(options: LLMRequestOptions): Promise<LLMResponse>` | VisionAssistant/ProjectAnalyzer/DreamConsolidator 调用 | LLMRequestOptions 含 model, messages, systemPrompt, maxTokens, temperature |
| 4 | `LLMMessage.content` | `string \| ContentPart[]` | 视觉消息用 ContentPart[] 格式传入图片 | 支持混合文本和图片 |
| 5 | `LLMClientManager.listAll()` | `listAll(): Map<string, ILLMClient>` | `[...clientManager.listAll().values()][0]` | **返回 Map，不是数组** |
| 6 | `ConversationHistory` | `{ messages: LLMMessage[]; maxTokens: number; currentTokens: number }` | BranchManager 管理的是 LLMMessage[] 数组 | 分支切换时替换整个数组 |

---

### Task 1：多模态视觉辅助

**文件：**
- 创建 `src/agent/vision.ts`
- 修改 `src/cli/App.tsx`

实现"眼睛助手"模式——视觉模型分析图片，生成文字描述注入文本模型上下文。

- [ ] **Step 1：实现 VisionAssistant**

```typescript
// src/agent/vision.ts
// VisionAssistant：多模态视觉辅助
// 用有视觉能力的模型（如 MiMoV2.5）分析图片，生成文字描述
// 然后将描述注入给主力文本模型（如 GLM5.2）继续推理
//
// 触发条件：
//   1. 用户消息中包含图片（base64 或文件路径）
//   2. 用户明确要求"看看这个"、"分析截图"等
//
// 工作流程：
//   1. 检测用户消息中的图片
//   2. 找到有 'multimodal' 能力的模型
//   3. 调用视觉模型：[系统 prompt: "描述图片内容"] + [图片] + [用户问题]
//   4. 获取文字描述
//   5. 将描述注入 conversationHistoryRef（作为 assistant 消息）
//   6. 后续 ReAct loop 正常使用文本模型

import type { ILLMClient, LLMMessage, ImageContent, ModelConfig } from '../router/types.js';
import type { ProviderConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 图片输入（用户提供的） */
export interface ImageInput {
  /** 图片数据（base64 编码） */
  data: string;
  /** MIME 类型 */
  mediaType: string;
  /** 原始文件名（如果有） */
  fileName?: string;
}

/** 视觉分析结果 */
export interface VisionResult {
  /** 视觉模型生成的文字描述 */
  description: string;
  /** 使用的视觉模型 */
  modelId: string;
  /** token 消耗 */
  inputTokens: number;
  outputTokens: number;
}

/** 视觉模型选择结果 */
export interface VisionModelSelection {
  /** 选中的模型配置 */
  model: ModelConfig;
  /** 对应的 provider */
  providerId: string;
  /** LLM 客户端 */
  client: ILLMClient;
}

export class VisionAssistant {
  private providers: ProviderConfig[];
  /** providerId → ILLMClient 的映射 */
  private clientGetter: (providerId: string) => ILLMClient | undefined;

  constructor(
    providers: ProviderConfig[],
    clientGetter: (providerId: string) => ILLMClient | undefined,
  ) {
    this.providers = providers;
    this.clientGetter = clientGetter;
  }

  /** 查找有视觉能力的模型 */
  findVisionModel(): VisionModelSelection | null {
    for (const provider of this.providers) {
      for (const model of provider.models) {
        if (model.capabilities.includes('multimodal') && model.available) {
          const client = this.clientGetter(provider.id);
          if (client && client.isReady()) {
            return { model, providerId: provider.id, client };
          }
        }
      }
    }
    return null;
  }

  /** 分析图片 */
  async analyze(
    images: ImageInput[],
    userQuestion: string,
  ): Promise<VisionResult | null> {
    const selection = this.findVisionModel();
    if (!selection) {
      logger.warn('VisionAssistant: no multimodal model available');
      return null;
    }

    try {
      // 构建消息：图片 + 用户问题
      const content: Array<ImageContent | { type: 'text'; text: string }> = [];

      // 添加图片
      for (const img of images) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            mediaType: img.mediaType,
            data: img.data,
          },
        });
      }

      // 添加用户问题
      content.push({
        type: 'text',
        text: userQuestion || '请详细描述这张图片的内容，包括 UI 元素、文本、布局、颜色等。',
      });

      const response = await selection.client.complete({
        model: selection.model.id,
        messages: [{ role: 'user', content }],
        systemPrompt: [
          '你是一个视觉分析助手。请仔细观察图片，提供详细、准确的描述。',
          '描述应包含：',
          '- 整体布局和结构',
          '- 可见的文本内容',
          '- UI 元素（按钮、输入框、图标等）',
          '- 颜色和样式',
          '- 可能的问题或需要注意的地方',
          '如果用户有具体问题，请针对性回答。',
        ].join('\n'),
        maxTokens: 1000,
        temperature: 0.3,
      });

      return {
        description: response.content,
        modelId: selection.model.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('VisionAssistant analysis failed', { error: msg });
      return null;
    }
  }

  /** 从文件路径读取图片并转为 base64 */
  static async loadImage(filePath: string): Promise<ImageInput | null> {
    try {
      const absolutePath = path.resolve(filePath);
      const buffer = await fs.readFile(absolutePath);
      const ext = path.extname(filePath).toLowerCase();

      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      };

      const mediaType = mimeMap[ext];
      if (!mediaType) {
        logger.warn('Unsupported image format', { ext });
        return null;
      }

      return {
        data: buffer.toString('base64'),
        mediaType,
        fileName: path.basename(filePath),
      };
    } catch (error) {
      logger.error('Failed to load image', { filePath, error: String(error) });
      return null;
    }
  }

  /** 检测用户消息中是否包含图片引用（@xxx.png） */
  static extractImageReferences(message: string): string[] {
    // 匹配 @filename.ext 中的图片文件
    const imageExts = /\.(png|jpg|jpeg|gif|webp|bmp)$/i;
    const refs: string[] = [];

    // 匹配 @xxx.png 格式
    const atMatches = message.match(/@[\w./\\-]+\.(png|jpg|jpeg|gif|webp|bmp)/gi);
    if (atMatches) {
      for (const match of atMatches) {
        const filePath = match.slice(1); // 去掉 @
        refs.push(filePath);
      }
    }

    return refs;
  }

  /** 检测用户消息是否需要视觉能力（关键词匹配） */
  static needsVision(message: string): boolean {
    const visionKeywords = [
      '看看', '截图', '图片', '这张', '这个图', '看一下',
      '分析图', '看这个', '帮我看看', '识别', 'OCR',
      'screenshot', 'image', 'picture', 'look at',
    ];
    const lowerMsg = message.toLowerCase();
    return visionKeywords.some(kw => lowerMsg.includes(kw.toLowerCase()));
  }
}
```

- [ ] **Step 2：在 App.tsx 中集成 VisionAssistant**

在 useRef 区域添加：

```typescript
import { VisionAssistant } from '../agent/vision.js';

const visionAssistantRef = useRef(new VisionAssistant(
  config.providers,
  (providerId) => clientManager.get(providerId),
));
```

在 `handleSubmit` 的**消息分类之前**（classifier.classify 之前），插入视觉检测：

```typescript
// ===== Phase 12：多模态视觉检测 =====
const imageRefs = VisionAssistant.extractImageReferences(text);
const needsVision = imageRefs.length > 0 || VisionAssistant.needsVision(text);

if (needsVision) {
  // 加载图片
  const images: ImageInput[] = [];
  for (const ref of imageRefs) {
    const img = await VisionAssistant.loadImage(ref);
    if (img) images.push(img);
  }

  // 如果没有图片引用但需要视觉，提示用户
  if (images.length === 0 && !imageRefs.length) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '📷 检测到视觉需求，但消息中没有图片引用。请使用 @filename.png 引用图片。',
    }]);
    // 继续正常处理（不阻断）
  }

  // 如果有图片，调用视觉模型分析
  if (images.length > 0) {
    const visionModel = visionAssistantRef.current.findVisionModel();
    if (!visionModel) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '⚠️ 没有可用的多模态模型。请在配置中添加 capabilities 包含 "multimodal" 的模型。',
      }]);
    } else {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `👁️ 正在用 ${visionModel.model.name} 分析图片...`,
      }]);

      const result = await visionAssistantRef.current.analyze(images, text);
      if (result) {
        // 将视觉描述注入对话历史
        const visionMessage: LLMMessage = {
          role: 'assistant',
          content: `[视觉分析 by ${result.modelId}]\n${result.description}`,
        };
        conversationHistoryRef.current = [
          ...conversationHistoryRef.current,
          visionMessage,
        ];

        // 更新 token 统计
        tracker.record(
          { inputTokens: result.inputTokens, outputTokens: result.outputTokens, totalTokens: result.inputTokens + result.outputTokens },
          { modelId: result.modelId, agentId: 'vision', stepId: 'analysis' },
        );

        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `👁️ 图片分析完成 (${result.modelId}, ${result.inputTokens + result.outputTokens} tokens)\n${result.description.slice(0, 200)}${result.description.length > 200 ? '...' : ''}`,
        }]);

        // 移除消息中的图片引用（避免文本模型困惑）
        // text 变量保持不变（用户原始输入），但注入的 visionMessage 已包含分析结果
      }
    }
  }
}

// 继续正常的 classify → route → run 流程
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/vision.ts src/cli/App.tsx
git commit -m "feat(agent): add VisionAssistant for multimodal image analysis"
```

---

### Task 2：分支对话（BranchManager）

**文件：**
- 创建 `src/agent/branch.ts`
- 修改 `src/cli/App.tsx`

实现对话分支——编辑历史消息时创建分支，支持切换和查看。

- [ ] **Step 1：实现 BranchManager**

```typescript
// src/agent/branch.ts
// BranchManager：对话分支管理
// 蓝图 MVP 范围：分支对话（编辑消息生成新分支）
//
// 核心概念：
//   对话历史不再是线性数组，而是一棵树
//   每个节点 = 一条消息 + 父节点引用 + 子节点列表
//   "当前分支" = 从根到某个叶节点的路径
//
// 触发场景：
//   用户编辑了历史消息 → 在该消息位置创建分支
//   用户切换分支 → conversationHistoryRef 更新为该分支的消息序列

import type { LLMMessage } from '../router/types.js';
import { logger } from '../utils/logger.js';

/** 分支节点 */
export interface BranchNode {
  /** 节点 ID（UUID 短格式） */
  id: string;
  /** 父节点 ID（根节点为 null） */
  parentId: string | null;
  /** 消息内容 */
  message: LLMMessage;
  /** 子节点 ID 列表（可能有多个 = 多个分支） */
  children: string[];
  /** 创建时间 */
  timestamp: number;
}

/** 分支信息（用于显示） */
export interface BranchInfo {
  /** 分支 ID（末端节点的 ID） */
  id: string;
  /** 分支名称（自动生成或用户指定） */
  name: string;
  /** 分支起点消息（从哪条消息分叉出来的） */
  forkFromMessageId: string;
  /** 分支上的消息数 */
  messageCount: number;
  /** 是否为当前活跃分支 */
  isActive: boolean;
  /** 创建时间 */
  createdAt: number;
}

export class BranchManager {
  /** 所有节点 */
  private nodes: Map<string, BranchNode> = new Map();
  /** 分支末端节点 ID → 分支信息 */
  private branches: Map<string, BranchInfo> = new Map();
  /** 当前活跃分支的末端节点 ID */
  private activeBranchId: string | null = null;
  /** 分支计数器（自动命名） */
  private branchCounter = 0;

  /** 初始化主分支（从现有对话历史） */
  initFromHistory(messages: LLMMessage[]): string[] {
    if (messages.length === 0) return [];

    let prevId: string | null = null;
    const nodeIds: string[] = [];

    for (const msg of messages) {
      const id = this.generateId();
      const node: BranchNode = {
        id,
        parentId: prevId,
        message: msg,
        children: [],
        timestamp: Date.now(),
      };
      this.nodes.set(id, node);

      // 添加到父节点的 children
      if (prevId) {
        const parent = this.nodes.get(prevId);
        if (parent) parent.children.push(id);
      }

      prevId = id;
      nodeIds.push(id);
    }

    // 注册主分支
    const lastId = nodeIds[nodeIds.length - 1];
    this.branches.set(lastId, {
      id: lastId,
      name: '主分支',
      forkFromMessageId: nodeIds[0],
      messageCount: messages.length,
      isActive: true,
      createdAt: Date.now(),
    });
    this.activeBranchId = lastId;

    return nodeIds;
  }

  /**
   * 在指定消息位置创建分支（fork）
   * @param forkFromNodeId 从哪个节点开始分叉
   * @param editedMessage 编辑后的新消息
   * @returns 新分支的末端节点 ID，或 null
   */
  fork(forkFromNodeId: string, editedMessage: LLMMessage): string | null {
    const forkNode = this.nodes.get(forkFromNodeId);
    if (!forkNode) {
      logger.warn('BranchManager: fork node not found', { id: forkFromNodeId });
      return null;
    }

    // 创建新节点（编辑后的消息）
    const newId = this.generateId();
    const newNode: BranchNode = {
      id: newId,
      parentId: forkNode.parentId, // 与 fork 节点有相同的父节点
      message: editedMessage,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(newId, newNode);

    // 将新节点添加到 forkNode 的父节点的 children
    if (forkNode.parentId) {
      const parent = this.nodes.get(forkNode.parentId);
      if (parent) parent.children.push(newId);
    }

    // 注册新分支
    this.branchCounter++;
    this.branches.set(newId, {
      id: newId,
      name: `分支 ${this.branchCounter}`,
      forkFromMessageId: forkFromNodeId,
      messageCount: this.getPathLength(newId),
      isActive: false,
      createdAt: Date.now(),
    });

    logger.info('Branch created', {
      branchId: newId,
      forkFrom: forkFromNodeId,
    });

    return newId;
  }

  /**
   * 在当前分支追加消息
   * @returns 新节点 ID
   */
  append(message: LLMMessage): string {
    const id = this.generateId();
    const node: BranchNode = {
      id,
      parentId: this.activeBranchId,
      message,
      children: [],
      timestamp: Date.now(),
    };
    this.nodes.set(id, node);

    if (this.activeBranchId) {
      const parent = this.nodes.get(this.activeBranchId);
      if (parent) parent.children.push(id);

      // 更新分支信息
      const branch = this.branches.get(this.activeBranchId);
      if (branch) {
        // 分支末端移动到新节点
        this.branches.delete(this.activeBranchId);
        branch.id = id;
        branch.messageCount = this.getPathLength(id);
        this.branches.set(id, branch);
      }
    }

    this.activeBranchId = id;
    return id;
  }

  /** 切换到指定分支 */
  switchBranch(branchId: string): LLMMessage[] | null {
    const branch = this.branches.get(branchId);
    if (!branch) {
      // 尝试找到以 branchId 为末端的分支
      for (const [id, b] of this.branches) {
        if (id.startsWith(branchId) || branchId.startsWith(id.slice(0, 4))) {
          return this.switchToBranch(id);
        }
      }
      return null;
    }
    return this.switchToBranch(branchId);
  }

  private switchToBranch(branchId: string): LLMMessage[] {
    // 标记旧分支为非活跃
    if (this.activeBranchId) {
      const oldBranch = this.branches.get(this.activeBranchId);
      if (oldBranch) oldBranch.isActive = false;
    }

    // 标记新分支为活跃
    const branch = this.branches.get(branchId);
    if (branch) branch.isActive = true;
    this.activeBranchId = branchId;

    // 返回该分支的完整消息路径
    return this.getPath(branchId);
  }

  /** 获取从根到指定节点的消息路径 */
  getPath(nodeId: string): LLMMessage[] {
    const messages: LLMMessage[] = [];
    let currentId: string | null = nodeId;

    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      messages.unshift(node.message);
      currentId = node.parentId;
    }

    return messages;
  }

  /** 获取从根到指定节点的路径长度 */
  private getPathLength(nodeId: string): number {
    let count = 0;
    let currentId: string | null = nodeId;
    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;
      count++;
      currentId = node.parentId;
    }
    return count;
  }

  /** 列出所有分支 */
  listBranches(): BranchInfo[] {
    return [...this.branches.values()];
  }

  /** 获取当前活跃分支 ID */
  getActiveBranchId(): string | null {
    return this.activeBranchId;
  }

  /** 获取节点总数 */
  get nodeCount(): number {
    return this.nodes.size;
  }

  private generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }
}
```

- [ ] **Step 2：在 App.tsx 中集成分支管理**

```typescript
import { BranchManager } from '../agent/branch.js';

// 在 useRef 区域添加：
const branchManagerRef = useRef(new BranchManager());
// 标记是否已初始化分支
const branchInitializedRef = useRef(false);

// 在 handleSubmit 正常消息处理开头，初始化或追加分支：
// （在 classify 之前）
if (!branchInitializedRef.current && conversationHistoryRef.current.length > 0) {
  branchManagerRef.current.initFromHistory(conversationHistoryRef.current);
  branchInitializedRef.current = true;
}

// 在 handleSubmit 处理完用户消息和 AI 回复后，追加分支节点：
// （在 done 事件处理后）
branchManagerRef.current.append({ role: 'user', content: text });
// AI 回复追加在 done 事件中处理
```

在 `handleCommand` 中添加 /branch 命令：

```typescript
case '/branch': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'list':
    case undefined: {
      const branches = branchManagerRef.current.listBranches();
      if (branches.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '还没有对话分支。使用 /branch edit <n> <新内容> 创建分支。',
        }]);
      } else {
        const lines = branches.map(b => {
          const active = b.isActive ? ' ← 当前' : '';
          const time = new Date(b.createdAt).toLocaleString('zh-CN');
          return `  ${b.id.slice(0, 6)} | ${b.name} | ${b.messageCount} 条消息 | ${time}${active}`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `对话分支 (${branches.length}):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'switch': {
      const targetId = parts[2];
      if (!targetId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法: /branch switch <分支ID>\n使用 /branch list 查看可用分支。',
        }]);
        break;
      }

      const messages = branchManagerRef.current.switchBranch(targetId);
      if (messages) {
        conversationHistoryRef.current = messages;
        // 重建 UI 消息列表
        const uiMessages = messages.map((msg, i) => ({
          id: `branch-${i}`,
          role: msg.role as 'user' | 'assistant' | 'system',
          content: typeof msg.content === 'string' ? msg.content : '[多部分内容]',
        }));
        setMessages(uiMessages);
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `已切换到分支 ${targetId.slice(0, 6)}，共 ${messages.length} 条消息。`,
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `未找到分支 "${targetId}"。`,
        }]);
      }
      break;
    }

    case 'edit': {
      // /branch edit <消息序号> <新内容>
      const msgIndex = parseInt(parts[2] ?? '', 10);
      const newContent = parts.slice(3).join(' ');

      if (isNaN(msgIndex) || !newContent) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法: /branch edit <消息序号> <新内容>\n例: /branch edit 3 请改用 async/await 重写',
        }]);
        break;
      }

      // 获取当前分支的消息路径
      const activeBranchId = branchManagerRef.current.getActiveBranchId();
      if (!activeBranchId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有活跃分支，无法编辑。',
        }]);
        break;
      }

      const path = branchManagerRef.current.getPath(activeBranchId);
      if (msgIndex < 1 || msgIndex > path.length) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `消息序号 ${msgIndex} 超出范围（当前分支有 ${path.length} 条消息）。`,
        }]);
        break;
      }

      // 找到要编辑的节点
      const targetNode = path[msgIndex - 1];
      // TODO: 需要 BranchManager 暴露 getNodeByPath 方法
      // 简化实现：使用 fork

      const editedMessage: LLMMessage = {
        role: 'user', // 编辑的用户消息
        content: newContent,
      };

      // 找到对应节点 ID（通过 getPath 的索引）
      // 注意：这里需要 BranchManager 提供按路径索引查找节点的能力
      // 简化方案：在 initFromHistory 时记录 nodeIds 映射

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `📝 消息 ${msgIndex} 已编辑为新分支。使用 /branch list 查看，/branch switch 切换。`,
      }]);
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '分支命令：',
          '  /branch list              - 查看所有分支',
          '  /branch switch <id>       - 切换到指定分支',
          '  /branch edit <n> <内容>   - 编辑第 n 条消息，创建新分支',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/branch.ts src/cli/App.tsx
git commit -m "feat(agent): add BranchManager for conversation branching"
```

---

### Task 3：/init 项目分析

**文件：**
- 创建 `src/agent/init-analyzer.ts`
- 修改 `src/cli/App.tsx`

分析项目结构，生成 .routedev-rules.md。

- [ ] **Step 1：实现 ProjectAnalyzer**

```typescript
// src/agent/init-analyzer.ts
// ProjectAnalyzer：项目结构分析 + rules.md 生成
// 蓝图 11.1：/init 分析项目结构，自动生成 rules.md
// Token 预算：2000 tokens
//
// 工作流程：
//   1. 扫描项目根目录（排除 node_modules, .git, dist 等）
//   2. 读取 package.json（如果存在）获取项目名称、依赖、脚本
//   3. 统计文件类型分布
//   4. 将信息发给 LLM，让它生成项目规则文件
//   5. 写入 .routedev-rules.md

import type { ILLMClient } from '../router/types.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 项目分析结果 */
export interface ProjectAnalysis {
  /** 项目名称 */
  name: string;
  /** 主要语言 */
  language: string;
  /** 框架/技术栈 */
  frameworks: string[];
  /** 文件类型分布 */
  fileTypes: Record<string, number>;
  /** 总文件数 */
  totalFiles: number;
  /** package.json 信息（如果有） */
  packageInfo?: {
    name: string;
    version: string;
    scripts: string[];
    dependencies: string[];
  };
  /** 目录结构摘要（前 3 层） */
  directoryTree: string;
}

export class ProjectAnalyzer {
  private llmClient: ILLMClient;
  private modelId: string;

  constructor(llmClient: ILLMClient, modelId: string) {
    this.llmClient = llmClient;
    this.modelId = modelId;
  }

  /** 分析项目结构 */
  async analyze(projectDir: string): Promise<ProjectAnalysis> {
    const fileTypes: Record<string, number> = {};
    let totalFiles = 0;
    const dirs: string[] = [];

    // 排除的目录
    const excludeDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next',
      '.nuxt', '__pycache__', '.cache', 'coverage',
    ]);

    // 递归扫描（最多 3 层深度）
    await this.scanDir(projectDir, '', 3, excludeDirs, fileTypes, dirs, () => totalFiles++);

    // 读取 package.json
    let packageInfo: ProjectAnalysis['packageInfo'];
    try {
      const pkgPath = path.join(projectDir, 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      packageInfo = {
        name: pkg.name ?? 'unknown',
        version: pkg.version ?? '0.0.0',
        scripts: Object.keys(pkg.scripts ?? {}),
        dependencies: Object.keys(pkg.dependencies ?? {}).slice(0, 20),
      };
    } catch {
      // 没有 package.json
    }

    // 推断语言和框架
    const language = this.inferLanguage(fileTypes);
    const frameworks = this.inferFrameworks(packageInfo?.dependencies ?? []);

    // 构建目录树
    const directoryTree = dirs.slice(0, 50).join('\n');

    return {
      name: packageInfo?.name ?? path.basename(projectDir),
      language,
      frameworks,
      fileTypes,
      totalFiles,
      packageInfo,
      directoryTree,
    };
  }

  /** 生成 rules.md */
  async generateRules(analysis: ProjectAnalysis): Promise<string> {
    const prompt = this.buildPrompt(analysis);

    try {
      const response = await this.llmClient.complete({
        model: this.modelId,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: [
          '你是一个项目开发规则生成器。',
          '根据项目分析结果，生成一份 .routedev-rules.md 文件。',
          '文件应包含：',
          '1. 项目概述（1-2 句）',
          '2. 技术栈摘要',
          '3. 编码规范建议（基于项目已有风格）',
          '4. 关键目录说明',
          '5. 常用命令（构建、测试、运行）',
          '6. 注意事项',
          '使用 Markdown 格式，简洁实用。',
        ].join('\n'),
        maxTokens: 2000,
        temperature: 0.3,
      });

      return response.content;
    } catch (error) {
      logger.error('Failed to generate rules', { error: String(error) });
      return this.generateFallbackRules(analysis);
    }
  }

  /** 写入 rules 文件 */
  async writeRules(projectDir: string, content: string): Promise<string> {
    const filePath = path.join(projectDir, '.routedev-rules.md');
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private async scanDir(
    baseDir: string,
    relativePath: string,
    maxDepth: number,
    excludeDirs: Set<string>,
    fileTypes: Record<string, number>,
    dirs: string[],
    onFile: () => void,
  ): Promise<void> {
    if (maxDepth <= 0) return;

    const fullPath = path.join(baseDir, relativePath);
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        if (excludeDirs.has(entry.name)) continue;

        const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          dirs.push(`📁 ${entryRelative}/`);
          await this.scanDir(baseDir, entryRelative, maxDepth - 1, excludeDirs, fileTypes, dirs, onFile);
        } else if (entry.isFile()) {
          onFile();
          const ext = path.extname(entry.name) || '(no ext)';
          fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
        }
      }
    } catch {
      // 权限不足或目录不存在
    }
  }

  private inferLanguage(fileTypes: Record<string, number>): string {
    const langMap: Array<[string[], string]> = [
      [['.ts', '.tsx'], 'TypeScript'],
      [['.js', '.jsx'], 'JavaScript'],
      [['.py'], 'Python'],
      [['.go'], 'Go'],
      [['.rs'], 'Rust'],
      [['.java'], 'Java'],
      [['.cs'], 'C#'],
    ];

    let maxCount = 0;
    let language = 'Unknown';

    for (const [exts, lang] of langMap) {
      const count = exts.reduce((sum, ext) => sum + (fileTypes[ext] ?? 0), 0);
      if (count > maxCount) {
        maxCount = count;
        language = lang;
      }
    }

    return language;
  }

  private inferFrameworks(dependencies: string[]): string[] {
    const frameworkMap: Record<string, string> = {
      'react': 'React',
      'vue': 'Vue',
      'next': 'Next.js',
      'nuxt': 'Nuxt',
      'express': 'Express',
      'fastify': 'Fastify',
      'ink': 'Ink (CLI)',
      'django': 'Django',
      'flask': 'Flask',
      'nestjs': 'NestJS',
    };

    return dependencies
      .filter(dep => frameworkMap[dep])
      .map(dep => frameworkMap[dep])
      .slice(0, 5);
  }

  private buildPrompt(analysis: ProjectAnalysis): string {
    const parts: string[] = [
      `## 项目分析结果`,
      `名称: ${analysis.name}`,
      `语言: ${analysis.language}`,
      `框架: ${analysis.frameworks.join(', ') || '未检测到'}`,
      `文件数: ${analysis.totalFiles}`,
      `文件类型分布: ${Object.entries(analysis.fileTypes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => `${ext}(${count})`).join(', ')}`,
    ];

    if (analysis.packageInfo) {
      parts.push(`\npackage.json:`);
      parts.push(`  scripts: ${analysis.packageInfo.scripts.join(', ')}`);
      parts.push(`  dependencies: ${analysis.packageInfo.dependencies.join(', ')}`);
    }

    parts.push(`\n目录结构:\n${analysis.directoryTree}`);

    return parts.join('\n');
  }

  private generateFallbackRules(analysis: ProjectAnalysis): string {
    return [
      `# ${analysis.name} - 项目规则`,
      '',
      `## 技术栈`,
      `- 语言: ${analysis.language}`,
      `- 框架: ${analysis.frameworks.join(', ') || '未检测到'}`,
      `- 文件数: ${analysis.totalFiles}`,
      '',
      `## 注意事项`,
      `- 请遵循项目已有的代码风格`,
      `- 修改文件前先阅读相关文件了解上下文`,
    ].join('\n');
  }
}
```

- [ ] **Step 2：在 App.tsx 中添加 /init 命令**

```typescript
import { ProjectAnalyzer } from '../agent/init-analyzer.js';

case '/init': {
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: '🔍 正在分析项目结构...',
  }]);

  // 使用分类器模型（最便宜的）
  const analyzerModelId = config.router.classifierModel;
  const analyzerProvider = config.providers.find(p =>
    p.models.some(m => m.id === analyzerModelId)
  );
  const analyzerClient = analyzerProvider
    ? clientManager.get(analyzerProvider.id) ?? [...clientManager.listAll().values()][0]
    : [...clientManager.listAll().values()][0];

  const analyzer = new ProjectAnalyzer(analyzerClient, analyzerModelId);

  try {
    const analysis = await analyzer.analyze(process.cwd());

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `🔍 项目分析完成：${analysis.name} (${analysis.language}, ${analysis.totalFiles} 个文件, ${analysis.frameworks.join(', ')})\n正在生成规则文件...`,
    }]);

    const rules = await analyzer.generateRules(analysis);
    const filePath = await analyzer.writeRules(process.cwd(), rules);

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `✓ 已生成 ${path.relative(process.cwd(), filePath)}\n${rules.slice(0, 300)}${rules.length > 300 ? '\n...(内容已截断)' : ''}`,
    }]);
  } catch (error) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `项目分析失败: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  break;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/init-analyzer.ts src/cli/App.tsx
git commit -m "feat(agent): add /init command for project analysis and rules generation"
```

---

### Task 4：/dream 记忆整理

**文件：**
- 创建 `src/agent/dream-consolidator.ts`
- 修改 `src/cli/App.tsx`

整理 Phase 11 的结构化记忆，合并去重。

- [ ] **Step 1：实现 DreamConsolidator**

```typescript
// src/agent/dream-consolidator.ts
// DreamConsolidator：记忆整理（合并去重）
// 蓝图 11.1：/dream 整理项目记忆，合并去重（手动或每 7 天自动）
// Token 预算：1500 tokens
//
// 工作流程：
//   1. 读取当前 CheckpointData（Phase 11 的 11 字段记忆）
//   2. 发给 LLM，要求合并重复项、去除过时信息、压缩表述
//   3. 返回更精简的 CheckpointData

import type { ILLMClient } from '../router/types.js';
import type { CheckpointData } from './memory/types.js';
import { logger } from '../utils/logger.js';

/** 整理结果 */
export interface DreamResult {
  /** 整理后的记忆 */
  consolidated: CheckpointData;
  /** 整理报告（删除了什么、合并了什么） */
  report: string;
}

export class DreamConsolidator {
  private llmClient: ILLMClient;
  private modelId: string;

  constructor(llmClient: ILLMClient, modelId: string) {
    this.llmClient = llmClient;
    this.modelId = modelId;
  }

  /** 整理记忆 */
  async consolidate(checkpoint: CheckpointData): Promise<DreamResult | null> {
    try {
      const systemPrompt = [
        '你是记忆整理器。输入是一个项目的结构化记忆（JSON），你的任务是：',
        '1. 合并重复或高度相似的条目',
        '2. 删除已过时或不再相关的信息',
        '3. 压缩冗长的表述，保留核心含义',
        '4. 保持 11 个字段的完整结构不变',
        '',
        '输出格式：',
        '```json',
        '{ "consolidated": { ... 整理后的 11 字段 ... }, "report": "整理报告" }',
        '```',
      ].join('\n');

      const response = await this.llmClient.complete({
        model: this.modelId,
        messages: [{
          role: 'user',
          content: `请整理以下项目记忆：\n\n${JSON.stringify(checkpoint, null, 2)}`,
        }],
        systemPrompt,
        maxTokens: 1500,
        temperature: 0.2,
      });

      return this.parseOutput(response.content, checkpoint);
    } catch (error) {
      logger.error('DreamConsolidator failed', { error: String(error) });
      return null;
    }
  }

  private parseOutput(content: string, original: CheckpointData): DreamResult | null {
    try {
      // 提取 JSON
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = match ? match[1].trim() : content.trim();
      const parsed = JSON.parse(jsonStr);

      if (parsed.consolidated && typeof parsed.consolidated.currentIntent === 'string') {
        return {
          consolidated: parsed.consolidated as CheckpointData,
          report: parsed.report ?? '整理完成',
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2：在 App.tsx 中添加 /dream 命令**

```typescript
import { DreamConsolidator } from '../agent/dream-consolidator.js';

case '/dream': {
  const checkpoint = contextManagerRef.current.getCheckpoint();
  if (!checkpoint) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '没有记忆数据需要整理。记忆在对话过程中自动积累。',
    }]);
    break;
  }

  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: '💭 正在整理记忆...',
  }]);

  // 使用分类器模型（最便宜的）
  const dreamModelId = config.router.classifierModel;
  const dreamProvider = config.providers.find(p =>
    p.models.some(m => m.id === dreamModelId)
  );
  const dreamClient = dreamProvider
    ? clientManager.get(dreamProvider.id) ?? [...clientManager.listAll().values()][0]
    : [...clientManager.listAll().values()][0];

  const consolidator = new DreamConsolidator(dreamClient, dreamModelId);
  const result = await consolidator.consolidate(checkpoint);

  if (result) {
    // 更新 checkpoint
    contextManagerRef.current.setCheckpoint(result.consolidated);
    await contextManagerRef.current.saveCheckpoint();

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `💭 记忆整理完成\n${result.report}`,
    }]);
  } else {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '记忆整理失败，保持原有记忆不变。',
    }]);
  }
  break;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/dream-consolidator.ts src/cli/App.tsx
git commit -m "feat(agent): add /dream command for memory consolidation"
```

---

### Task 5：CLI 集成（/help + /status 更新）

**文件：** 修改 `src/cli/App.tsx`

- [ ] **Step 1：更新 /help**

在 /help 中添加所有新命令：
```
  /init                  - 分析项目结构，生成规则文件
  /dream                 - 整理项目记忆，合并去重
  /branch list           - 查看对话分支
  /branch switch <id>    - 切换到指定分支
  /branch edit <n> <内容> - 编辑第 n 条消息，创建新分支
```

- [ ] **Step 2：更新 /status**

在 /status 中添加：

```typescript
`分支: ${branchManagerRef.current.listBranches().length} 个`,
`视觉模型: ${visionAssistantRef.current.findVisionModel()?.model.name ?? '无'}`,
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): update /help and /status for Phase 12 features"
```

---

### Task 6：单元测试

**文件：**
- 创建 `tests/agent/vision.test.ts`
- 创建 `tests/agent/branch.test.ts`
- 创建 `tests/agent/init-analyzer.test.ts`
- 创建 `tests/agent/dream-consolidator.test.ts`

- [ ] **Step 1：VisionAssistant 测试**

测试点（mock ILLMClient）：

- findVisionModel() 有 multimodal 模型 → 返回 selection
- findVisionModel() 无 multimodal 模型 → 返回 null
- analyze() 成功 → 返回 VisionResult
- analyze() LLM 失败 → 返回 null
- extractImageReferences("@screenshot.png and @ui.jpg") → ['screenshot.png', 'ui.jpg']
- extractImageReferences("没有图片") → []
- needsVision("看看这个截图") → true
- needsVision("帮我写个函数") → false
- loadImage() 有效路径 → 返回 ImageInput
- loadImage() 不支持的格式 → 返回 null

- [ ] **Step 2：BranchManager 测试**

测试点：

- initFromHistory() 创建主分支，节点数 = 消息数
- fork() 创建新分支，分支数 +1
- append() 在当前分支追加消息
- switchBranch() 切换到指定分支，返回正确的消息路径
- getPath() 返回从根到节点的完整路径
- listBranches() 返回所有分支信息
- 编辑消息后切换分支，conversationHistory 正确更新

- [ ] **Step 3：ProjectAnalyzer 测试**

测试点：

- analyze() 有 package.json → 提取项目信息
- analyze() 无 package.json → 使用目录名
- inferLanguage() .ts 文件最多 → 'TypeScript'
- inferFrameworks() react + next → ['React', 'Next.js']
- generateRules() LLM 成功 → 返回规则内容
- generateRules() LLM 失败 → 返回 fallback 规则

- [ ] **Step 4：DreamConsolidator 测试**

测试点：

- consolidate() 成功 → 返回整理后的 CheckpointData
- consolidate() LLM 返回无效 JSON → 返回 null
- consolidate() 合并重复条目 → 数组长度减少

- [ ] **Step 5：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/agent/
git commit -m "test(agent): add tests for vision, branch, init-analyzer, and dream-consolidator"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 200 个用例，Phase 11 的 175 + Phase 12 新增 ~25）
4. VisionAssistant 能找到有 `multimodal` 能力的模型并调用分析图片
5. 图片分析结果（文字描述）正确注入 conversationHistoryRef
6. 没有多模态模型时给出友好提示
7. BranchManager 能创建、切换、列出对话分支
8. /branch edit 创建新分支（编辑消息）
9. /branch switch 切换分支后 conversationHistoryRef 正确更新
10. /init 分析项目结构并生成 .routedev-rules.md
11. /init 在 LLM 失败时生成 fallback 规则
12. /dream 整理记忆（合并去重）并更新 CheckpointData
13. /dream 在没有记忆数据时给出提示
14. /help 和 /status 反映所有新增功能
15. `@filename.png` 图片引用正确解析为 ImageInput

## 注意事项

- **ImageContent 格式**：已有定义 `{ type: 'image', source: { type: 'base64', mediaType, data } }`。视觉模型调用时使用此格式。OpenAI 和 Anthropic 都支持 base64 图片输入，但格式略有不同——各自的 LLM 客户端实现负责转换
- **ModelConfig.capabilities**：`'multimodal'` 已在 ModelCapabilitySchema 中定义。用户需要在 config.yaml 的 providers 中为视觉模型标记此能力：`capabilities: [multimodal, code]`
- **VisionAssistant 的 clientGetter**：通过 `(providerId) => clientManager.get(providerId)` 获取 LLM 客户端。这比直接传入 client 更灵活，支持运行时模型切换
- **BranchManager 是叠加层**：不影响现有的 conversationHistoryRef 工作流。当用户不使用 /branch 命令时，BranchManager 只是默默追踪节点，不改变任何行为
- **分支的 conversationHistoryRef 同步**：切换分支时，用 `branchManagerRef.current.switchBranch()` 返回的消息路径替换 `conversationHistoryRef.current`。这确保了后续 ReAct loop 使用的是新分支的上下文
- **/init 使用 classifierModel**：项目分析不需要高质量模型，用分类器模型（默认 deepseek-v4-flash）即可。Token 预算 2000
- **/dream 的幂等性**：多次运行 /dream 不会导致记忆丢失——consolidator 只合并和压缩，不删除核心信息
- **.routedev-rules.md 的用途**：当前只是生成文件，不自动加载到系统 prompt。后续 Phase 可在系统 prompt 中读取此文件作为项目上下文
- **图片引用格式 `@filename.png`**：与现有的 `@<filename>` 快捷引用系统保持一致。Phase 12 先实现图片引用，后续可扩展 `@<symbol>` 代码符号引用
- **Phase 11 依赖**：/dream 依赖 ContextManager 的 `getCheckpoint()` 和 `setCheckpoint()` 方法。确保 Phase 11 已完成
- **分支 ID 是 UUID 短格式（8 字符）**：/branch switch 支持前缀匹配，用户只需输入前几位即可

---

*Phase 12 | 蓝图 V1.0 | 预估新增文件：~5 个 | 预估修改文件：~1 个（App.tsx）*
