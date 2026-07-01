import { describe, expect, it } from 'vitest';
import { LevelPathRouter } from './level-path-router.js';

describe('LevelPathRouter', () => {
  const router = new LevelPathRouter();

  it('L1/L2 映射到 single', () => {
    expect(router.selectPath('L1').route).toBe('single');
    expect(router.selectPath('L2').route).toBe('single');
  });

  it('L3 映射到 dag', () => {
    expect(router.selectPath('L3').route).toBe('dag');
  });

  it('L4/L5 映射到 compose，L5 带研究和批判阶段', () => {
    expect(router.selectPath('L4').route).toBe('compose');
    const l5 = router.selectPath('L5');
    expect(l5.route).toBe('compose');
    expect(l5.preStages).toContain('researcher');
    expect(l5.postStages).toContain('critic');
  });

  it('失败和阻塞信号会建议升级', () => {
    const suggestion = router.detectLevelSwitch('L2', {
      failureCount: 2,
      contextUsagePercent: 0.4,
      crossDomain: false,
      unresolvedBlockers: 0,
    });

    expect(suggestion?.from).toBe('L2');
    expect(suggestion?.to).toBe('L3');
  });
});
