import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddShoppingListItemInput,
  CreateShoppingListInput,
  UpdateShoppingListInput,
  UpdateShoppingListItemInput,
} from './shopping-list.input';
import { ShoppingList, ShoppingListItem } from './shopping-list.model';

@Injectable()
export class ShoppingListsDao {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateShoppingListInput): Promise<ShoppingList> {
    return await this.prisma.shoppingList.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        todoId: input.todoId ?? null,
        items: {
          create: input.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit: item.unit ?? null,
            notes: item.notes ?? null,
            cost: item.cost ?? 0,
          })),
        },
      },
      include: { items: true },
    });
  }

  async update(
    id: string,
    data: Partial<Omit<UpdateShoppingListInput, 'id'>>,
  ): Promise<ShoppingList | null> {
    return await this.prisma.shoppingList.update({
      where: { id },
      data,
      include: { items: true },
    });
  }

  async delete(id: string): Promise<ShoppingList | null> {
    try {
      return await this.prisma.shoppingList.delete({
        where: { id },
        include: { items: true },
      });
    } catch (error: any) {
      if (error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<ShoppingList | null> {
    return await this.prisma.shoppingList.findUnique({
      where: { id },
      include: { items: true },
    });
  }

  async findAll(): Promise<ShoppingList[]> {
    return await this.prisma.shoppingList.findMany({
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addItem(input: AddShoppingListItemInput): Promise<ShoppingListItem> {
    return await this.prisma.shoppingListItem.create({
      data: {
        shoppingListId: input.shoppingListId,
        name: input.name,
        quantity: input.quantity,
        unit: input.unit ?? null,
        notes: input.notes ?? null,
        cost: input.cost ?? 0,
      },
    });
  }

  async updateItem(
    id: string,
    data: Partial<Omit<UpdateShoppingListItemInput, 'id'>>,
  ): Promise<ShoppingListItem | null> {
    try {
      return await this.prisma.shoppingListItem.update({
        where: { id },
        data,
      });
    } catch (error: any) {
      if (error.code === 'P2025') return null;
      throw error;
    }
  }

  async deleteItem(id: string): Promise<ShoppingListItem | null> {
    try {
      return await this.prisma.shoppingListItem.delete({
        where: { id },
      });
    } catch (error: any) {
      if (error.code === 'P2025') return null;
      throw error;
    }
  }

  async findItemById(id: string): Promise<ShoppingListItem | null> {
    return await this.prisma.shoppingListItem.findUnique({
      where: { id },
    });
  }
}
