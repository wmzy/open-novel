import { describe, it, expect } from 'vitest';
import { loadPlugins } from '@/plugins/loader';
import path from 'node:path';

describe('loadPlugins', () => {
  it('loads plugins from directory', () => {
    const plugins = loadPlugins(path.resolve('./plugins'));
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0]).toHaveProperty('id');
    expect(plugins[0]).toHaveProperty('manifest');
    expect(plugins[0]).toHaveProperty('skillContent');
  });

  it('returns empty for missing directory', () => {
    expect(loadPlugins('/nonexistent')).toEqual([]);
  });
});
