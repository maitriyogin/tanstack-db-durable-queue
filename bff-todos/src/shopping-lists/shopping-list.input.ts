import { InputType, Field, Int, ID } from '@nestjs/graphql';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class CreateShoppingListItemInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  // Optional so callers that don't care about budget can omit; FE supplies
  // it when adding items via the durable queue. Defaults to 0 server-side.
  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  cost: number;
}

@InputType()
export class CreateShoppingListInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  // Optional link to a Todo so the list shows up under that todo's row.
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  todoId?: string;

  @Field(() => [CreateShoppingListItemInput], { defaultValue: [] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateShoppingListItemInput)
  items: CreateShoppingListItemInput[];
}

@InputType()
export class UpdateShoppingListInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsString()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;
}

@InputType()
export class AddShoppingListItemInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsString()
  shoppingListId: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  cost: number;
}

@InputType()
export class UpdateShoppingListItemInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsString()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}