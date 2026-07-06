// tests/agent/session-tree-entries.test.ts
// Phase 73 Part D：会话树结构增强测试
//
// 覆盖：
//   1. MessageNode 创建和序列化
//   2. CompactionNode 追加到树
//   3. BranchSummaryNode 追加到树
//   4. 从树重建 context 时跳过被压缩部分
//   5. BranchSummaryNode 转换为 user 消息
//   6. JSONL append-only 持久化
//   7. 旧格式迁移

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BranchManager,
  type BranchNode,
  type MessageNode,
  type CompactionNode,
  type BranchSummaryNode,
  type BranchInfo,
} from '../../src/agent/branch.js';
import type { LLMMessage } from '../../src/router/types.js';
import {
  BranchPersistence,
  type PersistedConversationTree,
} from '../../src/agent/branch-persistence.js';

// ============================================================
// 工具：通过 any 访问 BranchManager 内部字段（与 BranchOperations 同策略）
// ============================================================
function managerInternals(bm: BranchManager): {
  nodes: Map<string, BranchNode>;
  branches: Map<string, BranchInfo>;
  activeBranchId: string | null;
  activeBranchKey: string | null;
  historyNodeIds: string[];
} {
  return bm as unknown as {
    nodes: Map<string, BranchNode>;
    branches: Map<string, BranchInfo>;
    activeBranchId: string | null;
    activeBranchKey: string | null;
    historyNodeIds: string[];
  };
}

const sampleHistory: LLMMessage[] = [
  { role: 'user', content: 'msg 1' },
  { role: 'assistant', content: 'reply 1' },
  { role: 'user', content: 'msg 2' },
  { role: 'assistant', content: 'reply 2' },
  { role: 'user', content: 'msg 3' },
];

// ============================================================
// 1. MessageNode 创建和序列化
// ============================================================
describe('Phase 73 Part D - MessageNode', () => {
  it('1.1 append 创建的节点 type 为 message', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    bm.append({ role: 'assistant', content: 'extra msg' });

    const m = managerInternals(bm);
    const tipNode = m.nodes.get(m.activeBranchId!);
    expect(tipNode).toBeDefined();
    expect(tipNode!.type).toBe('message');
    expect((tipNode as MessageNode).message.content).toBe('extra msg');
  });

  it('1.2 initFromHistory 创建的节点全部 type 为 message', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    for (const node of m.nodes.values()) {
      expect(node.type).toBe('message');
    }
  });

  it('1.3 MessageNode 序列化为 JSON 包含 type 字段', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    const tipNode = m.nodes.get(m.activeBranchId!) as MessageNode;
    const json = JSON.stringify(tipNode);
    const parsed = JSON.parse(json) as MessageNode;
    expect(parsed.type).toBe('message');
    expect(parsed.message.content).toBe(tipNode.message.content);
  });
});

// ============================================================
// 2. CompactionNode 追加到树
// ============================================================
describe('Phase 73 Part D - CompactionNode', () => {
  it('2.1 appendCompactionNode 创建压缩节点', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);

    // 模拟压缩：假设保留最后两条消息
    const m = managerInternals(bm);
    const firstKeptEntryId = m.historyNodeIds[m.historyNodeIds.length - 2];
    const summary = '之前讨论了 msg1 到 msg3 的内容';
    const tokensBefore = 5000;

    const compactionId = bm.appendCompactionNode(summary, firstKeptEntryId, tokensBefore);

    expect(compactionId).toBeDefined();
    const compactionNode = m.nodes.get(compactionId) as CompactionNode;
    expect(compactionNode).toBeDefined();
    expect(compactionNode.type).toBe('compaction');
    expect(compactionNode.summary).toBe(summary);
    expect(compactionNode.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(compactionNode.tokensBefore).toBe(tokensBefore);
    expect(compactionNode.parentId).toBe(m.historyNodeIds[m.historyNodeIds.length - 1]);
  });

  it('2.2 appendCompactionNode 更新当前分支 tip', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    const oldTip = m.activeBranchId!;

    const compactionId = bm.appendCompactionNode('summary', 'fake-id', 1000);

    const branch = m.branches.get(m.activeBranchKey!)!;
    expect(branch.tipNodeId).toBe(compactionId);
    expect(m.activeBranchId).toBe(compactionId);
    expect(m.activeBranchId).not.toBe(oldTip);
  });
});

