import { Module } from '@nestjs/common';
import { TodoAuditResolver } from './todo-audit.resolver';
import { TodoAuditService } from './todo-audit.service';
import { TodosAuditDao } from './todos-audit.dao';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [IdempotencyModule],
  providers: [TodoAuditResolver, TodoAuditService, TodosAuditDao, PrismaService],
  exports: [TodoAuditService],
})
export class TodosAuditModule {}