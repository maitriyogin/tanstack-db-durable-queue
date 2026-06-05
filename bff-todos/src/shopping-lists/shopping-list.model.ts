import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class ShoppingListItem {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => String, { nullable: true })
  unit?: string | null;

  @Field(() => String, { nullable: true })
  notes?: string | null;

  // Random per-item cost generated client-side at insert time. Whole units
  // (no decimals) so the budget arithmetic stays integer.
  @Field(() => Int)
  cost: number;

  @Field()
  shoppingListId: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class ShoppingList {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  // Optional 1:1 link to a Todo. Null for standalone lists.
  @Field(() => ID, { nullable: true })
  todoId?: string | null;

  @Field(() => [ShoppingListItem])
  items: ShoppingListItem[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
