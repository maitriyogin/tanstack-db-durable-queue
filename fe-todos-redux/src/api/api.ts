// Public api surface. Endpoints + per-operation types are codegen-emitted
// from .graphql operation files (see codegen.ts → src/api/api.generated.ts);
// the schema input types come from the same generated file.
//
// We layer two things on top of the generated injection:
// 1. `providesTags` / `invalidatesTags` for cache-tag wiring.
// 2. Mutation args extended with an optional `clientOpId`. The codegen
//    plugin doesn't know about our X-Client-Op-Id header, so each mutation
//    is re-injected with `overrideExisting: true` and a wrapping `query`
//    that pulls `clientOpId` out of the arg before passing the rest to
//    the original document. The base query reads `clientOpId` directly
//    from the body shape and sets the header.
import { api as injectedApi } from './api.generated';
import * as G from './api.generated';

type WithClientOpId<T> = T & { clientOpId?: string };

// Strip `clientOpId` from the arg, return it on the body so the base
// query can lift it into a header. The original document is reused
// from the codegen module so the request stays type-safe.
function withClientOpId<TArg extends { clientOpId?: string }>(
  document: string,
  arg: TArg,
): { document: string; variables: Omit<TArg, 'clientOpId'>; clientOpId?: string } {
  const { clientOpId, ...variables } = arg;
  return { document, variables, clientOpId };
}

const apiWithIdempotency = injectedApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    createTodo: build.mutation<G.CreateTodoMutation, WithClientOpId<G.CreateTodoMutationVariables>>({
      query: (arg) => withClientOpId(G.CreateTodoDocument, arg),
    }),
    updateTodo: build.mutation<G.UpdateTodoMutation, WithClientOpId<G.UpdateTodoMutationVariables>>({
      query: (arg) => withClientOpId(G.UpdateTodoDocument, arg),
    }),
    deleteTodo: build.mutation<G.DeleteTodoMutation, WithClientOpId<G.DeleteTodoMutationVariables>>({
      query: (arg) => withClientOpId(G.DeleteTodoDocument, arg),
    }),
    createTodoAudit: build.mutation<
      G.CreateTodoAuditMutation,
      WithClientOpId<G.CreateTodoAuditMutationVariables>
    >({ query: (arg) => withClientOpId(G.CreateTodoAuditDocument, arg) }),
    createShoppingList: build.mutation<
      G.CreateShoppingListMutation,
      WithClientOpId<G.CreateShoppingListMutationVariables>
    >({ query: (arg) => withClientOpId(G.CreateShoppingListDocument, arg) }),
    deleteShoppingList: build.mutation<
      G.DeleteShoppingListMutation,
      WithClientOpId<G.DeleteShoppingListMutationVariables>
    >({ query: (arg) => withClientOpId(G.DeleteShoppingListDocument, arg) }),
    addShoppingListItem: build.mutation<
      G.AddShoppingListItemMutation,
      WithClientOpId<G.AddShoppingListItemMutationVariables>
    >({ query: (arg) => withClientOpId(G.AddShoppingListItemDocument, arg) }),
    updateShoppingListItem: build.mutation<
      G.UpdateShoppingListItemMutation,
      WithClientOpId<G.UpdateShoppingListItemMutationVariables>
    >({ query: (arg) => withClientOpId(G.UpdateShoppingListItemDocument, arg) }),
    removeShoppingListItem: build.mutation<
      G.RemoveShoppingListItemMutation,
      WithClientOpId<G.RemoveShoppingListItemMutationVariables>
    >({ query: (arg) => withClientOpId(G.RemoveShoppingListItemDocument, arg) }),
    createBudget: build.mutation<
      G.CreateBudgetMutation,
      WithClientOpId<G.CreateBudgetMutationVariables>
    >({ query: (arg) => withClientOpId(G.CreateBudgetDocument, arg) }),
    decrementBudget: build.mutation<
      G.DecrementBudgetMutation,
      WithClientOpId<G.DecrementBudgetMutationVariables>
    >({ query: (arg) => withClientOpId(G.DecrementBudgetDocument, arg) }),
    incrementBudget: build.mutation<
      G.IncrementBudgetMutation,
      WithClientOpId<G.IncrementBudgetMutationVariables>
    >({ query: (arg) => withClientOpId(G.IncrementBudgetDocument, arg) }),
  }),
});

export const api = apiWithIdempotency.enhanceEndpoints({
  endpoints: {
    getTodos: { providesTags: [{ type: 'Todos', id: 'LIST' }] },
    getTodo: {
      providesTags: (result) =>
        result?.todo ? [{ type: 'Todos', id: result.todo.id }] : [],
    },
    getTodoAudits: { providesTags: [{ type: 'TodoAudits', id: 'LIST' }] },
    getShoppingLists: { providesTags: [{ type: 'ShoppingLists', id: 'LIST' }] },
    getBudgets: { providesTags: [{ type: 'Budgets', id: 'LIST' }] },
  },
});

// Hooks re-exported from the generated module — components import from
// './api' so the codegen file stays an implementation detail.
export {
  useGetTodosQuery,
  useGetTodoQuery,
  useGetTodoAuditsQuery,
  useGetShoppingListsQuery,
  useGetBudgetsQuery,
  useCreateTodoMutation,
  useUpdateTodoMutation,
  useDeleteTodoMutation,
  useCreateTodoAuditMutation,
  useCreateShoppingListMutation,
  useDeleteShoppingListMutation,
  useAddShoppingListItemMutation,
  useUpdateShoppingListItemMutation,
  useRemoveShoppingListItemMutation,
  useCreateBudgetMutation,
  useDecrementBudgetMutation,
  useIncrementBudgetMutation,
} from './api.generated';

// Schema types re-exported as the public types surface, replacing the
// hand-rolled api/types.ts.
export type {
  Todo,
  Budget,
  ShoppingList,
  ShoppingListItem,
  TodoAudit,
  CreateTodoInput,
  UpdateTodoInput,
  CreateTodoAuditInput,
  CreateShoppingListInput,
  CreateShoppingListItemInput,
  AddShoppingListItemInput,
  UpdateShoppingListItemInput,
  CreateBudgetInput,
} from './api.generated';
