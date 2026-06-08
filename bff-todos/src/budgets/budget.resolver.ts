import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { BudgetService } from './budget.service';
import { Budget } from './budget.model';
import { CreateBudgetInput } from './budget.input';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ClientOpId } from '../idempotency/client-op-id.decorator';

@Resolver(() => Budget)
export class BudgetResolver {
  constructor(
    private readonly budgetService: BudgetService,
    private readonly idem: IdempotencyService,
  ) {}

  @Query(() => [Budget])
  async budgets(): Promise<Budget[]> {
    return await this.budgetService.listBudgets();
  }

  @Query(() => Budget, { nullable: true })
  async budgetForShoppingList(
    @Args('shoppingListId', { type: () => ID }) shoppingListId: string,
  ): Promise<Budget | null> {
    return await this.budgetService.getBudget(shoppingListId);
  }

  @Mutation(() => Budget)
  async createBudget(
    @Args('input') input: CreateBudgetInput,
    @ClientOpId() opId?: string,
  ): Promise<Budget> {
    return this.idem.guardOrReplay(opId, () =>
      this.budgetService.createBudget(input),
    );
  }

  // Deducts an amount from the budget linked to a shopping list. Used by the
  // FE wrapper's projection on item-add.
  @Mutation(() => Budget, { nullable: true })
  async decrementBudget(
    @Args('shoppingListId', { type: () => ID }) shoppingListId: string,
    @Args('amount', { type: () => Int }) amount: number,
    @ClientOpId() opId?: string,
  ): Promise<Budget | null> {
    return this.idem.guardOrReplay(opId, () =>
      this.budgetService.decrementBudget(shoppingListId, amount),
    );
  }

  // Inverse of `decrementBudget`. Used by the FE wrapper's projection when
  // a user removes an item from a shopping list — its cost is refunded to
  // the budget's `remaining`.
  @Mutation(() => Budget, { nullable: true })
  async incrementBudget(
    @Args('shoppingListId', { type: () => ID }) shoppingListId: string,
    @Args('amount', { type: () => Int }) amount: number,
    @ClientOpId() opId?: string,
  ): Promise<Budget | null> {
    return this.idem.guardOrReplay(opId, () =>
      this.budgetService.incrementBudget(shoppingListId, amount),
    );
  }
}
