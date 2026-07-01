import { useState, useCallback } from 'react';

export interface FileContent {
  path: string;
  content: string;
}

/**
 * Hook to fetch and cache file content from the project.
 */
export function useFilePreview(projectId: string) {
  const [cache, setCache] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);

  const readFile = useCallback(async (filePath: string): Promise<string | null> => {
    // Check cache first
    if (cache.has(filePath)) return cache.get(filePath)!;

    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return null;
      const data = await res.json();
      setCache((prev) => new Map(prev).set(filePath, data.content));
      return data.content;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, cache]);

  const invalidate = useCallback((filePath?: string) => {
    if (filePath) {
      setCache((prev) => {
        const next = new Map(prev);
        next.delete(filePath);
        return next;
      });
    } else {
      setCache(new Map());
    }
  }, []);

  return { readFile, invalidate, loading };
}
