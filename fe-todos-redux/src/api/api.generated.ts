import { baseApi } from './baseApi';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: any; output: any; }
};

export type AddShoppingListItemInput = {
  cost?: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: Scalars['Int']['input'];
  shoppingListId: Scalars['ID']['input'];
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type Budget = {
  __typename?: 'Budget';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  remaining: Scalars['Int']['output'];
  shoppingListId: Scalars['ID']['output'];
  total: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type CreateBudgetInput = {
  shoppingListId: Scalars['ID']['input'];
  total: Scalars['Int']['input'];
};

export type CreateShoppingListInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  items?: Array<CreateShoppingListItemInput>;
  name: Scalars['String']['input'];
  todoId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateShoppingListItemInput = {
  cost?: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: Scalars['Int']['input'];
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type CreateTodoAuditInput = {
  action: Scalars['String']['input'];
  changes?: InputMaybe<Scalars['String']['input']>;
  todoId: Scalars['String']['input'];
};

export type CreateTodoInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['ID']['input']>;
  name: Scalars['String']['input'];
  status: Scalars['String']['input'];
};

export type Mutation = {
  __typename?: 'Mutation';
  addShoppingListItem: ShoppingListItem;
  createBudget: Budget;
  createShoppingList: ShoppingList;
  createTodo: Todo;
  createTodoAudit: TodoAudit;
  decrementBudget?: Maybe<Budget>;
  deleteShoppingList?: Maybe<ShoppingList>;
  deleteTodo?: Maybe<Todo>;
  incrementBudget?: Maybe<Budget>;
  removeShoppingListItem?: Maybe<ShoppingListItem>;
  updateShoppingList?: Maybe<ShoppingList>;
  updateShoppingListItem?: Maybe<ShoppingListItem>;
  updateTodo?: Maybe<Todo>;
};


export type MutationAddShoppingListItemArgs = {
  input: AddShoppingListItemInput;
};


export type MutationCreateBudgetArgs = {
  input: CreateBudgetInput;
};


export type MutationCreateShoppingListArgs = {
  input: CreateShoppingListInput;
};


export type MutationCreateTodoArgs = {
  input: CreateTodoInput;
};


export type MutationCreateTodoAuditArgs = {
  input: CreateTodoAuditInput;
};


export type MutationDecrementBudgetArgs = {
  amount: Scalars['Int']['input'];
  shoppingListId: Scalars['ID']['input'];
};


export type MutationDeleteShoppingListArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteTodoArgs = {
  id: Scalars['ID']['input'];
};


export type MutationIncrementBudgetArgs = {
  amount: Scalars['Int']['input'];
  shoppingListId: Scalars['ID']['input'];
};


export type MutationRemoveShoppingListItemArgs = {
  id: Scalars['ID']['input'];
};


export type MutationUpdateShoppingListArgs = {
  input: UpdateShoppingListInput;
};


export type MutationUpdateShoppingListItemArgs = {
  input: UpdateShoppingListItemInput;
};


export type MutationUpdateTodoArgs = {
  input: UpdateTodoInput;
};

export type Query = {
  __typename?: 'Query';
  allTodoAudits: Array<TodoAudit>;
  budgetForShoppingList?: Maybe<Budget>;
  budgets: Array<Budget>;
  shoppingList?: Maybe<ShoppingList>;
  shoppingListItem?: Maybe<ShoppingListItem>;
  shoppingLists: Array<ShoppingList>;
  todo?: Maybe<Todo>;
  todoAuditCounts: Array<TodoAuditCount>;
  todoAudits: Array<TodoAudit>;
  todos: Array<Todo>;
};


export type QueryBudgetForShoppingListArgs = {
  shoppingListId: Scalars['ID']['input'];
};


export type QueryShoppingListArgs = {
  id: Scalars['ID']['input'];
};


export type QueryShoppingListItemArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTodoArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTodoAuditsArgs = {
  todoId: Scalars['ID']['input'];
};

export type ShoppingList = {
  __typename?: 'ShoppingList';
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  items: Array<ShoppingListItem>;
  name: Scalars['String']['output'];
  todoId?: Maybe<Scalars['ID']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type ShoppingListItem = {
  __typename?: 'ShoppingListItem';
  cost: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Int']['output'];
  shoppingListId: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type Todo = {
  __typename?: 'Todo';
  createdAt: Scalars['DateTime']['output'];
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type TodoAudit = {
  __typename?: 'TodoAudit';
  action: Scalars['String']['output'];
  changes?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  todoId: Scalars['String']['output'];
};

export type TodoAuditCount = {
  __typename?: 'TodoAuditCount';
  count: Scalars['Float']['output'];
  todoId: Scalars['String']['output'];
};

export type UpdateShoppingListInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateShoppingListItemInput = {
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Int']['input']>;
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateTodoInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type GetTodoAuditsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTodoAuditsQuery = { __typename?: 'Query', allTodoAudits: Array<{ __typename?: 'TodoAudit', id: string, todoId: string, action: string, changes?: string | null, createdAt: any }> };

export type CreateTodoAuditMutationVariables = Exact<{
  input: CreateTodoAuditInput;
}>;


export type CreateTodoAuditMutation = { __typename?: 'Mutation', createTodoAudit: { __typename?: 'TodoAudit', id: string, todoId: string, action: string, changes?: string | null, createdAt: any } };

export type BudgetFieldsFragment = { __typename?: 'Budget', id: string, total: number, remaining: number, shoppingListId: string, createdAt: any, updatedAt: any };

export type GetBudgetsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetBudgetsQuery = { __typename?: 'Query', budgets: Array<{ __typename?: 'Budget', id: string, total: number, remaining: number, shoppingListId: string, createdAt: any, updatedAt: any }> };

export type CreateBudgetMutationVariables = Exact<{
  input: CreateBudgetInput;
}>;


export type CreateBudgetMutation = { __typename?: 'Mutation', createBudget: { __typename?: 'Budget', id: string, total: number, remaining: number, shoppingListId: string, createdAt: any, updatedAt: any } };

export type DecrementBudgetMutationVariables = Exact<{
  shoppingListId: Scalars['ID']['input'];
  amount: Scalars['Int']['input'];
}>;


export type DecrementBudgetMutation = { __typename?: 'Mutation', decrementBudget?: { __typename?: 'Budget', id: string, total: number, remaining: number, shoppingListId: string, createdAt: any, updatedAt: any } | null };

export type IncrementBudgetMutationVariables = Exact<{
  shoppingListId: Scalars['ID']['input'];
  amount: Scalars['Int']['input'];
}>;


export type IncrementBudgetMutation = { __typename?: 'Mutation', incrementBudget?: { __typename?: 'Budget', id: string, total: number, remaining: number, shoppingListId: string, createdAt: any, updatedAt: any } | null };

export type ShoppingListItemFieldsFragment = { __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any };

export type ShoppingListFieldsFragment = { __typename?: 'ShoppingList', id: string, name: string, description?: string | null, todoId?: string | null, createdAt: any, updatedAt: any, items: Array<{ __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any }> };

export type GetShoppingListsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetShoppingListsQuery = { __typename?: 'Query', shoppingLists: Array<{ __typename?: 'ShoppingList', id: string, name: string, description?: string | null, todoId?: string | null, createdAt: any, updatedAt: any, items: Array<{ __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any }> }> };

export type CreateShoppingListMutationVariables = Exact<{
  input: CreateShoppingListInput;
}>;


export type CreateShoppingListMutation = { __typename?: 'Mutation', createShoppingList: { __typename?: 'ShoppingList', id: string, name: string, description?: string | null, todoId?: string | null, createdAt: any, updatedAt: any, items: Array<{ __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any }> } };

export type DeleteShoppingListMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeleteShoppingListMutation = { __typename?: 'Mutation', deleteShoppingList?: { __typename?: 'ShoppingList', id: string, name: string, description?: string | null, todoId?: string | null, createdAt: any, updatedAt: any, items: Array<{ __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any }> } | null };

export type AddShoppingListItemMutationVariables = Exact<{
  input: AddShoppingListItemInput;
}>;


export type AddShoppingListItemMutation = { __typename?: 'Mutation', addShoppingListItem: { __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any } };

export type UpdateShoppingListItemMutationVariables = Exact<{
  input: UpdateShoppingListItemInput;
}>;


export type UpdateShoppingListItemMutation = { __typename?: 'Mutation', updateShoppingListItem?: { __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any } | null };

export type RemoveShoppingListItemMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type RemoveShoppingListItemMutation = { __typename?: 'Mutation', removeShoppingListItem?: { __typename?: 'ShoppingListItem', id: string, name: string, quantity: number, unit?: string | null, notes?: string | null, cost: number, shoppingListId: string, createdAt: any, updatedAt: any } | null };

export type GetTodosQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTodosQuery = { __typename?: 'Query', todos: Array<{ __typename?: 'Todo', id: string, name: string, description: string, status: string, createdAt: any, updatedAt: any }> };

export type GetTodoQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type GetTodoQuery = { __typename?: 'Query', todo?: { __typename?: 'Todo', id: string, name: string, description: string, status: string, createdAt: any, updatedAt: any } | null };

export type CreateTodoMutationVariables = Exact<{
  input: CreateTodoInput;
}>;


export type CreateTodoMutation = { __typename?: 'Mutation', createTodo: { __typename?: 'Todo', id: string, name: string, description: string, status: string, createdAt: any, updatedAt: any } };

export type UpdateTodoMutationVariables = Exact<{
  input: UpdateTodoInput;
}>;


export type UpdateTodoMutation = { __typename?: 'Mutation', updateTodo?: { __typename?: 'Todo', id: string, name: string, description: string, status: string, createdAt: any, updatedAt: any } | null };

export type DeleteTodoMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type DeleteTodoMutation = { __typename?: 'Mutation', deleteTodo?: { __typename?: 'Todo', id: string, name: string, description: string, status: string, createdAt: any, updatedAt: any } | null };

export const BudgetFieldsFragmentDoc = `
    fragment BudgetFields on Budget {
  id
  total
  remaining
  shoppingListId
  createdAt
  updatedAt
}
    `;
export const ShoppingListItemFieldsFragmentDoc = `
    fragment ShoppingListItemFields on ShoppingListItem {
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
export const ShoppingListFieldsFragmentDoc = `
    fragment ShoppingListFields on ShoppingList {
  id
  name
  description
  todoId
  createdAt
  updatedAt
  items {
    ...ShoppingListItemFields
  }
}
    ${ShoppingListItemFieldsFragmentDoc}`;
export const GetTodoAuditsDocument = `
    query getTodoAudits {
  allTodoAudits {
    id
    todoId
    action
    changes
    createdAt
  }
}
    `;
export const CreateTodoAuditDocument = `
    mutation createTodoAudit($input: CreateTodoAuditInput!) {
  createTodoAudit(input: $input) {
    id
    todoId
    action
    changes
    createdAt
  }
}
    `;
export const GetBudgetsDocument = `
    query getBudgets {
  budgets {
    ...BudgetFields
  }
}
    ${BudgetFieldsFragmentDoc}`;
export const CreateBudgetDocument = `
    mutation createBudget($input: CreateBudgetInput!) {
  createBudget(input: $input) {
    ...BudgetFields
  }
}
    ${BudgetFieldsFragmentDoc}`;
export const DecrementBudgetDocument = `
    mutation decrementBudget($shoppingListId: ID!, $amount: Int!) {
  decrementBudget(shoppingListId: $shoppingListId, amount: $amount) {
    ...BudgetFields
  }
}
    ${BudgetFieldsFragmentDoc}`;
export const IncrementBudgetDocument = `
    mutation incrementBudget($shoppingListId: ID!, $amount: Int!) {
  incrementBudget(shoppingListId: $shoppingListId, amount: $amount) {
    ...BudgetFields
  }
}
    ${BudgetFieldsFragmentDoc}`;
export const GetShoppingListsDocument = `
    query getShoppingLists {
  shoppingLists {
    ...ShoppingListFields
  }
}
    ${ShoppingListFieldsFragmentDoc}`;
export const CreateShoppingListDocument = `
    mutation createShoppingList($input: CreateShoppingListInput!) {
  createShoppingList(input: $input) {
    ...ShoppingListFields
  }
}
    ${ShoppingListFieldsFragmentDoc}`;
export const DeleteShoppingListDocument = `
    mutation deleteShoppingList($id: ID!) {
  deleteShoppingList(id: $id) {
    ...ShoppingListFields
  }
}
    ${ShoppingListFieldsFragmentDoc}`;
export const AddShoppingListItemDocument = `
    mutation addShoppingListItem($input: AddShoppingListItemInput!) {
  addShoppingListItem(input: $input) {
    ...ShoppingListItemFields
  }
}
    ${ShoppingListItemFieldsFragmentDoc}`;
export const UpdateShoppingListItemDocument = `
    mutation updateShoppingListItem($input: UpdateShoppingListItemInput!) {
  updateShoppingListItem(input: $input) {
    ...ShoppingListItemFields
  }
}
    ${ShoppingListItemFieldsFragmentDoc}`;
export const RemoveShoppingListItemDocument = `
    mutation removeShoppingListItem($id: ID!) {
  removeShoppingListItem(id: $id) {
    ...ShoppingListItemFields
  }
}
    ${ShoppingListItemFieldsFragmentDoc}`;
export const GetTodosDocument = `
    query getTodos {
  todos {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
    `;
export const GetTodoDocument = `
    query getTodo($id: ID!) {
  todo(id: $id) {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
    `;
export const CreateTodoDocument = `
    mutation createTodo($input: CreateTodoInput!) {
  createTodo(input: $input) {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
    `;
export const UpdateTodoDocument = `
    mutation updateTodo($input: UpdateTodoInput!) {
  updateTodo(input: $input) {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
    `;
export const DeleteTodoDocument = `
    mutation deleteTodo($id: ID!) {
  deleteTodo(id: $id) {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
    `;

const injectedRtkApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getTodoAudits: build.query<GetTodoAuditsQuery, GetTodoAuditsQueryVariables | void>({
      query: (variables) => ({ document: GetTodoAuditsDocument, variables })
    }),
    createTodoAudit: build.mutation<CreateTodoAuditMutation, CreateTodoAuditMutationVariables>({
      query: (variables) => ({ document: CreateTodoAuditDocument, variables })
    }),
    getBudgets: build.query<GetBudgetsQuery, GetBudgetsQueryVariables | void>({
      query: (variables) => ({ document: GetBudgetsDocument, variables })
    }),
    createBudget: build.mutation<CreateBudgetMutation, CreateBudgetMutationVariables>({
      query: (variables) => ({ document: CreateBudgetDocument, variables })
    }),
    decrementBudget: build.mutation<DecrementBudgetMutation, DecrementBudgetMutationVariables>({
      query: (variables) => ({ document: DecrementBudgetDocument, variables })
    }),
    incrementBudget: build.mutation<IncrementBudgetMutation, IncrementBudgetMutationVariables>({
      query: (variables) => ({ document: IncrementBudgetDocument, variables })
    }),
    getShoppingLists: build.query<GetShoppingListsQuery, GetShoppingListsQueryVariables | void>({
      query: (variables) => ({ document: GetShoppingListsDocument, variables })
    }),
    createShoppingList: build.mutation<CreateShoppingListMutation, CreateShoppingListMutationVariables>({
      query: (variables) => ({ document: CreateShoppingListDocument, variables })
    }),
    deleteShoppingList: build.mutation<DeleteShoppingListMutation, DeleteShoppingListMutationVariables>({
      query: (variables) => ({ document: DeleteShoppingListDocument, variables })
    }),
    addShoppingListItem: build.mutation<AddShoppingListItemMutation, AddShoppingListItemMutationVariables>({
      query: (variables) => ({ document: AddShoppingListItemDocument, variables })
    }),
    updateShoppingListItem: build.mutation<UpdateShoppingListItemMutation, UpdateShoppingListItemMutationVariables>({
      query: (variables) => ({ document: UpdateShoppingListItemDocument, variables })
    }),
    removeShoppingListItem: build.mutation<RemoveShoppingListItemMutation, RemoveShoppingListItemMutationVariables>({
      query: (variables) => ({ document: RemoveShoppingListItemDocument, variables })
    }),
    getTodos: build.query<GetTodosQuery, GetTodosQueryVariables | void>({
      query: (variables) => ({ document: GetTodosDocument, variables })
    }),
    getTodo: build.query<GetTodoQuery, GetTodoQueryVariables>({
      query: (variables) => ({ document: GetTodoDocument, variables })
    }),
    createTodo: build.mutation<CreateTodoMutation, CreateTodoMutationVariables>({
      query: (variables) => ({ document: CreateTodoDocument, variables })
    }),
    updateTodo: build.mutation<UpdateTodoMutation, UpdateTodoMutationVariables>({
      query: (variables) => ({ document: UpdateTodoDocument, variables })
    }),
    deleteTodo: build.mutation<DeleteTodoMutation, DeleteTodoMutationVariables>({
      query: (variables) => ({ document: DeleteTodoDocument, variables })
    }),
  }),
});

export { injectedRtkApi as api };
export const { useGetTodoAuditsQuery, useLazyGetTodoAuditsQuery, useCreateTodoAuditMutation, useGetBudgetsQuery, useLazyGetBudgetsQuery, useCreateBudgetMutation, useDecrementBudgetMutation, useIncrementBudgetMutation, useGetShoppingListsQuery, useLazyGetShoppingListsQuery, useCreateShoppingListMutation, useDeleteShoppingListMutation, useAddShoppingListItemMutation, useUpdateShoppingListItemMutation, useRemoveShoppingListItemMutation, useGetTodosQuery, useLazyGetTodosQuery, useGetTodoQuery, useLazyGetTodoQuery, useCreateTodoMutation, useUpdateTodoMutation, useDeleteTodoMutation } = injectedRtkApi;

