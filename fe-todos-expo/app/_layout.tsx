// Polyfills must load before any module that touches crypto.randomUUID.
// expo-router runs _layout.tsx as the very first user code, so importing
// here is the right place.
import '@/polyfills';

import { Stack } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient } from '@/store/queryClient';

// Side-effect import: hydrates state$ from SQLite, registers collections,
// wires drain triggers, and kicks the cold-boot sweep once persistence
// reports loaded. Must be imported here so it runs once at app start
// (not per-screen).
import '@/store/queue';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: '#1a1a1a' },
              headerTintColor: '#fff',
              contentStyle: { backgroundColor: '#242424' },
            }}
          />
          <StatusBar style="light" />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
