import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Todo } from './types';

// Synced cache. The TanStack DB version had a synced collection that the
// query layer wrote into; here that's just a record keyed by todo id.
// Optimistic state is computed on read by overlaying the queue (see
// selectTodos in selectors.ts) — never stored here. Keeping that
// separation strict means a refetch can wipe-and-rewrite this slice
// without clobbering pending optimistic work.
export interface TodosState {
  byId: Record<string, Todo>;
  // Lifecycle of the underlying TanStack Query fetch, mirrored into Redux
  // so selectors can render loading / error states without subscribing
  // to TQ separately.
  status: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
}

const initialState: TodosState = {
  byId: {},
  status: 'idle',
  error: null,
};

const todosSlice = createSlice({
  name: 'todos',
  initialState,
  reducers: {
    // Bulk replace from a refetch. Wipes anything that was in the cache —
    // server truth is the single source for synced state.
    setAll(state, action: PayloadAction<Todo[]>) {
      state.byId = Object.fromEntries(action.payload.map((t) => [t.id, t]));
      state.status = 'success';
      state.error = null;
    },
    setLoading(state) {
      state.status = 'loading';
      state.error = null;
    },
    setError(state, action: PayloadAction<string>) {
      state.status = 'error';
      state.error = action.payload;
    },
  },
});

export const todosActions = todosSlice.actions;
export const todosReducer = todosSlice.reducer;
