// tests/agent/multi/conflict.test.ts
// ConflictDetector 单元测试

import { describe, it, expect } from 'vitest';
import { ConflictDetector } from '../../../src/agent/multi/conflict.js';
import type { StepDependency } from '../../../src/agent/multi/types.js';

function makeDep(stepId: number, files: string[], role: 'coder' | 'tester' | 'searcher' | 'reviewer' = 'coder'): StepDependency {
  return {
    stepId,
    dependsOn: [],
    assignedRole: role,
    likelyFiles: files,
  };
}

describe('ConflictDetector', () => {
  describe('detect', () => {
    it('should return no conflict for single step group', () => {
      const cd = new ConflictDetector();
      const result = cd.detect([1], [makeDep(1, ['a.ts'])]);
      expect(result.hasConflict).toBe(false);
    });

    it('should return no conflict when no file overlap', () => {
      const cd = new ConflictDetector();
      const deps = [makeDep(1, ['a.ts']), makeDep(2, ['b.ts'])];
      const result = cd.detect([1, 2], deps);
      expect(result.hasConflict).toBe(false);
    });

    it('should detect conflict with file overlap', () => {
      const cd = new ConflictDetector();
      const deps = [makeDep(1, ['config.ts']), makeDep(2, ['config.ts'])];
      const result = cd.detect([1, 2], deps);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictingFiles).toContain('config.ts');
      expect(result.conflictingSteps).toContainEqual([1, 2]);
      expect(result.suggestion).toContain('步骤 1 和 2');
    });

    it('should detect multiple overlapping files', () => {
      const cd = new ConflictDetector();
      const deps = [
        makeDep(1, ['a.ts', 'b.ts']),
        makeDep(2, ['b.ts', 'c.ts']),
      ];
      const result = cd.detect([1, 2], deps);
      expect(result.hasConflict).toBe(true);
      expect(result.conflictingFiles).toContain('b.ts');
    });

    it('should detect conflict among 3 steps', () => {
      const cd = new ConflictDetector();
      const deps = [
        makeDep(1, ['a.ts']),
        makeDep(2, ['b.ts']),
        makeDep(3, ['a.ts']),
      ];
      const result = cd.detect([1, 2, 3], deps);
      expect(result.hasConflict).toBe(true);
    });
  });

  describe('resolveConflicts', () => {
    it('should keep group unchanged when no conflict', () => {
      const cd = new ConflictDetector();
      const deps = [makeDep(1, ['a.ts']), makeDep(2, ['b.ts'])];
      const result = cd.resolveConflicts([[1, 2]], deps);
      expect(result).toEqual([[1, 2]]);
    });

    it('should split conflicting steps into separate groups', () => {
      const cd = new ConflictDetector();
      const deps = [makeDep(1, ['x.ts']), makeDep(2, ['x.ts'])];
      const result = cd.resolveConflicts([[1, 2]], deps);
      // 一个步骤在并行组，另一个独立成组
      expect(result.length).toBe(2);
      expect(result.flat().sort()).toEqual([1, 2]);
    });

    it('should handle empty groups', () => {
      const cd = new ConflictDetector();
      const result = cd.resolveConflicts([], []);
      expect(result).toEqual([]);
    });

    it('should preserve order across multiple groups', () => {
      const cd = new ConflictDetector();
      const deps = [
        makeDep(1, ['a.ts']),
        makeDep(2, ['b.ts']),
        makeDep(3, ['b.ts']),
      ];
      const result = cd.resolveConflicts([[1, 2, 3]], deps);
      // 1 保留在第一组，2 或 3 移出
      expect(result.length).toBeGreaterThan(1);
      expect(result.flat()).toContain(1);
    });
  });
});