import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class Budget {
  @Field(() => ID)
  id: string;

  // Initial budget for the linked shopping list. Doesn't change after create.
  @Field(() => Int)
  total: number;

  // Total minus the sum of every item cost dispatched against this budget.
  @Field(() => Int)
  remaining: number;

  @Field(() => ID)
  shoppingListId: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
