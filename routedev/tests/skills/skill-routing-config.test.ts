// tests/skills/skill-routing-config.test.ts
import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('skillRouting config schema', () => {
  it('默认配置解析通过，总开关默认 true', () => {
    const parsed = AppConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skillRouting.enabled).toBe(true);
    }
  });

  it('所有子开关默认 true', () => {
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG);
    const sr = parsed.skillRouting;
    expect(sr.sad.enabled).toBe(true);
    expect(sr.biEncoder.enabled).toBe(true);
    expect(sr.granularityAudit.enabled).toBe(true);
    expect(sr.compatibilityScorer.enabled).toBe(true);
    expect(sr.contextOptimizer.enabled).toBe(true);
  });

  it('SAD 默认参数符合论文值（tau=0.6，maxIter=1）', () => {
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.skillRouting.sad.convergenceTau).toBeCloseTo(0.6);
    expect(parsed.skillRouting.sad.maxIterations).toBe(1);
    expect(parsed.skillRouting.sad.inputSideFeedback).toBe(true);
  });

  it('biEncoder 默认模型 ID 为 all-MiniLM-L6-v2', () => {
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.skillRouting.biEncoder.modelId).toContain('all-MiniLM-L6-v2');
    expect(parsed.skillRouting.biEncoder.backend).toBe('memory');
  });

  it('compatibilityScorer 权重默认值之和约为 1', () => {
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG);
    const w = parsed.skillRouting.compatibilityScorer.weights;
    expect(w.ioType + w.categoryJaccard + w.keywordCoOccur).toBeCloseTo(1.0);
  });

  it('contextOptimizer 默认 maxTokens=1200（接近论文 1160）', () => {
    const parsed = AppConfigSchema.parse(DEFAULT_CONFIG);
    expect(parsed.skillRouting.contextOptimizer.maxTokens).toBe(1200);
  });

  it('SAD maxIterations 边界：超过 5 时 parse 失败', () => {
    const cfg = { ...DEFAULT_CONFIG, skillRouting: { ...DEFAULT_CONFIG.skillRouting, sad: { enabled: true, maxIterations: 99, convergenceTau: 0.6, inputSideFeedback: true } } };
    const result = AppConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('biEncoder topK 边界：0 时 parse 失败', () => {
    const cfg = { ...DEFAULT_CONFIG, skillRouting: { ...DEFAULT_CONFIG.skillRouting, biEncoder: { ...DEFAULT_CONFIG.skillRouting.biEncoder, topK: 0 } } };
    const result = AppConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it('空对象 skillRouting 通过 preprocess 填充默认值', () => {
    const cfg = { ...DEFAULT_CONFIG, skillRouting: {} };
    const result = AppConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillRouting.enabled).toBe(false);
    }
  });
});
