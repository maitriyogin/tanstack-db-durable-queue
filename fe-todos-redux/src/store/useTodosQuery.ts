import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as graphql from './graphql';
import { todosActions } from './todosSlice';
import { useAppDispatch } from './hooks';
import { TODOS_QUERY_KEY } from './todosClient';

// Hook: subscribes to the TQ todos query AND lifts its result into the
// todosSlice synced cache. This is the seam that makes selectTodos work —
// without it, components would be reading from an empty store.
//
// Invalidations from the queue runner (after each ack) trigger a TQ
// refetch, which fires this effect again, which dispatches setAll, which
// updates the synced cache, which re-runs selectTodos.
export function useTodosQuery() {
  const dispatch = useAppDispatch();
  const query = useQuery({
    queryKey: TODOS_QUERY_KEY,
    queryFn: graphql.fetchTodos,
    // refetchOnReconnect by default — matches the TanStack DB version's
    // box #11 wiring for free.
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (query.isPending) {
      dispatch(todosActions.setLoading());
      return;
    }
    if (query.isError) {
      dispatch(
        todosActions.setError(
          query.error instanceof Error ? query.error.message : String(query.error),
        ),
      );
      return;
    }
    if (query.data) {
      dispatch(todosActions.setAll(query.data));
    }
  }, [dispatch, query.data, query.isError, query.isPending, query.error]);

  return query;
}
