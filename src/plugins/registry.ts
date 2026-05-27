import path from 'node:path';
import { loadPlugins } from './loader';
import type { Plugin } from './types';

let plugins: Plugin[] = [];

export function initPlugins() {
  const dir = path.resolve(process.cwd(), 'plugins');
  plugins = loadPlugins(dir);
}

export function getPlugins(): Plugin[] {
  return plugins;
}

export function getPlugin(id: string): Plugin | null {
  return plugins.find((p) => p.id === id) || null;
}
