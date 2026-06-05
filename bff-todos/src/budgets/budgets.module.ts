import { Module } from '@nestjs/common';
import { BudgetResolver } from './budget.resolver';
import { BudgetService } from './budget.service';
import { BudgetDao } from './budget.dao';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [BudgetResolver, BudgetService, BudgetDao, PrismaService],
  exports: [BudgetService],
})
export class BudgetsModule {}