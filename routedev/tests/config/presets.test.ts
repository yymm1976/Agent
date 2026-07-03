import { describe, it, expect } from 'vitest';
import { getPresetConfig, applyPreset, listPresets } from '../../src/config/presets.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('Config Presets', () => {
  describe('listPresets', () => {
    it('should return all available presets', () => {
      const presets = listPresets();
      expect(presets).toHaveLength(4);
      expect(presets.map((p) => p.id)).toEqual([
        'minimal',
        'balanced',
        'advanced',
        'research',
      ]);
    });

    it('should include name, description and useCase for each preset', () => {
      const presets = listPresets();
      presets.forEach((preset) => {
        expect(preset.id).toBeDefined();
        expect(preset.name).toBeDefined();
        expect(preset.description).toBeDefined();
        expect(preset.useCase).toBeDefined();
      });
    });
  });

  describe('getPresetConfig', () => {
    it('should return minimal config with advanced features disabled', () => {
      const config = getPresetConfig('minimal');
      expect(config.memorySystem?.enabled).toBe(false);
      expect(config.foundationProtocol?.enabled).toBe(false);
      expect(config.reasoningQualityDiagnostics?.enabled).toBe(false);
      expect(config.adversarial?.enabled).toBe(false);
    });

    it('should return balanced config as empty (no overrides)', () => {
      const config = getPresetConfig('balanced');
      expect(Object.keys(config)).toHaveLength(0);
    });

    it('should return advanced config with all features enabled', () => {
      const config = getPresetConfig('advanced');
      expect(config.memorySystem?.enabled).toBe(true);
      expect(config.foundationProtocol?.enabled).toBe(true);
      expect(config.reasoningQualityDiagnostics?.enabled).toBe(true);
      expect(config.adversarial?.enabled).toBe(true);
      expect(config.optimization?.structuredState?.enabled).toBe(true);
    });

    it('should return research config with experimental features enabled', () => {
      const config = getPresetConfig('research');
      expect(config.memorySystem?.enabled).toBe(true);
      expect(config.foundationProtocol?.enabled).toBe(true);
      expect(config.reasoningQualityDiagnostics?.enabled).toBe(true);
      expect(config.adversarial?.enabled).toBe(true);
      expect(config.adversarial?.threshold).toBe(0.7);
    });
  });

  describe('applyPreset', () => {
    it('should merge preset config with current config', () => {
      const currentConfig = { ...DEFAULT_CONFIG };
      const newConfig = applyPreset(currentConfig, 'minimal');
      expect(newConfig.memorySystem?.enabled).toBe(false);
      expect(newConfig.version).toBe(currentConfig.version);
    });

    it('should preserve custom settings not overridden by preset', () => {
      const currentConfig = {
        ...DEFAULT_CONFIG,
        general: {
          ...DEFAULT_CONFIG.general,
          language: 'en-US',
        },
      };
      const newConfig = applyPreset(currentConfig, 'advanced');
      expect(newConfig.general.language).toBe('en-US');
    });
  });
});
