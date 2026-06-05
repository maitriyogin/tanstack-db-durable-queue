import { Injectable } from '@nestjs/common';
import { TodosAuditDao } from './todos-audit.dao';
import { CreateTodoAuditInput } from './todo-audit.input';
import { TodoAudit, TodoAuditCount } from './todo-audit.model';

@Injectable()
export class TodoAuditService {
  constructor(private readonly todosAuditDao: TodosAuditDao) {}

  async createTodoAudit(input: CreateTodoAuditInput): Promise<TodoAudit> {
    return await this.todosAuditDao.create(input);
  }

  async listByTodo(todoId: string): Promise<TodoAudit[]> {
    return await this.todosAuditDao.findByTodoId(todoId);
  }

  async listAll(): Promise<TodoAudit[]> {
    return await this.todosAuditDao.findAll();
  }

  async counts(): Promise<TodoAuditCount[]> {
    return await this.todosAuditDao.counts();
  }
}
