import { useState, useCallback, useRef } from 'react';

interface DragDropOptions {
  accept?: string[];
  onDrop?: (files: File[]) => void;
}

/**
 * Hook for drag and drop file uploads.
 */
export function useDragDrop(options: DragDropOptions = {}) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files);

    // Filter by accepted types
    const accepted = options.accept
      ? files.filter((f) => options.accept!.some((ext) => f.name.endsWith(ext)))
      : files;

    if (accepted.length > 0) {
      options.onDrop?.(accepted);
    }
  }, [options]);

  return {
    isDragging,
    dragProps: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  };
}

/**
 * Upload a file to the project.
 */
export async function uploadFile(projectId: string, file: File, targetPath: string): Promise<boolean> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('path', targetPath);

  try {
    const res = await fetch(`/api/projects/${projectId}/upload`, {
      method: 'POST',
      body: formData,
    });
    return res.ok;
  } catch {
    return false;
  }
}
