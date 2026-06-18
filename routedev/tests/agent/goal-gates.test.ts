// tests/agent/goal-gates.test.ts
// GoalGateManager 单元测试（Phase 21 Task 2）
// 验证：freeze 写入 .gates.json；load 恢复数据；updateGate 更新状态；
//       无文件时 load 返回 null；locked 时 modify 行为正确

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GoalGateManager, gatesFromSteps, type Gate } from '../../src/agent/goal-gates.js';

describe('GoalGateManager', () => {
  let tempDir: string;
  let manager: GoalGateManager;

  beforeEach(async () => {
    // 每个测试用独立的临时目录
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-gates-'));
    manager = new GoalGateManager(tempDir);
  });

  afterEach(async () => {
    // 清理临时目录
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('freeze', () => {
    it('freeze 写入 .gates.json 并设置 locked=true', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '步骤1完成', status: 'pending' },
        { id: 'step-2', criteria: '步骤2完成', status: 'pending' },
      ];

      const frozen = await manager.freeze('测试目标', gates);

      // 返回值正确
      expect(frozen.goalText).toBe('测试目标');
      expect(frozen.gates.length).toBe(2);
      expect(frozen.locked).toBe(true);
      expect(frozen.frozenAt).toBeGreaterThan(0);

      // 文件已写入
      const filePath = path.join(tempDir, '.routedev', '.gates.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.goalText).toBe('测试目标');
      expect(parsed.gates.length).toBe(2);
      expect(parsed.locked).toBe(true);

      // 内存中也保存了
      expect(manager.getGates()).not.toBeNull();
      expect(manager.getGates()?.gates.length).toBe(2);
    });

    it('freeze 深拷贝 gates（外部修改不影响内部）', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '原始', status: 'pending' },
      ];
      const frozen = await manager.freeze('目标', gates);

      // 外部修改
      gates[0].criteria = '被修改';
      gates.push({ id: 'step-2', criteria: '注入', status: 'pending' });

      // 内部不受影响
      expect(frozen.gates.length).toBe(1);
      expect(frozen.gates[0].criteria).toBe('原始');
    });
  });

  describe('load', () => {
    it('load 从 .gates.json 恢复数据', async () => {
      // 先 freeze 写入
      const gates: Gate[] = [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
        { id: 'step-2', criteria: '步骤2', status: 'passed', evidence: '测试通过' },
      ];
      await manager.freeze('加载测试', gates);

      // 新建 manager（模拟新会话）
      const newManager = new GoalGateManager(tempDir);
      expect(newManager.getGates()).toBeNull();

      // 加载
      const loaded = await newManager.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.goalText).toBe('加载测试');
      expect(loaded!.gates.length).toBe(2);
      expect(loaded!.gates[0].criteria).toBe('步骤1');
      expect(loaded!.gates[1].status).toBe('passed');
      expect(loaded!.gates[1].evidence).toBe('测试通过');
      expect(loaded!.locked).toBe(true);

      // 内存中也保存了
      expect(newManager.getGates()?.goalText).toBe('加载测试');
    });

    it('无文件时 load 返回 null', async () => {
      const empty = await manager.load();
      expect(empty).toBeNull();
      expect(manager.getGates()).toBeNull();
    });

    it('文件损坏时 load 返回 null（不抛异常）', async () => {
      // 写入损坏的 JSON
      await fs.mkdir(path.join(tempDir, '.routedev'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.routedev', '.gates.json'),
        '这不是有效的 JSON {{{',
        'utf-8',
      );
      const result = await manager.load();
      expect(result).toBeNull();
    });
  });

  describe('updateGate', () => {
    it('updateGate 更新状态和证据', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
        { id: 'step-2', criteria: '步骤2', status: 'pending' },
      ];
      await manager.freeze('目标', gates);

      // 更新 step-1 为 passed
      const ok = manager.updateGate('step-1', 'passed', '所有测试通过');
      expect(ok).toBe(true);

      const updated = manager.getGates();
      expect(updated!.gates[0].status).toBe('passed');
      expect(updated!.gates[0].evidence).toBe('所有测试通过');
      // step-2 不受影响
      expect(updated!.gates[1].status).toBe('pending');
    });

    it('updateGate 不存在的 gateId 返回 false', async () => {
      await manager.freeze('目标', [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
      ]);
      const ok = manager.updateGate('nonexistent', 'passed');
      expect(ok).toBe(false);
    });

    it('updateGate 在未 freeze 时返回 false', () => {
      const ok = manager.updateGate('step-1', 'passed');
      expect(ok).toBe(false);
    });

    it('updateGate 不传 evidence 时不覆盖已有 evidence', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '步骤1', status: 'pending', evidence: '原始证据' },
      ];
      await manager.freeze('目标', gates);

      manager.updateGate('step-1', 'passed'); // 不传 evidence
      const updated = manager.getGates();
      expect(updated!.gates[0].evidence).toBe('原始证据'); // 保留原值
    });

    it('updateGate 传 undefined evidence 不覆盖（传空字符串会覆盖）', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '步骤1', status: 'pending', evidence: '原始' },
      ];
      await manager.freeze('目标', gates);

      manager.updateGate('step-1', 'failed', undefined);
      expect(manager.getGates()!.gates[0].evidence).toBe('原始');

      manager.updateGate('step-1', 'failed', '');
      expect(manager.getGates()!.gates[0].evidence).toBe('');
    });
  });

  describe('modifyGate', () => {
    it('modifyGate 在 locked=false（已解锁）时修改 criteria', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '原始标准', status: 'pending' },
      ];
      await manager.freeze('目标', gates);

      // freeze 后 locked=true（冻结），需先 unlock 才能修改
      expect(manager.getGates()!.locked).toBe(true);
      await manager.unlock();
      expect(manager.getGates()!.locked).toBe(false);

      // locked=false → 允许修改
      const ok = await manager.modifyGate('step-1', '更严格的标准');
      expect(ok).toBe(true);
      expect(manager.getGates()!.gates[0].criteria).toBe('更严格的标准');

      // 持久化到磁盘
      const newManager = new GoalGateManager(tempDir);
      const loaded = await newManager.load();
      expect(loaded!.gates[0].criteria).toBe('更严格的标准');
    });

    it('modifyGate 不存在的 gateId 返回 false', async () => {
      await manager.freeze('目标', [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
      ]);
      await manager.unlock();
      const ok = await manager.modifyGate('nonexistent', '新标准');
      expect(ok).toBe(false);
    });

    it('modifyGate 在未 freeze 时返回 false', async () => {
      const ok = await manager.modifyGate('step-1', '新标准');
      expect(ok).toBe(false);
    });

    it('modifyGate 在 locked=true（冻结）时拒绝修改', async () => {
      const gates: Gate[] = [
        { id: 'step-1', criteria: '原始', status: 'pending' },
      ];
      await manager.freeze('目标', gates);

      // freeze 后 locked=true（冻结）→ modifyGate 应拒绝
      expect(manager.getGates()!.locked).toBe(true);

      const ok = await manager.modifyGate('step-1', '新标准');
      expect(ok).toBe(false);
      expect(manager.getGates()!.gates[0].criteria).toBe('原始');
    });
  });

  describe('unlock / lock', () => {
    it('unlock 后 locked=false，lock 后恢复 true', async () => {
      await manager.freeze('目标', [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
      ]);
      expect(manager.getGates()!.locked).toBe(true);

      await manager.unlock();
      expect(manager.getGates()!.locked).toBe(false);

      await manager.lock();
      expect(manager.getGates()!.locked).toBe(true);
    });

    it('unlock/lock 持久化到磁盘', async () => {
      await manager.freeze('目标', [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
      ]);
      await manager.unlock();

      const newManager = new GoalGateManager(tempDir);
      const loaded = await newManager.load();
      expect(loaded!.locked).toBe(false);
    });
  });

  describe('clear', () => {
    it('clear 清空内存但不删除文件', async () => {
      await manager.freeze('目标', [
        { id: 'step-1', criteria: '步骤1', status: 'pending' },
      ]);
      expect(manager.getGates()).not.toBeNull();

      manager.clear();
      expect(manager.getGates()).toBeNull();

      // 文件仍在
      const newManager = new GoalGateManager(tempDir);
      const loaded = await newManager.load();
      expect(loaded).not.toBeNull();
    });
  });

  describe('gatesFromSteps 工具函数', () => {
    it('从步骤描述列表构造 Gate 列表', () => {
      const steps = ['步骤一', '步骤二', '步骤三'];
      const gates = gatesFromSteps(steps);
      expect(gates.length).toBe(3);
      expect(gates[0].id).toBe('step-1');
      expect(gates[0].criteria).toBe('步骤一');
      expect(gates[0].status).toBe('pending');
      expect(gates[2].id).toBe('step-3');
    });

    it('空列表返回空数组', () => {
      const gates = gatesFromSteps([]);
      expect(gates).toEqual([]);
    });
  });
});
