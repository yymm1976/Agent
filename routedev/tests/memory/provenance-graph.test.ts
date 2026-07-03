// tests/memory/provenance-graph.test.ts
// Phase 68 Task 2 测试：ProvenanceGraph

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProvenanceGraph,
  type TypedArtifact,
  type ArtifactType,
  type ProducingOperation,
} from '../../src/memory/provenance-graph.js';

function makeArtifact(
  id: string,
  artifactType: ArtifactType = 'decision',
  producingOperation: ProducingOperation = 'discovery',
  parentIds: string[] = [],
): TypedArtifact {
  return {
    id,
    artifactType,
    producingOperation,
    parentIds,
    content: `content-${id}`,
    timestamp: Date.now(),
    sessionId: 'session-1',
  };
}

describe('Phase 68 Task 2: ProvenanceGraph', () => {
  let graph: ProvenanceGraph;

  beforeEach(() => {
    graph = new ProvenanceGraph();
  });

  it('1. addArtifact + getArtifact basic read/write', () => {
    const a = makeArtifact('a1', 'decision', 'discovery');
    graph.addArtifact(a);
    const got = graph.getArtifact('a1');
    expect(got).toBeDefined();
    expect(got!.id).toBe('a1');
    expect(got!.artifactType).toBe('decision');
    expect(got!.content).toBe('content-a1');
  });

  it('2. getByType filter by artifact type', () => {
    graph.addArtifact(makeArtifact('d1', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('d2', 'decision', 'search'));
    graph.addArtifact(makeArtifact('p1', 'pattern', 'discovery'));
    graph.addArtifact(makeArtifact('t1', 'test-evidence', 'test'));

    const decisions = graph.getByType('decision');
    expect(decisions.length).toBe(2);
    expect(decisions.map((d) => d.id)).toEqual(expect.arrayContaining(['d1', 'd2']));

    const patterns = graph.getByType('pattern');
    expect(patterns.length).toBe(1);
    expect(patterns[0].id).toBe('p1');

    const pitfalls = graph.getByType('pitfall');
    expect(pitfalls.length).toBe(0);
  });

  it('3. addArtifact auto-creates provenance edges', () => {
    graph.addArtifact(makeArtifact('root', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('child', 'pattern', 'search', ['root']));

    const descendants = graph.getDescendants('root');
    expect(descendants.length).toBe(1);
    expect(descendants[0].id).toBe('child');
  });

  it('4. getLineage BFS ancestor query (multi-generation)', () => {
    graph.addArtifact(makeArtifact('g1', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('g2', 'pattern', 'search', ['g1']));
    graph.addArtifact(makeArtifact('g3', 'pitfall', 'review', ['g2']));

    const lineage = graph.getLineage('g3');
    const ids = lineage.map((a) => a.id);
    expect(ids).toContain('g3');
    expect(ids).toContain('g2');
    expect(ids).toContain('g1');
    expect(lineage.length).toBe(3);
  });

  it('5. getDescendants BFS descendant query', () => {
    graph.addArtifact(makeArtifact('root', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('c1', 'pattern', 'search', ['root']));
    graph.addArtifact(makeArtifact('c2', 'pitfall', 'review', ['root']));
    graph.addArtifact(makeArtifact('gc1', 'test-evidence', 'test', ['c1']));

    const descendants = graph.getDescendants('root');
    const ids = descendants.map((a) => a.id);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
    expect(ids).toContain('gc1');
    expect(descendants.length).toBe(3);
  });

  it('6. Cycle detection (A→B→A does not infinite loop)', () => {
    graph.addArtifact(makeArtifact('a', 'decision', 'discovery', ['b']));
    graph.addArtifact(makeArtifact('b', 'pattern', 'search', ['a']));

    const lineage = graph.getLineage('a');
    expect(lineage.length).toBe(2);
    expect(lineage.map((a) => a.id)).toEqual(expect.arrayContaining(['a', 'b']));

    const descendants = graph.getDescendants('a');
    expect(descendants.length).toBe(1);
    expect(descendants[0].id).toBe('b');
  });

  it('7. getSchemaSummary exports type set', () => {
    graph.addArtifact(makeArtifact('d1', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('p1', 'pattern', 'search'));
    graph.addArtifact(makeArtifact('t1', 'test-evidence', 'test'));
    graph.addArtifact(makeArtifact('d2', 'decision', 'review'));

    const summary = graph.getSchemaSummary();
    expect(summary).toContain('decision');
    expect(summary).toContain('pattern');
    expect(summary).toContain('test-evidence');
    expect(summary.length).toBe(3);
  });

  it('8. serialize + deserialize roundtrip consistency', () => {
    graph.addArtifact(makeArtifact('r1', 'decision', 'discovery'));
    graph.addArtifact(makeArtifact('r2', 'pattern', 'search', ['r1']));
    graph.addArtifact(makeArtifact('r3', 'pitfall', 'review', ['r1']));

    const serialized = graph.serialize();
    const graph2 = new ProvenanceGraph();
    graph2.deserialize(serialized);

    expect(graph2.size()).toBe(3);
    expect(graph2.getArtifact('r1')).toBeDefined();
    expect(graph2.getArtifact('r2')).toBeDefined();
    expect(graph2.getArtifact('r3')).toBeDefined();
    expect(graph2.getArtifact('r1')!.artifactType).toBe('decision');

    const descendants = graph2.getDescendants('r1');
    expect(descendants.length).toBe(2);
  });

  it('9. size() returns correct count', () => {
    expect(graph.size()).toBe(0);
    graph.addArtifact(makeArtifact('x1', 'decision', 'discovery'));
    expect(graph.size()).toBe(1);
    graph.addArtifact(makeArtifact('x2', 'pattern', 'search'));
    expect(graph.size()).toBe(2);
    graph.addArtifact(makeArtifact('x1', 'pitfall', 'review'));
    expect(graph.size()).toBe(2);
  });

  it('10. deserialize handles corrupted lines gracefully', () => {
    const corrupted = '{"id":"valid","artifactType":"decision","producingOperation":"discovery","parentIds":[],"content":"ok","timestamp":1,"sessionId":"s1"}\nnot-json\n{"id":"valid2","artifactType":"pattern","producingOperation":"search","parentIds":[],"content":"ok2","timestamp":2,"sessionId":"s1"}\n\n  \n{broken';
    graph.deserialize(corrupted);
    expect(graph.size()).toBe(2);
    expect(graph.getArtifact('valid')).toBeDefined();
    expect(graph.getArtifact('valid2')).toBeDefined();
  });
});
