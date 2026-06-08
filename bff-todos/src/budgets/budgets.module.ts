import { Module } from '@nestjs/common';
import { BudgetResolver } from './budget.resolver';
import { BudgetService } from './budget.service';
import { BudgetDao } from './budget.dao';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [IdempotencyModule],
  providers: [BudgetResolver, BudgetService, BudgetDao, PrismaService],
  exports: [BudgetService],
})
export class BudgetsModule {}