// ============================================================
// 3. BranchSummaryNode 追加到树
// ============================================================
describe('Phase 73 Part D - BranchSummaryNode', () => {
  it('3.1 appendBranchSummaryNode 创建分支摘要节点', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    const fromId = m.activeBranchId!;

    const summaryId = bm.appendBranchSummaryNode(fromId, '之前探索了 5 条消息的分支');

    const summaryNode = m.nodes.get(summaryId) as BranchSummaryNode;
    expect(summaryNode).toBeDefined();
    expect(summaryNode.type).toBe('branch_summary');
    expect(summaryNode.fromId).toBe(fromId);
    expect(summaryNode.summary).toBe('之前探索了 5 条消息的分支');
  });

  it('3.2 切换分支时自动追加 BranchSummaryNode', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);

    // fork 创建第二个分支
    const m = managerInternals(bm);
    const forkPoint = m.historyNodeIds[1]; // 在第二条消息处分叉
    bm.fork(forkPoint, { role: 'user', content: '分叉消息' });

    const nodeCountBefore = m.nodes.size;

    // 切换回第一个分支（使用前缀匹配）
    // 第一个分支的 ID 是 initFromHistory 中最后一条历史消息的 ID
    const firstBranchId = m.historyNodeIds[sampleHistory.length - 1];
    bm.switchBranch(firstBranchId);

    // 应该追加了一个 BranchSummaryNode
    const nodeCountAfter = m.nodes.size;
    expect(nodeCountAfter).toBe(nodeCountBefore + 1);

    // 新增的节点应为 BranchSummaryNode
    const tipNode = m.nodes.get(m.activeBranchId!) as BranchSummaryNode;
    expect(tipNode.type).toBe('branch_summary');
    expect(tipNode.summary).toContain('之前探索了');
    expect(tipNode.summary).toContain('条消息的分支');
  });

  it('3.3 BranchSummaryNode 摘要包含消息数和时间范围', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    const oldTip = m.activeBranchId!;

    const summaryId = bm.appendBranchSummaryNode(oldTip, '');
    const summaryNode = m.nodes.get(summaryId) as BranchSummaryNode;

    // 摘要应由 generateBranchAbandonmentSummary 生成
    // 但这里我们直接传了空字符串，所以需要测试 switchBranch 的自动生成
    expect(summaryNode.summary).toBe('');

    // 测试通过 switchBranch 自动生成的摘要
    bm.fork(oldTip, { role: 'user', content: 'new branch' });
    bm.switchBranch(m.historyNodeIds[sampleHistory.length - 1]);

    const tipAfterSwitch = m.nodes.get(m.activeBranchId!) as BranchSummaryNode;
    expect(tipAfterSwitch.type).toBe('branch_summary');
    expect(tipAfterSwitch.summary).toMatch(/之前探索了 \d+ 条消息的分支/);
    expect(tipAfterSwitch.summary).toContain('时间范围');
  });
});

// ============================================================
// 4. 从树重建 context 时跳过被压缩部分
// ============================================================
describe('Phase 73 Part D - getPath 处理 CompactionNode', () => {
  it('4.1 有 CompactionNode 时用 summary 替代被压缩消息', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);

    // 保留最后 2 条消息，压缩前 3 条
    const allNodeIds = [...m.historyNodeIds];
    const firstKeptEntryId = allNodeIds[allNodeIds.length - 2]; // 倒数第二个

    const summary = '这是压缩摘要';
    bm.appendCompactionNode(summary, firstKeptEntryId, 5000);

    const path = bm.getPath(m.activeBranchId!);

    // 第一条应为 summary（作为 system 消息）
    expect(path[0]).toEqual({ role: 'system', content: summary });

    // 应只包含 firstKeptEntryId 及之后的 MessageNode（最后 2 条）
    // sampleHistory 最后两条依次为 reply 2（assistant）和 msg 3（user）
    const userMessages = path.filter(msg => msg.role !== 'system');
    expect(userMessages.length).toBe(2);
    expect(userMessages[0].content).toBe('reply 2'); // 倒数第二条
    expect(userMessages[1].content).toBe('msg 3'); // 最后一条
  });

  it('4.2 无 CompactionNode 时保持原有逻辑', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);

    const path = bm.getPath(m.activeBranchId!);
    // 应包含所有 5 条历史消息（不含虚拟根）
    expect(path.length).toBe(sampleHistory.length);
    expect(path[0].content).toBe('msg 1');
    expect(path[4].content).toBe('msg 3');
  });

  it('4.3 CompactionNode 后追加新消息时全部保留', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);

    const firstKeptEntryId = m.historyNodeIds[m.historyNodeIds.length - 2];
    bm.appendCompactionNode('summary', firstKeptEntryId, 5000);

    // 压缩后追加新消息
    bm.append({ role: 'user', content: 'compaction 后的新消息' });

    const path = bm.getPath(m.activeBranchId!);
    // 应包含：summary + 最后 2 条旧消息 + 1 条新消息
    expect(path[0]).toEqual({ role: 'system', content: 'summary' });
    const nonSystemMessages = path.filter(msg => msg.role !== 'system');
    expect(nonSystemMessages.length).toBe(3);
    expect(nonSystemMessages[2].content).toBe('compaction 后的新消息');
  });
});

