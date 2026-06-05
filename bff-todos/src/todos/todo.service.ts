import { ForbiddenException, Injectable } from '@nestjs/common';
import { TodosDao } from './todos.dao';
import { CreateTodoInput, UpdateTodoInput } from './todo.input';
import { Todo } from './todo.model';

// Test trigger: any todo whose name contains "XXX" is rejected with a
// fixed-code GraphQL error. Exists so the FE durable-queue UX (retry /
// discard / cascade quarantine) can be exercised against a real server
// failure without taking the BFF offline.
const FORBIDDEN_NAME_TOKEN = 'XXX';
function assertNameAllowed(name: string | undefined) {
  if (name && name.includes(FORBIDDEN_NAME_TOKEN)) {
    throw new ForbiddenException({
      code: 'FORBIDDEN_NAME',
      message: `Todo name cannot contain "${FORBIDDEN_NAME_TOKEN}"`,
    });
  }
}

@Injectable()
export class TodoService {
  constructor(private readonly todosDao: TodosDao) {}

  async createTodo(input: CreateTodoInput): Promise<Todo> {
    assertNameAllowed(input.name);
    return await this.todosDao.create(input);
  }

  async updateTodo(input: UpdateTodoInput): Promise<Todo | null> {
    assertNameAllowed(input.name);
    const { id, ...data } = input;
    return await this.todosDao.update(id, data);
  }

  async deleteTodo(id: string): Promise<Todo | null> {
    return await this.todosDao.delete(id);
  }

  async getTodo(id: string): Promise<Todo | null> {
    return await this.todosDao.findById(id);
  }

  async listTodos(): Promise<Todo[]> {
    return await this.todosDao.findAll();
  }
}
