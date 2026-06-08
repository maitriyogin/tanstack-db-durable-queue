import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

const HEADER = 'x-client-op-id';

// Param decorator: extracts the X-Client-Op-Id header from the GraphQL
// request context. Returns `undefined` when not present, so resolvers can
// pass it straight to `IdempotencyService.guardOrReplay`.
export const ClientOpId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const gql = GqlExecutionContext.create(context);
    const ctx = gql.getContext<{
      req?: { headers?: Record<string, string | undefined> };
    }>();
    const value = ctx?.req?.headers?.[HEADER];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  },
);