// ============================================================
// 5. BranchSummaryNode 转换为 user 消息
// ============================================================
describe('Phase 73 Part D - getPath 处理 BranchSummaryNode', () => {
  it('5.1 BranchSummaryNode 转换为 user 消息带 [分支探索记录] 前缀', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);

    bm.appendBranchSummaryNode(m.activeBranchId!, '之前探索了 3 条消息的分支');

    const path = bm.getPath(m.activeBranchId!);
    const lastMsg = path[path.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toBe('[分支探索记录] 之前探索了 3 条消息的分支');
  });

  it('5.2 BranchSummaryNode 不影响其他 MessageNode 的顺序', () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);

    bm.appendBranchSummaryNode(m.activeBranchId!, '摘要内容');

    const path = bm.getPath(m.activeBranchId!);
    // 应包含原始 5 条消息 + 1 条 BranchSummaryNode 转换的 user 消息
    expect(path.length).toBe(sampleHistory.length + 1);
    // 前 5 条保持原样
    expect(path[0].content).toBe('msg 1');
    expect(path[4].content).toBe('msg 3');
    // 最后一条是 BranchSummaryNode 转换的
    expect(path[5].content).toBe('[分支探索记录] 摘要内容');
  });
});

// ============================================================
// 6. JSONL 持久化（含新节点类型）
// ============================================================
describe('Phase 73 Part D - 持久化', () => {
  let tmpDir: string;
  let persistence: BranchPersistence;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'routedev-session-tree-'));
    persistence = new BranchPersistence(tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('6.1 CompactionNode 持久化往返一致', async () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    const firstKeptEntryId = m.historyNodeIds[m.historyNodeIds.length - 2];
    bm.appendCompactionNode('持久化摘要', firstKeptEntryId, 9999);

    const tree = BranchPersistence.extractFromManager(managerInternals(bm));
    await persistence.save(tree);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    // 应有 root + 5 history + 1 compaction = 7 节点
    expect(loaded!.nodes.length).toBe(7);
    const compactionNodes = loaded!.nodes.filter(n => n.type === 'compaction');
    expect(compactionNodes.length).toBe(1);
    const cn = compactionNodes[0] as CompactionNode;
    expect(cn.summary).toBe('持久化摘要');
    expect(cn.firstKeptEntryId).toBe(firstKeptEntryId);
    expect(cn.tokensBefore).toBe(9999);
  });

  it('6.2 BranchSummaryNode 持久化往返一致', async () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const m = managerInternals(bm);
    bm.appendBranchSummaryNode(m.activeBranchId!, '分支摘要测试');

    const tree = BranchPersistence.extractFromManager(managerInternals(bm));
    await persistence.save(tree);
    const loaded = await persistence.load();

    expect(loaded).not.toBeNull();
    const summaryNodes = loaded!.nodes.filter(n => n.type === 'branch_summary');
    expect(summaryNodes.length).toBe(1);
    const sn = summaryNodes[0] as BranchSummaryNode;
    expect(sn.summary).toBe('分支摘要测试');
  });

  it('6.3 .bak 文件在迁移期作为兜底', async () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const tree = BranchPersistence.extractFromManager(managerInternals(bm));
    await persistence.save(tree);
    // 再次 save 让 .bak 也存在
    await persistence.save(tree);

    const bakPath = path.join(tmpDir, '.routedev', 'conversation', 'tree.jsonl.bak');
    expect(fs.existsSync(bakPath)).toBe(true);
  });
});

