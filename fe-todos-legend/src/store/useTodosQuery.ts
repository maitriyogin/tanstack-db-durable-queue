import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as graphql from './graphql';
import { state$ } from './state';
import { TODOS_QUERY_KEY } from './todosClient';

// Hook: subscribes to TQ todos query AND lifts results into state$. Box
// #3 is wired here — invalidations from the queue runner trigger a TQ
// refetch, which re-runs this effect, which writes setAll into the
// observable, which the computeTodos overlay re-reads.
export function useTodosQuery() {
  const query = useQuery({
    queryKey: TODOS_QUERY_KEY,
    queryFn: graphql.fetchTodos,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (query.isPending) {
      state$.todos.status.set('loading');
      state$.todos.error.set(null);
      return;
    }
    if (query.isError) {
      state$.todos.status.set('error');
      state$.todos.error.set(
        query.error instanceof Error ? query.error.message : String(query.error),
      );
      return;
    }
    if (query.data) {
      state$.todos.byId.set(
        Object.fromEntries(query.data.map((t) => [t.id, t])),
      );
      state$.todos.status.set('success');
      state$.todos.error.set(null);
    }
  }, [query.data, query.isError, query.isPending, query.error]);

  return query;
}