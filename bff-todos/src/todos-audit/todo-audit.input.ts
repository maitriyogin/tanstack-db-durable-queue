import { InputType, Field } from '@nestjs/graphql';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class CreateTodoAuditInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  todoId: string;

  @Field()
  @IsIn(['added', 'updated', 'deleted'])
  action: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  changes?: string;
}
