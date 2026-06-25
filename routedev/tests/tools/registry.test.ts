// tests/tools/registry.test.ts
// ToolRegistry 单元测试

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';

describe('ToolRegistry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool = new FileReadTool();
    registry.register(tool);

    expect(registry.has('file_read')).toBe(true);
    expect(registry.get('file_read')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('should unregister tools', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    registry.unregister('file_read');

    expect(registry.has('file_read')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('should overwrite duplicate registrations', () => {
    const registry = new ToolRegistry();
    const tool1 = new FileReadTool();
    const tool2 = new FileReadTool();
    registry.register(tool1);
    registry.register(tool2);

    expect(registry.get('file_read')).toBe(tool2);
    expect(registry.size).toBe(1);
  });

  it('should list all tools', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    registry.register(new FileWriteTool());
    registry.register(new FileSearchTool());

    const tools = registry.list();
    expect(tools.length).toBe(3);
    expect(tools.map(t => t.definition.name).sort()).toEqual(['file_read', 'file_search', 'file_write']);
  });

  it('should generate function schemas', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());

    const schemas = registry.getFunctionSchemas();
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('file_read');
    expect(schemas[0].description).toContain('文件');
    expect(schemas[0].parameters).toHaveProperty('properties');
  });
});
