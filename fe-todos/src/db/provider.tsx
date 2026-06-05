import { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';

interface TodosDBProviderProps {
  children: ReactNode;
}

// Provider for TanStack Query which powers the TanStack DB collection
export function TodosDBProvider({ children }: TodosDBProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}