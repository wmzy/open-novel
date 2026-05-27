import { existsSync, accessSync, constants } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import type { RuntimeAgentDef } from './types';

export function resolveOnPath(bin: string): string | null {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (existsSync(full)) {
        try {
          accessSync(full, constants.X_OK);
          return full;
        } catch { /* not executable */ }
      }
    }
  }
  return null;
}

export function resolveAgentExecutable(def: RuntimeAgentDef): string | null {
  const candidates = [def.bin, ...(def.fallbackBins || [])];
  for (const bin of candidates) {
    const resolved = resolveOnPath(bin);
    if (resolved) return resolved;
  }
  return null;
}
