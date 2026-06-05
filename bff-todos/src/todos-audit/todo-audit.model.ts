import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class TodoAudit {
  @Field(() => ID)
  id: string;

  @Field()
  todoId: string;

  @Field()
  action: string;

  @Field(() => String, { nullable: true })
  changes?: string | null;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class TodoAuditCount {
  @Field()
  todoId: string;

  @Field()
  count: number;
}
