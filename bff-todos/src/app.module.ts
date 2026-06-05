import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { TodosModule } from './todos/todos.module';
import { TodosAuditModule } from './todos-audit/todos-audit.module';
import { ShoppingListsModule } from './shopping-lists/shopping-lists.module';
import { BudgetsModule } from './budgets/budgets.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      playground: true,
      introspection: true,
    }),
    TodosModule,
    TodosAuditModule,
    ShoppingListsModule,
    BudgetsModule,
  ],
})
export class AppModule {}
