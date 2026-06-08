import { Module } from '@nestjs/common';
import { TodoResolver } from './todo.resolver';
import { TodoService } from './todo.service';
import { TodosDao } from './todos.dao';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [IdempotencyModule],
  providers: [TodoResolver, TodoService, TodosDao, PrismaService],
  exports: [TodoService],
})
export class TodosModule {}
