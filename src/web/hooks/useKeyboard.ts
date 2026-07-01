import { useEffect, useCallback } from 'react';

type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  description: string;
}

/**
 * Register global keyboard shortcuts.
 */
export function useKeyboard(shortcuts: Shortcut[]) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't trigger shortcuts when typing in inputs
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      // Only allow Escape in inputs
      if (e.key !== 'Escape') return;
    }

    for (const shortcut of shortcuts) {
      const ctrlMatch = shortcut.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
      const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = shortcut.alt ? e.altKey : !e.altKey;

      if (e.key === shortcut.key && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        shortcut.handler(e);
        return;
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Pre-defined shortcut handlers.
 */
export const shortcutActions = {
  /** Navigate to new project */
  newProject: () => {
    window.location.href = '/';
  },

  /** Toggle search panel */
  toggleSearch: () => {
    const event = new CustomEvent('toggle-search');
    window.dispatchEvent(event);
  },

  /** Close current panel/dialog */
  closePanel: () => {
    const event = new CustomEvent('close-panel');
    window.dispatchEvent(event);
  },

  /** Toggle preview */
  togglePreview: () => {
    const event = new CustomEvent('toggle-preview');
    window.dispatchEvent(event);
  },

  /** Save current content */
  save: () => {
    const event = new CustomEvent('save-content');
    window.dispatchEvent(event);
  },
};
