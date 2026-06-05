import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

@InputType()
export class CreateBudgetInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsString()
  shoppingListId: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  total: number;
}