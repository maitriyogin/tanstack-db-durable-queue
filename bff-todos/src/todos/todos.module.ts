import { Module } from '@nestjs/common';
import { TodoResolver } from './todo.resolver';
import { TodoService } from './todo.service';
import { TodosDao } from './todos.dao';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [TodoResolver, TodoService, TodosDao, PrismaService],
  exports: [TodoService],
})
export class TodosModule {}
