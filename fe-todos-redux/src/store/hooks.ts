import { useMemo, useSyncExternalStore } from 'react';
import { useSelector, type TypedUseSelectorHook } from 'react-redux';
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './store';
import { runner } from '../queue/runner';
import {
  selectQuarantineForCollection,
  selectAllQuarantine,
} from '../queue/selectors';
import { api } from '../api/api';
import type { TodoAudit } from '../api/api';
import type { QuarantineRow } from '../queue/types';

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

// Quarantine snapshot scoped to a collection. Re-renders whenever the queue
// runner notifies of a quarantine change. Uses useSyncExternalStore for
// referential stability between calls.
export function useQuarantineFor(collectionId: string): QuarantineRow[] {
  // Subscribe is stable across calls; snapshot reads from the live store.
  const subscribe = useMemo(
    () => (cb: () => void) => runner.subscribeQuarantine(cb),
    [],
  );
  const allRows = useAppSelector(selectAllQuarantine);
  return useMemo(
    () => allRows.filter((r) => r.collectionId === collectionId),
    [allRows, collectionId],
  );
}

// Count of TodoAudit rows by todoId, derived from the RTKQ cache. Memoized
// so referential identity is stable across renders that don't change inputs.
// The cache stores the raw operation response (`{ allTodoAudits: [...] }`)
// so we read `.allTodoAudits` here.
const selectAuditsData = (state: RootState) =>
  api.endpoints.getTodoAudits.select()(state).data?.allTodoAudits;

export const selectAuditCountByTodoId = createSelector(
  [selectAuditsData],
  (audits): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of (audits as TodoAudit[] | undefined) ?? []) {
      m.set(a.todoId, (m.get(a.todoId) ?? 0) + 1);
    }
    return m;
  },
);

export function useAuditCountByTodoId(): Map<string, number> {
  return useAppSelector(selectAuditCountByTodoId);
}
