import { Stack } from 'expo-router';
import { TodoList } from '@/components/TodoList';

export default function Index() {
  return (
    <>
      <Stack.Screen options={{ title: 'Todos (Expo + Legend State)' }} />
      <TodoList />
    </>
  );
}
