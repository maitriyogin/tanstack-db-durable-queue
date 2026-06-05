import { Module } from '@nestjs/common';
import { ShoppingListResolver } from './shopping-list.resolver';
import { ShoppingListService } from './shopping-list.service';
import { ShoppingListsDao } from './shopping-lists.dao';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [ShoppingListResolver, ShoppingListService, ShoppingListsDao, PrismaService],
  exports: [ShoppingListService],
})
export class ShoppingListsModule {}
