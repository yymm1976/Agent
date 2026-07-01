// tests/agent/multi/blackboard.test.ts
// Blackboard 单元测试

import { describe, it, expect } from 'vitest';
import { Blackboard } from '../../../src/agent/multi/blackboard.js';

describe('Blackboard', () => {
  describe('setGoal', () => {
    it('should set current goal', () => {
      const bb = new Blackboard();
      bb.setGoal('test goal', 'executing');
      const snap = bb.getSnapshot();
      expect(snap.currentGoal?.description).toBe('test goal');
      expect(snap.currentGoal?.status).toBe('executing');
    });
  });

  describe('updateGoalStatus', () => {
    it('should update existing goal status', () => {
      const bb = new Blackboard();
      bb.setGoal('goal', 'pending');
      bb.updateGoalStatus('completed');
      expect(bb.getSnapshot().currentGoal?.status).toBe('completed');
    });

    it('should be no-op when no goal set', () => {
      const bb = new Blackboard();
      bb.updateGoalStatus('completed');
      expect(bb.getSnapshot().currentGoal).toBeNull();
    });
  });

  describe('addCompletedStep', () => {
    it('should append entry', () => {
      const bb = new Blackboard();
      bb.addCompletedStep(1, 'coder', 'auth 模块已创建');
      const snap = bb.getSnapshot();
      expect(snap.completedSteps.length).toBe(1);
      expect(snap.completedSteps[0].key).toBe('step-1');
      expect(snap.completedSteps[0].value).toBe('auth 模块已创建');
      expect(snap.completedSteps[0].source.role).toBe('coder');
    });

    it('should accept custom confidence', () => {
      const bb = new Blackboard();
      bb.addCompletedStep(1, 'tester', 'pass', 0.95);
      expect(bb.getSnapshot().completedSteps[0].confidence).toBe(0.95);
    });

    it('should default confidence to 0.8', () => {
      const bb = new Blackboard();
      bb.addCompletedStep(1, 'coder', 'done');
      expect(bb.getSnapshot().completedSteps[0].confidence).toBe(0.8);
    });
  });

  describe('addProjectFact', () => {
    it('should append new fact', () => {
      const bb = new Blackboard();
      bb.addProjectFact('framework', 'React');
      const snap = bb.getSnapshot();
      expect(snap.projectFacts.length).toBe(1);
      expect(snap.projectFacts[0].key).toBe('framework');
    });

    it('should update existing fact', () => {
      const bb = new Blackboard();
      bb.addProjectFact('framework', 'React');
      bb.addProjectFact('framework', 'Vue');
      const snap = bb.getSnapshot();
      expect(snap.projectFacts.length).toBe(1);
      expect(snap.projectFacts[0].value).toBe('Vue');
    });

    it('should support custom confidence', () => {
      const bb = new Blackboard();
      bb.addProjectFact('x', 'y', 0.5);
      expect(bb.getSnapshot().projectFacts[0].confidence).toBe(0.5);
    });
  });

  describe('formatForPrompt', () => {
    it('should return empty placeholder when no data', () => {
      const bb = new Blackboard();
      expect(bb.formatForPrompt()).toBe('（黑板为空）');
    });

    it('should include current goal', () => {
      const bb = new Blackboard();
      bb.setGoal('写一个 todo app', 'pending');
      const out = bb.formatForPrompt();
      expect(out).toContain('当前目标: 写一个 todo app');
    });

    it('should include completed steps', () => {
      const bb = new Blackboard();
      bb.addCompletedStep(1, 'coder', 'created auth.ts');
      const out = bb.formatForPrompt();
      expect(out).toContain('已完成步骤');
      expect(out).toContain('created auth.ts');
    });

    it('should include project facts', () => {
      const bb = new Blackboard();
      bb.addProjectFact('framework', 'React');
      const out = bb.formatForPrompt();
      expect(out).toContain('项目共识');
      expect(out).toContain('framework: React');
    });
  });
});