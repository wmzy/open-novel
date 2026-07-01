type Listener = (event: { type: string; projectId: string; data: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Subscribe to project events.
 */
export function subscribeProjectEvents(projectId: string, callback: Listener): () => void {
  let projectListeners = listeners.get(projectId);
  if (!projectListeners) {
    projectListeners = new Set();
    listeners.set(projectId, projectListeners);
  }
  projectListeners.add(callback);

  return () => {
    projectListeners!.delete(callback);
    if (projectListeners!.size === 0) {
      listeners.delete(projectId);
    }
  };
}

/**
 * Emit a project event.
 */
export function emitProjectEvent(projectId: string, type: string, data: unknown): void {
  const projectListeners = listeners.get(projectId);
  if (!projectListeners) return;

  const event = { type, projectId, data };
  for (const listener of projectListeners) {
    try { listener(event); } catch { /* ignore listener errors */ }
  }
}
