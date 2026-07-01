import { useState, useEffect, useCallback } from 'react';

export interface FileChangeEvent {
  type: 'file-changed';
  path: string;
  kind: 'add' | 'change' | 'unlink';
}

/**
 * Subscribe to real-time file change events for a project.
 */
export function useProjectFiles(projectId: string | undefined) {
  const [changes, setChanges] = useState<FileChangeEvent[]>([]);
  const [connected, setConnected] = useState(false);

  const clearChanges = useCallback(() => setChanges([]), []);

  useEffect(() => {
    if (!projectId) return;

    const es = new EventSource(`/api/projects/${projectId}/events`);

    es.onopen = () => setConnected(true);

    es.addEventListener('file-changed', (e) => {
      const event = JSON.parse(e.data) as FileChangeEvent;
      setChanges((prev) => [...prev.slice(-99), event]); // keep last 100
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
    };

    return () => es.close();
  }, [projectId]);

  return { changes, connected, clearChanges };
}
