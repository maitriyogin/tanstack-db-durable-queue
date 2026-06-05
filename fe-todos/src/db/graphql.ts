import type {
  Todo,
  CreateTodoInput,
  UpdateTodoInput,
  TodoAudit,
  CreateTodoAuditInput,
  TodoAuditCount,
  ShoppingList,
  ShoppingListItem,
  CreateShoppingListInput,
  AddShoppingListItemInput,
  UpdateShoppingListItemInput,
  Budget,
} from './types';

const SHOPPING_LIST_ITEM_FIELDS = `
  id
  name
  quantity
  unit
  notes
  cost
  shoppingListId
  createdAt
  updatedAt
`;

const SHOPPING_LIST_FIELDS = `
  id
  name
  description
  todoId
  createdAt
  updatedAt
  items {
    id
    name
    quantity
    unit
    notes
    cost
    shoppingListId
    createdAt
    updatedAt
  }
`;

const BUDGET_FIELDS = `
  id
  total
  remaining
  shoppingListId
  createdAt
  updatedAt
`;

const GRAPHQL_ENDPOINT = 'http://localhost:4010/graphql';

async function graphqlRequest<T>(query: string, variables?: Record<string, any>): Promise<T> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables,
    }),

  });

  const json = await response.json();

  if (json.errors) {
    throw new Error(json.errors[0]?.message || 'GraphQL request failed');
  }

  return json.data;
}

export async function fetchTodos(): Promise<Todo[]> {
  const data = await graphqlRequest<{ todos: Todo[] }>(`
    query GetTodos {
      todos {
        id
        name
        description
        status
        createdAt
        updatedAt
      }
    }
  `);

  return data.todos;
}

export async function fetchTodo(id: string): Promise<Todo | null> {
  const data = await graphqlRequest<{ todo: Todo | null }>(`
    query GetTodo($id: ID!) {
      todo(id: $id) {
        id
        name
        description
        status
        createdAt
        updatedAt
      }
    }
  `, { id });

  return data.todo;
}

export async function createTodo(input: CreateTodoInput): Promise<Todo> {
  const data = await graphqlRequest<{ createTodo: Todo }>(`
    mutation CreateTodo($input: CreateTodoInput!) {
      createTodo(input: $input) {
        id
        name
        description
        status
        createdAt
        updatedAt
      }
    }
  `, { input });

  return data.createTodo;
}

export async function updateTodo(input: UpdateTodoInput): Promise<Todo> {
  const data = await graphqlRequest<{ updateTodo: Todo }>(`
    mutation UpdateTodo($input: UpdateTodoInput!) {
      updateTodo(input: $input) {
        id
        name
        description
        status
        createdAt
        updatedAt
      }
    }
  `, { input });

  return data.updateTodo;
}

export async function fetchTodoAudits(todoId: string): Promise<TodoAudit[]> {
  const data = await graphqlRequest<{ todoAudits: TodoAudit[] }>(`
    query TodoAudits($todoId: ID!) {
      todoAudits(todoId: $todoId) {
        id
        todoId
        action
        changes
        createdAt
      }
    }
  `, { todoId });

  return data.todoAudits;
}

export async function fetchAllTodoAudits(): Promise<TodoAudit[]> {
  const data = await graphqlRequest<{ allTodoAudits: TodoAudit[] }>(`
    query AllTodoAudits {
      allTodoAudits {
        id
        todoId
        action
        changes
        createdAt
      }
    }
  `);
  return data.allTodoAudits;
}

export async function fetchTodoAuditCounts(): Promise<TodoAuditCount[]> {
  const data = await graphqlRequest<{ todoAuditCounts: TodoAuditCount[] }>(`
    query TodoAuditCounts {
      todoAuditCounts {
        todoId
        count
      }
    }
  `);

  return data.todoAuditCounts;
}

export async function createTodoAudit(input: CreateTodoAuditInput): Promise<TodoAudit> {
  const data = await graphqlRequest<{ createTodoAudit: TodoAudit }>(`
    mutation CreateTodoAudit($input: CreateTodoAuditInput!) {
      createTodoAudit(input: $input) {
        id
        todoId
        action
        changes
        createdAt
      }
    }
  `, { input });

  return data.createTodoAudit;
}

