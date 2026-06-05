export interface Todo {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  id?: string;
  name: string;
  description?: string;
  status: string;
}

export interface UpdateTodoInput {
  id: string;
  name?: string;
  description?: string;
  status?: string;
}

export type TodoAuditAction = 'added' | 'updated' | 'deleted';

export interface TodoAudit {
  id: string;
  todoId: string;
  action: TodoAuditAction;
  changes?: string | null;
  createdAt: string;
}

export interface CreateTodoAuditInput {
  todoId: string;
  action: TodoAuditAction;
  changes?: string;
}

export interface TodoAuditCount {
  todoId: string;
  count: number;
}

export interface ShoppingListItem {
  id: string;
  name: string;
  quantity: number;
  unit?: string | null;
  notes?: string | null;
  cost: number;
  shoppingListId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingList {
  id: string;
  name: string;
  description?: string | null;
  todoId?: string | null;
  items: ShoppingListItem[];
  createdAt: string;
  updatedAt: string;
}

export interface Budget {
  id: string;
  total: number;
  remaining: number;
  shoppingListId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShoppingListItemInput {
  name: string;
  quantity: number;
  unit?: string;
  notes?: string;
  cost?: number;
}

export interface CreateShoppingListInput {
  name: string;
  description?: string;
  todoId?: string;
  budgetTotal?: number;
  items: CreateShoppingListItemInput[];
}

export interface AddShoppingListItemInput {
  shoppingListId: string;
  cost?: number;
  name: string;
  quantity: number;
  unit?: string;
  notes?: string;
}

export interface UpdateShoppingListItemInput {
  id: string;
  name?: string;
  quantity?: number;
  unit?: string;
  notes?: string;
}
