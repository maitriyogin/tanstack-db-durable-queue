import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTodoAuditInput } from './todo-audit.input';
import { TodoAudit, TodoAuditCount } from './todo-audit.model';

@Injectable()
export class TodosAuditDao {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTodoAuditInput): Promise<TodoAudit> {
    return await this.prisma.todoAudit.create({
      data: {
        todoId: input.todoId,
        action: input.action,
        changes: input.changes ?? null,
      },
    });
  }

  async findByTodoId(todoId: string): Promise<TodoAudit[]> {
    return await this.prisma.todoAudit.findMany({
      where: { todoId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(): Promise<TodoAudit[]> {
    return await this.prisma.todoAudit.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async counts(): Promise<TodoAuditCount[]> {
    const grouped = await this.prisma.todoAudit.groupBy({
      by: ['todoId'],
      _count: { _all: true },
    });

    return grouped.map((row) => ({
      todoId: row.todoId,
      count: row._count._all,
    }));
  }
}
