import { useState, useCallback } from 'react';

export interface SearchResult {
  file: string;
  line: number;
  text: string;
  context: string;
}

/**
 * Hook for full-text search across project files.
 */
export function useSearch(projectId: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setQuery('');
      return;
    }

    setLoading(true);
    setQuery(q);
    try {
      const res = await fetch(`/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setResults([]);
        return;
      }
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const clear = useCallback(() => {
    setResults([]);
    setQuery('');
  }, []);

  return { results, loading, query, search, clear };
}
