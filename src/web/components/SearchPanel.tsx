import { useState } from 'react';
import { css } from '@linaria/core';
import { useSearch, type SearchResult } from '@/web/hooks/useSearch';

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const searchBox = css`
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const input = css`
  flex: 1;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`;

const searchBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:disabled { opacity: 0.5; }
`;

const results = css`
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
`;

const resultItem = css`
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-secondary); }
  margin-bottom: 0.25rem;
`;

const resultFile = css`
  font-size: 0.75rem;
  color: var(--haze-color-primary);
  font-family: var(--haze-font-mono);
  margin-bottom: 0.25rem;
`;

const resultLine = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  margin-bottom: 0.125rem;
`;

const resultContext = css`
  font-size: 0.8rem;
  color: var(--haze-color-text);
  font-family: var(--haze-font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--haze-color-bg-secondary);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  margin-top: 0.25rem;
`;

const emptyState = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

const highlight = css`
  background: var(--haze-color-primary);
  color: white;
  padding: 0 0.125rem;
  border-radius: 2px;
`;

interface Props {
  projectId: string;
  onFileClick?: (file: string) => void;
}

export default function SearchPanel({ projectId, onFileClick }: Props) {
  const [inputValue, setInputValue] = useState('');
  const { results: searchResults, loading, query, search, clear } = useSearch(projectId);

  const handleSearch = () => {
    if (inputValue.trim()) search(inputValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const highlightMatch = (text: string, q: string) => {
    if (!q) return text;
    const parts = text.split(new RegExp(`(${q})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === q.toLowerCase() ? <span key={i} className={highlight}>{part}</span> : part
    );
  };

  return (
    <div className={container}>
      <div className={searchBox}>
        <input
          className={input}
          placeholder="Search in project..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className={searchBtn} onClick={handleSearch} disabled={loading || !inputValue.trim()}>
          {loading ? '...' : 'Search'}
        </button>
      </div>
      <div className={results}>
        {query && searchResults.length === 0 && !loading && (
          <div className={emptyState}>No results for "{query}"</div>
        )}
        {!query && (
          <div className={emptyState}>Search across all project files</div>
        )}
        {searchResults.map((r, i) => (
          <div key={i} className={resultItem} onClick={() => onFileClick?.(r.file)}>
            <div className={resultFile}>{r.file}</div>
            <div className={resultLine}>Line {r.line}</div>
            <div className={resultContext}>{highlightMatch(r.text, query)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
