import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Budget } from './budget.model';
import { CreateBudgetInput } from './budget.input';

@Injectable()
export class BudgetDao {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateBudgetInput): Promise<Budget> {
    return await this.prisma.budget.create({
      data: {
        shoppingListId: input.shoppingListId,
        total: input.total,
        // remaining tracks the budget left after item deductions; on create
        // it equals the total since no items have been billed yet.
        remaining: input.total,
      },
    });
  }

  async findAll(): Promise<Budget[]> {
    return await this.prisma.budget.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByShoppingListId(shoppingListId: string): Promise<Budget | null> {
    return await this.prisma.budget.findUnique({ where: { shoppingListId } });
  }

  async decrement(
    shoppingListId: string,
    amount: number,
  ): Promise<Budget | null> {
    try {
      return await this.prisma.budget.update({
        where: { shoppingListId },
        data: { remaining: { decrement: amount } },
      });
    } catch (error: any) {
      if (error.code === 'P2025') return null;
      throw error;
    }
  }

  async increment(
    shoppingListId: string,
    amount: number,
  ): Promise<Budget | null> {
    try {
      return await this.prisma.budget.update({
        where: { shoppingListId },
        data: { remaining: { increment: amount } },
      });
    } catch (error: any) {
      if (error.code === 'P2025') return null;
      throw error;
    }
  }
}