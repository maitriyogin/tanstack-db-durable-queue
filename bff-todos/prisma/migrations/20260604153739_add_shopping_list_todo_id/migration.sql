-- AlterTable
ALTER TABLE "ShoppingList" ADD COLUMN "todoId" TEXT;

-- CreateIndex
CREATE INDEX "ShoppingList_todoId_idx" ON "ShoppingList"("todoId");
