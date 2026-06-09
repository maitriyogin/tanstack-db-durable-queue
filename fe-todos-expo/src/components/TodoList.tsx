import { useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSelector } from '@legendapp/state/react';
import { state$ } from '@/store/state';
import { useTodosQuery } from '@/store/useTodosQuery';
import { mutationQueue } from '@/store/queue';
import {
  addTodo,
  aliasFor,
  computeQuarantineByRowId,
  computeQueueDepth,
  computeTodos,
  deleteTodo,
  updateTodo,
} from '@/store/todosClient';
import type { Todo } from '@/store/types';

// Mirror of fe-todos-legend's TodoList, ported to RN primitives. Same
// reactivity model: useSelector(() => compute…()) for the overlay,
// queue depth, status, quarantine map. The quarantine band is rendered
// inside each row when the row id appears in the quarantineByRowId map.
export function TodoList() {
  // Drives the TQ effect that hydrates state$.todos.byId.
  useTodosQuery();
  const insets = useSafeAreaInsets();

  const todos = useSelector(() => computeTodos());
  const status = useSelector(() => state$.todos.status.get());
  const error = useSelector(() => state$.todos.error.get());
  const queueDepth = useSelector(() => computeQueueDepth());
  const quarantineByRowId = useSelector(() => computeQuarantineByRowId());
  const aliases = useSelector(() => todos.map((t) => aliasFor(t.id)));

  const [name, setName] = useState('');

  function onAdd() {
    if (!name.trim()) return;
    void addTodo(mutationQueue, {
      name: name.trim(),
      description: '',
      status: 'PENDING',
    }).promise.catch((err) => console.warn('addTodo failed:', err));
    setName('');
  }

  function onToggle(todo: Todo) {
    const next = todo.status === 'PENDING' ? 'COMPLETED' : 'PENDING';
    void updateTodo(mutationQueue, todo.id, { status: next }, todo).catch(
      (err) => console.warn('updateTodo failed:', err),
    );
  }

  function onDelete(todo: Todo) {
    void deleteTodo(mutationQueue, todo.id, todo).catch((err) =>
      console.warn('deleteTodo failed:', err),
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Todos</Text>
        <Text style={styles.subtitle}>
          {status === 'loading' ? 'loading…' : `queue: ${queueDepth}`}
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="New todo…"
          placeholderTextColor="#777"
          onSubmitEditing={onAdd}
          returnKeyType="done"
        />
        <Pressable onPress={onAdd} style={styles.addButton}>
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      </View>

      <FlatList
        data={todos}
        keyExtractor={(_, i) => aliases[i] ?? String(i)}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          status !== 'loading' ? (
            <Text style={styles.emptyText}>No todos yet.</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const failed = quarantineByRowId.get(item.id);
          return (
            <View
              style={[
                styles.row,
                failed ? styles.rowFailed : null,
              ]}
            >
              <View style={styles.rowMain}>
                <Switch
                  value={item.status === 'COMPLETED'}
                  onValueChange={() => onToggle(item)}
                />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text
                    style={[
                      styles.rowText,
                      item.status === 'COMPLETED' && styles.rowTextDone,
                    ]}
                  >
                    {item.name}
                    {item.id.startsWith('temp_') && !failed ? (
                      <Text style={styles.pendingBadge}> (pending)</Text>
                    ) : null}
                  </Text>
                </View>
                <Pressable onPress={() => onDelete(item)} hitSlop={8}>
                  <Text style={styles.deleteX}>✕</Text>
                </Pressable>
              </View>
              {failed ? (
                <View style={styles.failedBand}>
                  <Text style={styles.failedText}>
                    ⚠ {failed.quarantineError ?? 'Failed'}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable
                      onPress={() =>
                        mutationQueue.retryCascade(failed.correlationKey)
                      }
                      style={styles.retryButton}
                    >
                      <Text style={styles.retryButtonText}>Retry</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        mutationQueue.discardCascade(failed.correlationKey)
                      }
                      style={styles.discardButton}
                    >
                      <Text style={styles.discardButtonText}>Discard</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#242424', padding: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { fontSize: 24, fontWeight: '600', color: '#fff' },
  subtitle: { fontSize: 13, color: '#aaa' },
  errorBox: {
    backgroundColor: '#3a0c0c',
    borderColor: '#a33',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 8,
    borderRadius: 6,
    marginBottom: 12,
  },
  errorText: { color: '#fff', fontSize: 13 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderColor: '#444',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#fff',
  },
  addButton: {
    backgroundColor: '#1d4ed8',
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 6,
  },
  addButtonText: { color: '#fff', fontWeight: '600' },
  row: {
    backgroundColor: '#1a1a1a',
    borderColor: '#333',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
  },
  rowFailed: { borderColor: '#dc2626' },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowText: { color: '#fff' },
  rowTextDone: { color: '#888', textDecorationLine: 'line-through' },
  pendingBadge: { color: '#ca8a04', fontSize: 12 },
  deleteX: { color: '#ef4444', paddingHorizontal: 8 },
  failedBand: {
    backgroundColor: '#450a0a',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#7f1d1d',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  failedText: { flex: 1, color: '#fecaca', fontSize: 13 },
  retryButton: {
    backgroundColor: '#991b1b',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  retryButtonText: { color: '#fff', fontSize: 12 },
  discardButton: {
    backgroundColor: '#374151',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  discardButtonText: { color: '#fff', fontSize: 12 },
  emptyText: { color: '#888', textAlign: 'center', paddingVertical: 32 },
});
