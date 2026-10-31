import { loadPlugins } from './loader';
import { packagePluginsDir } from '../shared/package-root';
import type { Plugin } from './types';

let plugins: Plugin[] = [];

export function initPlugins() {
  plugins = loadPlugins(packagePluginsDir());
}

export function getPlugins(): Plugin[] {
  return plugins;
}

export function getPlugin(id: string): Plugin | null {
  return plugins.find((p) => p.id === id) || null;
}
