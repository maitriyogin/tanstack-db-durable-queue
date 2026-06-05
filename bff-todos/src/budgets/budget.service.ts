import { Injectable } from '@nestjs/common';
import { BudgetDao } from './budget.dao';
import { Budget } from './budget.model';
import { CreateBudgetInput } from './budget.input';

@Injectable()
export class BudgetService {
  constructor(private readonly budgetDao: BudgetDao) {}

  async createBudget(input: CreateBudgetInput): Promise<Budget> {
    return await this.budgetDao.create(input);
  }

  async listBudgets(): Promise<Budget[]> {
    return await this.budgetDao.findAll();
  }

  async getBudget(shoppingListId: string): Promise<Budget | null> {
    return await this.budgetDao.findByShoppingListId(shoppingListId);
  }

  async decrementBudget(
    shoppingListId: string,
    amount: number,
  ): Promise<Budget | null> {
    return await this.budgetDao.decrement(shoppingListId, amount);
  }

  async incrementBudget(
    shoppingListId: string,
    amount: number,
  ): Promise<Budget | null> {
    return await this.budgetDao.increment(shoppingListId, amount);
  }
}