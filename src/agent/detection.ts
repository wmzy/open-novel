import { execFile } from 'node:child_process';
import { AGENT_DEFS } from './registry';
import { resolveAgentExecutable } from './executables';
import type { DetectedAgent, RuntimeAgentDef } from './types';

function execProbe(bin: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function probe(def: RuntimeAgentDef): Promise<DetectedAgent> {
  const resolved = resolveAgentExecutable(def);
  if (!resolved) {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: false,
    };
  }
  try {
    const stdout = await execProbe(resolved, def.versionArgs);
    const version = stdout.trim().split('\n')[0] || null;
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: true,
      path: resolved,
      version,
    };
  } catch {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: false,
      path: resolved,
    };
  }
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  return Promise.all(AGENT_DEFS.map((def) => probe(def)));
}
