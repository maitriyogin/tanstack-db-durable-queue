import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { ShoppingListService } from './shopping-list.service';
import { ShoppingList, ShoppingListItem } from './shopping-list.model';
import {
  AddShoppingListItemInput,
  CreateShoppingListInput,
  UpdateShoppingListInput,
  UpdateShoppingListItemInput,
} from './shopping-list.input';

@Resolver(() => ShoppingList)
export class ShoppingListResolver {
  constructor(private readonly shoppingListService: ShoppingListService) {}

  @Query(() => ShoppingList, { nullable: true })
  async shoppingList(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ShoppingList | null> {
    return await this.shoppingListService.getShoppingList(id);
  }

  @Query(() => [ShoppingList])
  async shoppingLists(): Promise<ShoppingList[]> {
    return await this.shoppingListService.listShoppingLists();
  }

  @Mutation(() => ShoppingList)
  async createShoppingList(
    @Args('input') input: CreateShoppingListInput,
  ): Promise<ShoppingList> {
    return await this.shoppingListService.createShoppingList(input);
  }

  @Mutation(() => ShoppingList, { nullable: true })
  async updateShoppingList(
    @Args('input') input: UpdateShoppingListInput,
  ): Promise<ShoppingList | null> {
    return await this.shoppingListService.updateShoppingList(input);
  }

  @Mutation(() => ShoppingList, { nullable: true })
  async deleteShoppingList(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ShoppingList | null> {
    return await this.shoppingListService.deleteShoppingList(id);
  }

  @Query(() => ShoppingListItem, { nullable: true })
  async shoppingListItem(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ShoppingListItem | null> {
    return await this.shoppingListService.getItem(id);
  }

  @Mutation(() => ShoppingListItem)
  async addShoppingListItem(
    @Args('input') input: AddShoppingListItemInput,
  ): Promise<ShoppingListItem> {
    return await this.shoppingListService.addItem(input);
  }

  @Mutation(() => ShoppingListItem, { nullable: true })
  async updateShoppingListItem(
    @Args('input') input: UpdateShoppingListItemInput,
  ): Promise<ShoppingListItem | null> {
    return await this.shoppingListService.updateItem(input);
  }

  @Mutation(() => ShoppingListItem, { nullable: true })
  async removeShoppingListItem(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ShoppingListItem | null> {
    return await this.shoppingListService.removeItem(id);
  }
}
