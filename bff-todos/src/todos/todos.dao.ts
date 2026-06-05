import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTodoInput, UpdateTodoInput } from './todo.input';
import { Todo } from './todo.model';

@Injectable()
export class TodosDao {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateTodoInput): Promise<Todo> {
    return await this.prisma.todo.create({
      data: {
        ...input,
        description: input.description ?? '',
      },
    });
  }

  async update(id: string, data: Partial<Omit<UpdateTodoInput, 'id'>>): Promise<Todo | null> {
    return await this.prisma.todo.update({
      where: { id },
      data,
    });
  }

  async delete(id: string): Promise<Todo | null> {
    try {
      return await this.prisma.todo.delete({
        where: { id },
      });
    } catch (error: any) {
      // If record not found, return null instead of throwing
      if (error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Todo | null> {
    return await this.prisma.todo.findUnique({
      where: { id },
    });
  }

  async findAll(): Promise<Todo[]> {
    return await this.prisma.todo.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