// ============================================================
// 7. 旧格式迁移
// ============================================================
describe('Phase 73 Part D - 旧格式迁移', () => {
  let tmpDir: string;
  let persistence: BranchPersistence;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'routedev-migrate-'));
    persistence = new BranchPersistence(tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('7.1 旧 JSONL 格式（type:node）自动迁移为 MessageNode', async () => {
    // 手动构造旧 JSONL 格式文件
    const convDir = path.join(tmpDir, '.routedev', 'conversation');
    await fsp.mkdir(convDir, { recursive: true });
    const filePath = path.join(convDir, 'tree.jsonl');

    const oldLines = [
      JSON.stringify({ type: 'header', version: 1, activeBranchId: 'n2', activeBranchKey: 'b1', lastModifiedAt: Date.now() }),
      JSON.stringify({ type: 'node', id: 'n1', parentId: null, message: { role: 'user', content: 'old msg' }, children: ['n2'], timestamp: Date.now() }),
      JSON.stringify({ type: 'node', id: 'n2', parentId: 'n1', message: { role: 'assistant', content: 'old reply' }, children: [], timestamp: Date.now() }),
      JSON.stringify({ type: 'branch', id: 'b1', name: 'main', tipNodeId: 'n2', messageCount: 2, isActive: true, createdAt: Date.now(), parentId: null, lastActiveAt: Date.now() }),
      JSON.stringify({ type: 'history', nodeIds: ['n1', 'n2'] }),
    ];
    await fsp.writeFile(filePath, oldLines.join('\n') + '\n', 'utf8');

    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    // 所有节点应迁移为 type:'message'
    for (const node of loaded!.nodes) {
      expect(node.type).toBe('message');
    }
    expect(loaded!.nodes.length).toBe(2);
    expect((loaded!.nodes[0] as MessageNode).message.content).toBe('old msg');
  });

  it('7.2 旧单 JSON 格式（整文件一个对象）自动迁移', async () => {
    const convDir = path.join(tmpDir, '.routedev', 'conversation');
    await fsp.mkdir(convDir, { recursive: true });
    const filePath = path.join(convDir, 'tree.jsonl');

    // 旧单 JSON 格式：整文件为 { version, nodes, branches, ... }
    const oldTree = {
      version: 1,
      activeBranchId: 'n2',
      activeBranchKey: 'b1',
      nodes: [
        { id: 'n1', parentId: null, message: { role: 'user', content: 'single json msg' }, children: ['n2'], timestamp: Date.now() },
        { id: 'n2', parentId: 'n1', message: { role: 'assistant', content: 'single json reply' }, children: [], timestamp: Date.now() },
      ],
      branches: [
        { id: 'b1', name: 'main', tipNodeId: 'n2', messageCount: 2, isActive: true, createdAt: Date.now(), parentId: null, lastActiveAt: Date.now() },
      ],
      historyNodeIds: ['n1', 'n2'],
      lastModifiedAt: Date.now(),
    };
    await fsp.writeFile(filePath, JSON.stringify(oldTree), 'utf8');

    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    // 迁移后所有节点应为 type:'message'
    for (const node of loaded!.nodes) {
      expect(node.type).toBe('message');
    }
    expect(loaded!.nodes.length).toBe(2);
    expect((loaded!.nodes[0] as MessageNode).message.content).toBe('single json msg');
  });

  it('7.3 新格式 JSONL 正常加载（不触发迁移）', async () => {
    const bm = new BranchManager();
    bm.initFromHistory(sampleHistory);
    const tree = BranchPersistence.extractFromManager(managerInternals(bm));
    await persistence.save(tree);

    const loaded = await persistence.load();
    expect(loaded).not.toBeNull();
    // 新格式节点应保留 type:'message'
    for (const node of loaded!.nodes) {
      expect(node.type).toBe('message');
    }
  });
});
