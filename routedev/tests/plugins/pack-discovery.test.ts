// tests/plugins/pack-discovery.test.ts
// PackDiscovery 单元测试（Phase 82 Task 4）
// 覆盖：内置 Pack 发现 / 项目级优先 / 同名覆盖 / fail-open
//
// 说明：内置 Pack 模块（src/plugins/packs/index.ts）由 Task 2/3 实现，
// 此处用 vi.mock + vi.hoisted 注入可变 mock 状态，控制每个用例的内置 Pack 集合。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackDiscovery, type DiscoveredPack } from '../../src/plugins/pack-discovery.js';
import type { CapabilityPack } from '../../src/plugins/capability-pack.js';

// ============================================================
// 内置 Pack 模块 mock：用 vi.hoisted 保持引用可变
// ============================================================

const mockState = vi.hoisted(() => ({
  // 内置 Pack 数组——测试用例通过 mutate（push/length=0）控制内容
  builtinPacks: [] as CapabilityPack[],
}));

vi.mock('../../src/plugins/packs/index.js', () => ({
  OFFICIAL_PACKS: mockState.builtinPacks,
}));

// ============================================================
// 测试辅助
// ============================================================

/** 创建一个 fake CapabilityPack（不依赖 PackContext 实际形状） */
function makeFakePack(id: string, description = '测试 Pack'): CapabilityPack {
  return {
    id,
    configKey: id,
    layer: 'extended' as CapabilityPack['layer'],
    description,
    costHint: '测试用，无实际开销',
    defaultEnabled: false,
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as CapabilityPack;
}

/** pack.json 内容 */
function packJson(id: string, description = '测试 Pack'): string {
  return JSON.stringify({
    id,
    layer: 'extended',
    description,
    costHint: '启用后会增加少量 token 消耗',
  }, null, 2);
}

/** Pack 入口 index.ts 内容（默认导出为 CapabilityPack） */
function packEntry(id: string, description = '测试 Pack'): string {
  return `
export default {
  id: '${id}',
  configKey: '${id}',
  layer: 'extended',
  description: '${description}',
  costHint: '测试用',
  defaultEnabled: false,
  async register() {},
  async unregister() {},
};
`;
}

/** 在指定 base 下创建一个 Pack 目录（含 pack.json + index.ts） */
async function createPack(
  base: string,
  name: string,
  id: string,
  description = '测试 Pack',
): Promise<string> {
  const packDir = join(base, '.routedev', 'packs', name);
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'pack.json'), packJson(id, description), 'utf-8');
  await writeFile(join(packDir, 'index.ts'), packEntry(id, description), 'utf-8');
  return packDir;
}

/** 在指定 base 下创建一个损坏的 Pack 目录（index.ts 有语法错误） */
async function createBrokenPack(
  base: string,
  name: string,
  id: string,
): Promise<string> {
  const packDir = join(base, '.routedev', 'packs', name);
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'pack.json'), packJson(id), 'utf-8');
  // 故意写入语法错误的入口文件，触发动态 import 抛错
  await writeFile(join(packDir, 'index.ts'), 'this is not valid TypeScript !!!', 'utf-8');
  return packDir;
}

// ============================================================
// 测试用例
// ============================================================

