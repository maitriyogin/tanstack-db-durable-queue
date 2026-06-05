import { Injectable } from '@nestjs/common';
import { ShoppingListsDao } from './shopping-lists.dao';
import {
  AddShoppingListItemInput,
  CreateShoppingListInput,
  UpdateShoppingListInput,
  UpdateShoppingListItemInput,
} from './shopping-list.input';
import { ShoppingList, ShoppingListItem } from './shopping-list.model';

@Injectable()
export class ShoppingListService {
  constructor(private readonly shoppingListsDao: ShoppingListsDao) {}

  async createShoppingList(input: CreateShoppingListInput): Promise<ShoppingList> {
    return await this.shoppingListsDao.create(input);
  }

  async updateShoppingList(input: UpdateShoppingListInput): Promise<ShoppingList | null> {
    const { id, ...data } = input;
    return await this.shoppingListsDao.update(id, data);
  }

  async deleteShoppingList(id: string): Promise<ShoppingList | null> {
    return await this.shoppingListsDao.delete(id);
  }

  async getShoppingList(id: string): Promise<ShoppingList | null> {
    return await this.shoppingListsDao.findById(id);
  }

  async listShoppingLists(): Promise<ShoppingList[]> {
    return await this.shoppingListsDao.findAll();
  }

  async addItem(input: AddShoppingListItemInput): Promise<ShoppingListItem> {
    return await this.shoppingListsDao.addItem(input);
  }

  async updateItem(input: UpdateShoppingListItemInput): Promise<ShoppingListItem | null> {
    const { id, ...data } = input;
    return await this.shoppingListsDao.updateItem(id, data);
  }

  async removeItem(id: string): Promise<ShoppingListItem | null> {
    return await this.shoppingListsDao.deleteItem(id);
  }

  async getItem(id: string): Promise<ShoppingListItem | null> {
    return await this.shoppingListsDao.findItemById(id);
  }
}
