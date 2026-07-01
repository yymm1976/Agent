import type { DifficultyLevel } from './difficulty-assessor.js';
import type { ExecutionRoute } from './execution-router.js';

export interface LevelPathSelection {
  route: Exclude<ExecutionRoute, 'legacy'>;
  preStages: Array<'researcher'>;
  postStages: Array<'critic'>;
  reason: string;
}

export interface LevelSwitchSignals {
  failureCount: number;
  contextUsagePercent: number;
  crossDomain: boolean;
  unresolvedBlockers: number;
}

export interface LevelSwitchSuggestion {
  from: DifficultyLevel;
  to: DifficultyLevel;
  reason: string;
}

export class LevelPathRouter {
  selectPath(level: DifficultyLevel): LevelPathSelection {
    if (level === 'L1' || level === 'L2') {
      return { route: 'single', preStages: [], postStages: [], reason: `${level} 使用单 Agent 串行路径` };
    }
    if (level === 'L3') {
      return { route: 'dag', preStages: [], postStages: [], reason: 'L3 使用 DAG 路径' };
    }
    if (level === 'L4') {
      return { route: 'compose', preStages: [], postStages: [], reason: 'L4 使用组合式多 Agent 路径' };
    }
    return { route: 'compose', preStages: ['researcher'], postStages: ['critic'], reason: 'L5 使用研究前置与批判后置路径' };
  }

  detectLevelSwitch(currentLevel: DifficultyLevel, signals: LevelSwitchSignals): LevelSwitchSuggestion | null {
    if (signals.failureCount >= 2 || signals.unresolvedBlockers > 0 || signals.contextUsagePercent >= 0.85) {
      const to = currentLevel === 'L5' ? 'L5' : this.nextLevel(currentLevel);
      if (to !== currentLevel) {
        return { from: currentLevel, to, reason: '失败、阻塞或上下文压力触发升级' };
      }
    }
    if (signals.crossDomain && (currentLevel === 'L1' || currentLevel === 'L2' || currentLevel === 'L3')) {
      return { from: currentLevel, to: 'L4', reason: '跨领域信号触发升级到组合路径' };
    }
    return null;
  }

  private nextLevel(level: DifficultyLevel): DifficultyLevel {
    const levels: DifficultyLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
    return levels[Math.min(levels.indexOf(level) + 1, levels.length - 1)];
  }
}
