import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { IncrementalExtractor } from '../../src/memory/incremental-extractor.js';
import { HybridRetriever } from '../../src/memory/hybrid-retriever.js';
import { CheckpointPipeline } from '../../src/policies/checkpoint-pipeline.js';
import { CallOwnerCoordinator } from '../../src/policies/call-owner-coordinator.js';
import { MICrossScorer } from '../../src/evaluation/mi-cross-scorer.js';
import { SNRAwareFilter } from '../../src/agent/snr-aware-filter.js';
import { EpistemicTokenProtector } from '../../src/agent/epistemic-token-protector.js';

describe('Phase 65-67 Integration Tests', () => {
  describe('Phase 65: Memory System', () => {
    it('should instantiate MemoryStore successfully', () => {
      const memoryStore = new MemoryStore({
        enabled: true,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      expect(memoryStore).toBeDefined();
    });

    it('should instantiate IncrementalExtractor with MemoryStore', () => {
      const memoryStore = new MemoryStore({
        enabled: true,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      const extractor = new IncrementalExtractor(memoryStore, {
        enabled: true,
        mode: 'diff',
        modelId: 'test-model',
      });
      expect(extractor).toBeDefined();
    });

    it('should instantiate HybridRetriever with MemoryStore', () => {
      const memoryStore = new MemoryStore({
        enabled: true,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      const retriever = new HybridRetriever(memoryStore, null, {
        enabled: true,
        bm25Weight: 0.5,
        embeddingWeight: 0.3,
        timeDecayHalfLifeDays: 30,
        topK: 10,
      });
      expect(retriever).toBeDefined();
    });
  });

  describe('Phase 66: Foundation Protocol', () => {
    it('should instantiate CheckpointPipeline successfully', () => {
      const pipeline = new CheckpointPipeline(
        {
          enabled: true,
          enabledSegments: ['pre', 'post'] as any,
          shortCircuit: true,
        },
        () => true,
      );
      expect(pipeline).toBeDefined();
    });

    it('should instantiate CallOwnerCoordinator successfully', () => {
      const coordinator = new CallOwnerCoordinator({
        enabled: true,
        syncWaitMs: 100,
        persistPath: '/tmp/test-coordinator.json',
      });
      expect(coordinator).toBeDefined();
    });
  });

  describe('Phase 67: Reasoning Quality Diagnostics', () => {
    it('should instantiate MICrossScorer successfully', () => {
      const scorer = new MICrossScorer({
        enabled: true,
        collapseThreshold: 0.9,
        minPrompts: 3,
        samplesPerPrompt: 4,
      });
      expect(scorer).toBeDefined();
    });

    it('should instantiate SNRAwareFilter successfully', () => {
      const filter = new SNRAwareFilter({
        enabled: true,
        topP: 0.9,
        minRVThreshold: 0.01,
        batchRejectRatio: 0.7,
      });
      expect(filter).toBeDefined();
    });

    it('should instantiate EpistemicTokenProtector successfully', () => {
      const protector = new EpistemicTokenProtector({
        enabled: true,
        neighborhoodLines: 3,
        customTokens: ['test1', 'test2'],
      });
      expect(protector).toBeDefined();
    });
  });

  describe('Cross-Phase Integration', () => {
    it('should instantiate all Phase 65-67 core modules', () => {
      // Phase 65
      const memoryStore = new MemoryStore({
        enabled: true,
        dbPath: ':memory:',
        backend: 'sqlite',
        embeddingProvider: 'none',
      });
      
      // Phase 66
      const checkpointPipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: ['pre'] as any, shortCircuit: true },
        () => true,
      );
      
      // Phase 67
      const miCrossScorer = new MICrossScorer({
        enabled: true,
        collapseThreshold: 0.9,
        minPrompts: 3,
        samplesPerPrompt: 4,
      });

      expect(memoryStore).toBeDefined();
      expect(checkpointPipeline).toBeDefined();
      expect(miCrossScorer).toBeDefined();
    });
  });
});
