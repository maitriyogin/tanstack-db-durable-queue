import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { TodoService } from './todo.service';
import { Todo } from './todo.model';
import { CreateTodoInput, UpdateTodoInput } from './todo.input';

@Resolver(() => Todo)
export class TodoResolver {
  constructor(private readonly todoService: TodoService) {}

  @Query(() => Todo, { nullable: true })
  async todo(@Args('id', { type: () => ID }) id: string): Promise<Todo | null> {
    return await this.todoService.getTodo(id);
  }

  @Query(() => [Todo])
  async todos(): Promise<Todo[]> {
    return await this.todoService.listTodos();
  }

  @Mutation(() => Todo)
  async createTodo(@Args('input') input: CreateTodoInput): Promise<Todo> {
    return await this.todoService.createTodo(input);
  }

  @Mutation(() => Todo, { nullable: true })
  async updateTodo(@Args('input') input: UpdateTodoInput): Promise<Todo | null> {
    return await this.todoService.updateTodo(input);
  }

  @Mutation(() => Todo, { nullable: true })
  async deleteTodo(@Args('id', { type: () => ID }) id: string): Promise<Todo | null> {
    return await this.todoService.deleteTodo(id);
  }
}
