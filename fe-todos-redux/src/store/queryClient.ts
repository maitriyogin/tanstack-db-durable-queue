import { QueryClient } from '@tanstack/react-query';

// Single TQ client for the app. The queue runner shares this instance so
// invalidations after acks reach the same caches the UI subscribes to.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reasonable defaults for a demo. Real apps tune per-query.
      staleTime: 5_000,
      retry: false,
    },
  },
});