// src/memory/provenance-graph.ts
// Phase 68 Task 2: 类型化制品 + 溯源图

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export type ArtifactType =
  | 'decision'
  | 'pattern'
  | 'pitfall'
  | 'api-contract'
  | 'test-evidence'
  | 'review-result';

export type ProducingOperation =
  | 'retrieval'
  | 'search'
  | 'discovery'
  | 'review'
  | 'test'
  | 'refine';

export interface TypedArtifact {
  id: string;
  artifactType: ArtifactType;
  producingOperation: ProducingOperation;
  parentIds: string[];
  content: string;
  relatedFiles?: string[];
  timestamp: number;
  sessionId: string;
  operationKind?: 'retrieval' | 'search' | 'discovery';
}

export interface ProvenanceEdge {
  from: string;
  to: string;
  operation: ProducingOperation;
}

export class ProvenanceGraph {
  private artifacts = new Map<string, TypedArtifact>();
  private edges = new Map<string, ProvenanceEdge[]>();
  private readonly maxArtifacts: number;

  constructor(maxArtifacts = 10000) {
    this.maxArtifacts = maxArtifacts;
  }

  addArtifact(artifact: TypedArtifact): void {
    if (this.artifacts.size >= this.maxArtifacts) {
      const oldestKey = this.artifacts.keys().next().value;
      if (oldestKey) {
        this.artifacts.delete(oldestKey);
        this.edges.delete(oldestKey);
      }
    }
    this.artifacts.set(artifact.id, artifact);
    for (const parentId of artifact.parentIds) {
      const edge: ProvenanceEdge = {
        from: parentId,
        to: artifact.id,
        operation: artifact.producingOperation,
      };
      const arr = this.edges.get(parentId) ?? [];
      arr.push(edge);
      this.edges.set(parentId, arr);
    }
  }

  getArtifact(id: string): TypedArtifact | undefined {
    return this.artifacts.get(id);
  }

  getByType(type: ArtifactType): TypedArtifact[] {
    return [...this.artifacts.values()].filter((a) => a.artifactType === type);
  }

  getLineage(id: string): TypedArtifact[] {
    const visited = new Set<string>();
    const result: TypedArtifact[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const artifact = this.artifacts.get(cur);
      if (artifact) {
        result.push(artifact);
        for (const pid of artifact.parentIds) {
          if (!visited.has(pid)) queue.push(pid);
        }
      }
    }
    return result;
  }

  getDescendants(id: string): TypedArtifact[] {
    const visited = new Set<string>();
    const result: TypedArtifact[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const outEdges = this.edges.get(cur) ?? [];
      for (const e of outEdges) {
        if (!visited.has(e.to)) {
          const a = this.artifacts.get(e.to);
          if (a) result.push(a);
          queue.push(e.to);
        }
      }
    }
    return result;
  }

  getSchemaSummary(): string[] {
    const types = new Set<string>();
    for (const a of this.artifacts.values()) {
      types.add(a.artifactType);
    }
    return [...types];
  }

  size(): number {
    return this.artifacts.size;
  }

  serialize(): string {
    return [...this.artifacts.values()].map((a) => JSON.stringify(a)).join('\n');
  }

  deserialize(data: string): void {
    this.artifacts.clear();
    this.edges.clear();
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as TypedArtifact;
        this.addArtifact(a);
      } catch {
        // skip corrupted lines
      }
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await readFile(filePath, 'utf-8');
      this.deserialize(data);
      logger.info('ProvenanceGraph: loaded from file', { filePath, count: this.artifacts.size });
    } catch {
      // file doesn't exist yet — that's fine
    }
  }

  async flushToFile(filePath: string): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, this.serialize(), 'utf-8');
      logger.debug('ProvenanceGraph: flushed to file', { filePath, count: this.artifacts.size });
    } catch (err) {
      logger.warn('ProvenanceGraph: flush failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
