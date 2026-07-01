import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for file name autocomplete when user types @ in the input.
 */
export function useFileAutocomplete(projectId: string | undefined) {
  const [files, setFiles] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<number | null>(null);

  // Load file list on mount
  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/files/list`)
      .then((res) => res.json())
      .then((data) => setFiles(data.files || []))
      .catch(() => {});
  }, [projectId]);

  /**
   * Check if input has an active @ mention and update suggestions.
   */
  const checkMention = useCallback((value: string, cursorPos: number) => {
    // Find the last @ before cursor
    const beforeCursor = value.slice(0, cursorPos);
    const lastAt = beforeCursor.lastIndexOf('@');

    if (lastAt === -1) {
      setShowSuggestions(false);
      setMentionStart(null);
      return;
    }

    // Check there's no space between @ and cursor (single word mention)
    const afterAt = beforeCursor.slice(lastAt + 1);
    if (afterAt.includes(' ') || afterAt.includes('\n')) {
      setShowSuggestions(false);
      setMentionStart(null);
      return;
    }

    // Filter files by the text after @
    const query = afterAt.toLowerCase();
    const filtered = files.filter((f) => f.toLowerCase().includes(query)).slice(0, 10);

    if (filtered.length === 0) {
      setShowSuggestions(false);
      setMentionStart(null);
      return;
    }

    setSuggestions(filtered);
    setShowSuggestions(true);
    setSelectedIndex(0);
    setMentionStart(lastAt);
  }, [files]);

  /**
   * Complete the mention with the selected file.
   */
  const completeMention = useCallback((value: string, cursorPos: number, file: string): { value: string; cursorPos: number } | null => {
    if (mentionStart === null) return null;

    const before = value.slice(0, mentionStart);
    const after = value.slice(cursorPos);
    const newValue = `${before}@${file} ${after}`;
    const newCursorPos = mentionStart + file.length + 2;

    setShowSuggestions(false);
    setMentionStart(null);

    return { value: newValue, cursorPos: newCursorPos };
  }, [mentionStart]);

  return {
    suggestions,
    showSuggestions,
    selectedIndex,
    setSelectedIndex,
    checkMention,
    completeMention,
    setShowSuggestions,
  };
}