describe('PackDiscovery', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    // 每个用例独立的临时项目目录与用户主目录
    projectDir = await mkdtemp(join(tmpdir(), 'routedev-pack-project-'));
    homeDir = await mkdtemp(join(tmpdir(), 'routedev-pack-home-'));
    // 清空内置 Pack mock
    mockState.builtinPacks.length = 0;
  });

  afterEach(async () => {
    // 并行清理两个临时目录
    await Promise.all([
      rm(projectDir, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  // 测试 1：内置 Pack 可发现
  it('内置 Pack 可被 discover() 发现，source=builtin', async () => {
    const builtin1 = makeFakePack('pack.builtin-1', '内置 Pack 1');
    const builtin2 = makeFakePack('pack.builtin-2', '内置 Pack 2');
    mockState.builtinPacks.push(builtin1, builtin2);

    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.pack.id).sort();
    expect(ids).toEqual(['pack.builtin-1', 'pack.builtin-2']);
    // 所有内置 Pack 的 source 必须是 'builtin'
    for (const r of result) {
      expect(r.source).toBe('builtin');
      expect(r.path).toBe('<builtin>');
    }
  });

  // 测试 2：项目级与全局 Pack 同时被发现（不同 id 不冲突），source 正确标记
  it('项目级与全局 Pack 同时被发现，source 正确区分', async () => {
    // 项目级 Pack
    await createPack(projectDir, 'my-project-pack', 'pack.project-only', '项目级 Pack');
    // 全局 Pack
    await createPack(homeDir, 'my-global-pack', 'pack.global-only', '全局 Pack');

    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();

    expect(result).toHaveLength(2);

    const projectItem = result.find((r) => r.pack.id === 'pack.project-only');
    const globalItem = result.find((r) => r.pack.id === 'pack.global-only');
    expect(projectItem).toBeDefined();
    expect(globalItem).toBeDefined();
    // source 标记必须正确
    expect(projectItem!.source).toBe('project');
    expect(globalItem!.source).toBe('global');
    // 路径必须是绝对路径
    expect(projectItem!.path).toContain('my-project-pack');
    expect(globalItem!.path).toContain('my-global-pack');
  });

  // 测试 3：同名 Pack 项目级覆盖全局
  it('同名 Pack 项目级覆盖全局（仅返回项目级）', async () => {
    // 同 id 的 Pack 分别在项目级与全局
    await createPack(projectDir, 'override-pack', 'pack.same-id', '项目级版本');
    await createPack(homeDir, 'override-pack', 'pack.same-id', '全局版本');

    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();

    // 只应有 1 个（去重后）
    expect(result).toHaveLength(1);
    const item = result[0] as DiscoveredPack;
    expect(item.pack.id).toBe('pack.same-id');
    // 项目级胜出
    expect(item.source).toBe('project');
    expect(item.pack.description).toBe('项目级版本');
  });

  // 测试 4：加载失败不影响其他 Pack（fail-open）
  it('单个 Pack 加载失败时，其他 Pack 仍可正常发现', async () => {
    // 损坏的 Pack（index.ts 语法错误）
    await createBrokenPack(projectDir, 'broken-pack', 'pack.broken');
    // 正常的项目级 Pack
    await createPack(projectDir, 'good-pack', 'pack.good', '正常 Pack');
    // 内置 Pack
    const builtin = makeFakePack('pack.builtin-good', '内置正常 Pack');
    mockState.builtinPacks.push(builtin);

    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();

    // 损坏的 Pack 被跳过，只返回正常的 2 个
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.pack.id).sort();
    expect(ids).toEqual(['pack.builtin-good', 'pack.good']);
    // 确保损坏的 Pack 不在结果中
    expect(result.find((r) => r.pack.id === 'pack.broken')).toBeUndefined();
  });

  // 测试 5（额外）：三层优先级——项目级 > 全局 > 内置 同 id 链式覆盖
  it('同 id 时项目级覆盖全局，全局覆盖内置', async () => {
    // 三层都有同 id 的 Pack
    await createPack(projectDir, 'tier-pack', 'pack.tier', '项目级版本');
    await createPack(homeDir, 'tier-pack', 'pack.tier', '全局版本');
    mockState.builtinPacks.push(makeFakePack('pack.tier', '内置版本'));

    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    const item = result[0] as DiscoveredPack;
    // 项目级胜出
    expect(item.source).toBe('project');
    expect(item.pack.description).toBe('项目级版本');
  });

  // 测试 6（额外）：空目录场景——无任何 Pack 时不报错，返回空数组
  it('无任何 Pack 时返回空数组，不抛异常', async () => {
    const discovery = new PackDiscovery(projectDir, homeDir);
    const result = await discovery.discover();
    expect(result).toEqual([]);
  });
});
