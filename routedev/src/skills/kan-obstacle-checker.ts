// src/skills/kan-obstacle-checker.ts
// Phase 68 Task 4: Kan 障碍"空类型"警示

import type { ProvenanceGraph, ArtifactType } from '../memory/provenance-graph.js';
import { logger } from '../utils/logger.js';

export interface InputDependency {
  requiredType: ArtifactType | string;
  description: string;
  transportableFrom?: ArtifactType[];
}

export interface KanObstacleResult {
  hasObstacle: boolean;
  emptyTypes: string[];
  warning: string;
  suggestions: string[];
}

export class KanObstacleChecker {
  constructor(
    private readonly graph: ProvenanceGraph,
    private readonly config: {
      enabled: boolean;
      blockOnObstacle: boolean;
    },
  ) {}

  check(dependencies: InputDependency[]): KanObstacleResult {
    if (!this.config.enabled) {
      return { hasObstacle: false, emptyTypes: [], warning: '', suggestions: [] };
    }

    const currentSchema = new Set(this.graph.getSchemaSummary());
    const emptyTypes: string[] = [];
    const suggestions: string[] = [];

    for (const dep of dependencies) {
      if (currentSchema.has(dep.requiredType)) {
        const instances = this.graph.getByType(dep.requiredType as ArtifactType);
        if (instances.length > 0) continue;
      }

      if (dep.transportableFrom && dep.transportableFrom.length > 0) {
        const canTransport = dep.transportableFrom.some((srcType) => {
          const srcInstances = this.graph.getByType(srcType);
          return srcInstances.length > 0;
        });
        if (canTransport) {
          suggestions.push(`类型 '${dep.requiredType}' 可从 [${dep.transportableFrom.join(', ')}] 迁运填充`);
          continue;
        }
      }

      emptyTypes.push(dep.requiredType);
      suggestions.push(
        `类型 '${dep.requiredType}' 在现有 schema 无制品可填充，且无法迁运——需提供门核验的新制品`,
      );
    }

    const hasObstacle = emptyTypes.length > 0;
    const warning = hasObstacle
      ? `Kan 障碍：输入类型 [${emptyTypes.join(', ')}] 无法填充（迁运失败，需门核验新制品）`
      : '';

    if (hasObstacle) {
      logger.warn('KanObstacleChecker: 检测到空类型', {
        emptyTypes,
        blockOnObstacle: this.config.blockOnObstacle,
      });
    }

    return { hasObstacle, emptyTypes, warning, suggestions };
  }

  checkAndDecide(dependencies: InputDependency[]): {
    allowed: boolean;
    result: KanObstacleResult;
  } {
    const result = this.check(dependencies);
    if (result.hasObstacle && this.config.blockOnObstacle) {
      return { allowed: false, result };
    }
    return { allowed: true, result };
  }
}
