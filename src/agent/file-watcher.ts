import * as chokidar from 'chokidar';
import path from 'node:path';

export interface FileChangeEvent {
  type: 'file-changed';
  path: string;
  kind: 'add' | 'change' | 'unlink';
}

type Subscriber = (event: FileChangeEvent) => void;

interface WatcherEntry {
  watcher: chokidar.FSWatcher;
  subscribers: Set<Subscriber>;
}

const registry = new Map<string, WatcherEntry>();

/**
 * Subscribe to file changes in a project directory.
 * Returns an unsubscribe function.
 */
export function subscribe(projectDir: string, callback: Subscriber): () => void {
  const resolved = path.resolve(projectDir);

  let entry = registry.get(resolved);
  if (!entry) {
    const watcher = chokidar.watch(resolved, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    watcher.on('all', (event, filePath) => {
      const kind = event === 'add' ? 'add' : event === 'unlink' ? 'unlink' : 'change';
      const relPath = path.relative(resolved, filePath);
      for (const sub of entry!.subscribers) {
        sub({ type: 'file-changed', path: relPath, kind });
      }
    });

    entry = { watcher, subscribers: new Set() };
    registry.set(resolved, entry);
  }

  entry.subscribers.add(callback);

  return () => {
    entry!.subscribers.delete(callback);
    if (entry!.subscribers.size === 0) {
      entry!.watcher.close();
      registry.delete(resolved);
    }
  };
}
