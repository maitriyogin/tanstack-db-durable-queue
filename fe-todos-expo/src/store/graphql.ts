import type { CreateTodoInput, Todo, UpdateTodoInput } from './types';

// On RN `localhost` resolves to the device, not the dev machine. Pass
// EXPO_PUBLIC_BFF_URL when starting the app on a physical device or an
// Android emulator. iOS simulator can use localhost. Examples:
//   iOS sim:        EXPO_PUBLIC_BFF_URL=http://localhost:4010/graphql
//   Android emu:    EXPO_PUBLIC_BFF_URL=http://10.0.2.2:4010/graphql
//   Physical:       EXPO_PUBLIC_BFF_URL=http://192.168.1.42:4010/graphql
//   Tunnel:         EXPO_PUBLIC_BFF_URL=https://<your-tunnel>.ngrok.io/graphql
const GRAPHQL_ENDPOINT =
  process.env.EXPO_PUBLIC_BFF_URL ?? 'http://localhost:4010/graphql';

// `clientOpId` (when set) becomes the X-Client-Op-Id header. The BFF's
// IdempotencyService dedupes against it so retries return the cached
// response instead of re-running the resolver.
async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  clientOpId?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (clientOpId) headers['X-Client-Op-Id'] = clientOpId;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) {
    throw new Error(json.errors[0]?.message || 'GraphQL request failed');
  }
  return json.data;
}

const TODO_FIELDS = `
  id
  name
  description
  status
  createdAt
  updatedAt
`;

export async function fetchTodos(): Promise<Todo[]> {
  const data = await graphqlRequest<{ todos: Todo[] }>(`
    query GetTodos { todos { ${TODO_FIELDS} } }
  `);
  return data.todos;
}

export async function createTodo(
  input: CreateTodoInput,
  clientOpId?: string,
): Promise<Todo> {
  const data = await graphqlRequest<{ createTodo: Todo }>(
    `mutation CreateTodo($input: CreateTodoInput!) {
       createTodo(input: $input) { ${TODO_FIELDS} }
     }`,
    { input },
    clientOpId,
  );
  return data.createTodo;
}

export async function updateTodo(
  input: UpdateTodoInput,
  clientOpId?: string,
): Promise<Todo> {
  const data = await graphqlRequest<{ updateTodo: Todo }>(
    `mutation UpdateTodo($input: UpdateTodoInput!) {
       updateTodo(input: $input) { ${TODO_FIELDS} }
     }`,
    { input },
    clientOpId,
  );
  return data.updateTodo;
}

export async function deleteTodo(
  id: string,
  clientOpId?: string,
): Promise<Todo | null> {
  const data = await graphqlRequest<{ deleteTodo: Todo | null }>(
    `mutation DeleteTodo($id: ID!) {
       deleteTodo(id: $id) { ${TODO_FIELDS} }
     }`,
    { id },
    clientOpId,
  );
  return data.deleteTodo;
}
