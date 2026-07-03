// tests/agent/multi/agent-group-resolver.test.ts
// Phase 69 Task 4: AgentGroupResolver 单元测试

import { describe, it, expect } from 'vitest';
import { AgentGroupResolver } from '../../../src/agent/multi/agent-group-resolver.js';

describe('AgentGroupResolver', () => {
  describe('register + resolve @group syntax', () => {
    it('should resolve @group to workerIds', () => {
      const resolver = new AgentGroupResolver();
      resolver.register({
        name: 'frontend',
        workerIds: ['worker-1', 'worker-2', 'worker-3'],
        description: 'Frontend team',
      });

      const result = resolver.resolve('@frontend');
      expect(result).toEqual(['worker-1', 'worker-2', 'worker-3']);
    });
  });

  describe('single workerId returns [workerId]', () => {
    it('should return array with single workerId for non-group address', () => {
      const resolver = new AgentGroupResolver();

      const result = resolver.resolve('worker-42');
      expect(result).toEqual(['worker-42']);
    });
  });

  describe('unknown group returns empty array', () => {
    it('should return empty array for unregistered group', () => {
      const resolver = new AgentGroupResolver();

      const result = resolver.resolve('@unknown');
      expect(result).toEqual([]);
    });
  });

  describe('isGroupAddress check', () => {
    it('should return true for registered group', () => {
      const resolver = new AgentGroupResolver();
      resolver.register({
        name: 'backend',
        workerIds: ['worker-5'],
        description: 'Backend team',
      });

      expect(resolver.isGroupAddress('@backend')).toBe(true);
    });

    it('should return false for non-group address', () => {
      const resolver = new AgentGroupResolver();

      expect(resolver.isGroupAddress('worker-1')).toBe(false);
    });

    it('should return false for unregistered group', () => {
      const resolver = new AgentGroupResolver();

      expect(resolver.isGroupAddress('@nonexistent')).toBe(false);
    });
  });

  describe('unregister removes group', () => {
    it('should remove group and return true', () => {
      const resolver = new AgentGroupResolver();
      resolver.register({
        name: 'temp',
        workerIds: ['w-1'],
        description: 'Temporary group',
      });

      expect(resolver.unregister('temp')).toBe(true);
      expect(resolver.isGroupAddress('@temp')).toBe(false);
      expect(resolver.resolve('@temp')).toEqual([]);
    });

    it('should return false for non-existent group', () => {
      const resolver = new AgentGroupResolver();

      expect(resolver.unregister('nonexistent')).toBe(false);
    });
  });

  describe('listGroups returns all', () => {
    it('should return all registered groups', () => {
      const resolver = new AgentGroupResolver();
      resolver.register({
        name: 'team-a',
        workerIds: ['w-1'],
        description: 'Team A',
      });
      resolver.register({
        name: 'team-b',
        workerIds: ['w-2', 'w-3'],
        description: 'Team B',
      });

      const groups = resolver.listGroups();
      expect(groups.length).toBe(2);
      expect(groups.map((g) => g.name)).toContain('team-a');
      expect(groups.map((g) => g.name)).toContain('team-b');
    });

    it('should return empty array when no groups registered', () => {
      const resolver = new AgentGroupResolver();

      expect(resolver.listGroups()).toEqual([]);
    });
  });
});
