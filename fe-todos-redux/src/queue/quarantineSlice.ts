import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { QuarantineRow } from './types';

export interface QuarantineState {
  ops: Record<string, QuarantineRow>;
}

const initialState: QuarantineState = { ops: {} };

const slice = createSlice({
  name: 'quarantine',
  initialState,
  reducers: {
    quarantineOp(state, action: PayloadAction<QuarantineRow>) {
      state.ops[action.payload.id] = action.payload;
    },
    quarantineMany(state, action: PayloadAction<QuarantineRow[]>) {
      for (const row of action.payload) state.ops[row.id] = row;
    },
    dropRows(state, action: PayloadAction<string[]>) {
      for (const id of action.payload) delete state.ops[id];
    },
    clearAll(state) {
      state.ops = {};
    },
  },
});

export const quarantineActions = slice.actions;
export const quarantineReducer = slice.reducer;
