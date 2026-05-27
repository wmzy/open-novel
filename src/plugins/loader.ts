import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, PluginManifest } from './types';

export function loadPlugins(dir: string): Plugin[] {
  if (!existsSync(dir)) return [];
  const plugins: Plugin[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'open-novel.json');
    const skillPath = path.join(pluginDir, 'SKILL.md');
    if (!existsSync(manifestPath) || !existsSync(skillPath)) continue;
    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const skillContent = readFileSync(skillPath, 'utf-8');
      plugins.push({ id: manifest.id, manifest, skillContent, path: pluginDir });
    } catch { /* skip invalid plugins */ }
  }
  return plugins;
}
