import { useEffect, useRef, useCallback } from 'react';

/**
 * Hook that provides abortable fetch functionality.
 * Automatically cancels pending requests on unmount.
 */
export function useAbortableFetch() {
  const controllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  /**
   * Fetch with automatic abort on unmount or when a new request is made.
   */
  const fetchWithAbort = useCallback(async (url: string, options?: RequestInit): Promise<Response> => {
    // Abort previous request if any
    controllerRef.current?.abort();

    const controller = new AbortController();
    controllerRef.current = controller;

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    return response;
  }, []);

  /**
   * Abort the current pending request.
   */
  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { fetchWithAbort, abort };
}

/**
 * Hook that wraps useQuery with automatic abort on unmount.
 * Compatible with @tanstack/react-query.
 */
export function useQueryAbort() {
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const getSignal = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, []);

  return { getSignal };
}
