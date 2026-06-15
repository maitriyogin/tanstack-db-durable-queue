import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { IdBinding } from './types';
import { bindingKey } from './types';

export interface IdBindingsState {
  byKey: Record<string, IdBinding>;
}

const initialState: IdBindingsState = { byKey: {} };

const slice = createSlice({
  name: 'idBindings',
  initialState,
  reducers: {
    add(state, action: PayloadAction<IdBinding>) {
      const k = bindingKey(action.payload.collectionId, action.payload.tempId);
      state.byKey[k] = action.payload;
    },
    clearAll(state) {
      state.byKey = {};
    },
  },
});

export const idBindingsActions = slice.actions;
export const idBindingsReducer = slice.reducer;