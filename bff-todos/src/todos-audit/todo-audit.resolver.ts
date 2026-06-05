import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { TodoAuditService } from './todo-audit.service';
import { TodoAudit, TodoAuditCount } from './todo-audit.model';
import { CreateTodoAuditInput } from './todo-audit.input';

@Resolver(() => TodoAudit)
export class TodoAuditResolver {
  constructor(private readonly todoAuditService: TodoAuditService) {}

  @Query(() => [TodoAudit])
  async todoAudits(
    @Args('todoId', { type: () => ID }) todoId: string,
  ): Promise<TodoAudit[]> {
    return await this.todoAuditService.listByTodo(todoId);
  }

  // Used by the FE's offline-capable audit collection (durable queue
  // wrapper). Returns every audit row across all todos so the client can
  // hydrate its synced cache and groupBy todoId for counts.
  @Query(() => [TodoAudit])
  async allTodoAudits(): Promise<TodoAudit[]> {
    return await this.todoAuditService.listAll();
  }

  @Query(() => [TodoAuditCount])
  async todoAuditCounts(): Promise<TodoAuditCount[]> {
    return await this.todoAuditService.counts();
  }

  @Mutation(() => TodoAudit)
  async createTodoAudit(
    @Args('input') input: CreateTodoAuditInput,
  ): Promise<TodoAudit> {
    return await this.todoAuditService.createTodoAudit(input);
  }
}