import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { TodoService } from './todo.service';
import { Todo } from './todo.model';
import { CreateTodoInput, UpdateTodoInput } from './todo.input';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ClientOpId } from '../idempotency/client-op-id.decorator';

@Resolver(() => Todo)
export class TodoResolver {
  constructor(
    private readonly todoService: TodoService,
    private readonly idem: IdempotencyService,
  ) {}

  @Query(() => Todo, { nullable: true })
  async todo(@Args('id', { type: () => ID }) id: string): Promise<Todo | null> {
    return await this.todoService.getTodo(id);
  }

  @Query(() => [Todo])
  async todos(): Promise<Todo[]> {
    return await this.todoService.listTodos();
  }

  @Mutation(() => Todo)
  async createTodo(
    @Args('input') input: CreateTodoInput,
    @ClientOpId() opId?: string,
  ): Promise<Todo> {
    return this.idem.guardOrReplay(opId, () => this.todoService.createTodo(input));
  }

  @Mutation(() => Todo, { nullable: true })
  async updateTodo(
    @Args('input') input: UpdateTodoInput,
    @ClientOpId() opId?: string,
  ): Promise<Todo | null> {
    return this.idem.guardOrReplay(opId, () => this.todoService.updateTodo(input));
  }

  @Mutation(() => Todo, { nullable: true })
  async deleteTodo(
    @Args('id', { type: () => ID }) id: string,
    @ClientOpId() opId?: string,
  ): Promise<Todo | null> {
    return this.idem.guardOrReplay(opId, () => this.todoService.deleteTodo(id));
  }
}