export async function fetchShoppingLists(): Promise<ShoppingList[]> {
  const data = await graphqlRequest<{ shoppingLists: ShoppingList[] }>(`
    query GetShoppingLists {
      shoppingLists {
        ${SHOPPING_LIST_FIELDS}
      }
    }
  `);
  return data.shoppingLists;
}

export async function createShoppingList(input: CreateShoppingListInput): Promise<ShoppingList> {
  const data = await graphqlRequest<{ createShoppingList: ShoppingList }>(`
    mutation CreateShoppingList($input: CreateShoppingListInput!) {
      createShoppingList(input: $input) {
        ${SHOPPING_LIST_FIELDS}
      }
    }
  `, { input });
  return data.createShoppingList;
}

export async function deleteShoppingList(id: string): Promise<ShoppingList | null> {
  const data = await graphqlRequest<{ deleteShoppingList: ShoppingList | null }>(`
    mutation DeleteShoppingList($id: ID!) {
      deleteShoppingList(id: $id) {
        ${SHOPPING_LIST_FIELDS}
      }
    }
  `, { id });
  return data.deleteShoppingList;
}

export async function addShoppingListItem(
  input: AddShoppingListItemInput,
): Promise<ShoppingListItem> {
  const data = await graphqlRequest<{ addShoppingListItem: ShoppingListItem }>(`
    mutation AddShoppingListItem($input: AddShoppingListItemInput!) {
      addShoppingListItem(input: $input) {
        ${SHOPPING_LIST_ITEM_FIELDS}
      }
    }
  `, { input });
  return data.addShoppingListItem;
}

export async function updateShoppingListItem(
  input: UpdateShoppingListItemInput,
): Promise<ShoppingListItem | null> {
  const data = await graphqlRequest<{ updateShoppingListItem: ShoppingListItem | null }>(`
    mutation UpdateShoppingListItem($input: UpdateShoppingListItemInput!) {
      updateShoppingListItem(input: $input) {
        ${SHOPPING_LIST_ITEM_FIELDS}
      }
    }
  `, { input });
  return data.updateShoppingListItem;
}

export async function removeShoppingListItem(id: string): Promise<ShoppingListItem | null> {
  const data = await graphqlRequest<{ removeShoppingListItem: ShoppingListItem | null }>(`
    mutation RemoveShoppingListItem($id: ID!) {
      removeShoppingListItem(id: $id) {
        ${SHOPPING_LIST_ITEM_FIELDS}
      }
    }
  `, { id });
  return data.removeShoppingListItem;
}

export async function deleteTodo(id: string): Promise<Todo | null> {
  const data = await graphqlRequest<{ deleteTodo: Todo | null }>(`
    mutation DeleteTodo($id: ID!) {
      deleteTodo(id: $id) {
        id
        name
        description
        status
        createdAt
        updatedAt
      }
    }
  `, { id });

  return data.deleteTodo;
}

export async function createBudget(input: {
  shoppingListId: string;
  total: number;
}): Promise<Budget> {
  const data = await graphqlRequest<{ createBudget: Budget }>(
    `
      mutation CreateBudget($input: CreateBudgetInput!) {
        createBudget(input: $input) {
          ${BUDGET_FIELDS}
        }
      }
    `,
    { input },
  );
  return data.createBudget;
}

export async function fetchBudgets(): Promise<Budget[]> {
  const data = await graphqlRequest<{ budgets: Budget[] }>(`
    query Budgets {
      budgets {
        ${BUDGET_FIELDS}
      }
    }
  `);
  return data.budgets;
}

export async function decrementBudget(
  shoppingListId: string,
  amount: number,
): Promise<Budget | null> {
  const data = await graphqlRequest<{ decrementBudget: Budget | null }>(
    `
      mutation DecrementBudget($shoppingListId: ID!, $amount: Int!) {
        decrementBudget(shoppingListId: $shoppingListId, amount: $amount) {
          ${BUDGET_FIELDS}
        }
      }
    `,
    { shoppingListId, amount },
  );
  return data.decrementBudget;
}

export async function incrementBudget(
  shoppingListId: string,
  amount: number,
): Promise<Budget | null> {
  const data = await graphqlRequest<{ incrementBudget: Budget | null }>(
    `
      mutation IncrementBudget($shoppingListId: ID!, $amount: Int!) {
        incrementBudget(shoppingListId: $shoppingListId, amount: $amount) {
          ${BUDGET_FIELDS}
        }
      }
    `,
    { shoppingListId, amount },
  );
  return data.incrementBudget;
}
