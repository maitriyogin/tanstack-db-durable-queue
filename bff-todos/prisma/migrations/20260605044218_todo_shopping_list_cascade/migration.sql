-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShoppingList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "todoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShoppingList_todoId_fkey" FOREIGN KEY ("todoId") REFERENCES "Todo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShoppingList" ("createdAt", "description", "id", "name", "todoId", "updatedAt") SELECT "createdAt", "description", "id", "name", "todoId", "updatedAt" FROM "ShoppingList";
DROP TABLE "ShoppingList";
ALTER TABLE "new_ShoppingList" RENAME TO "ShoppingList";
CREATE UNIQUE INDEX "ShoppingList_todoId_key" ON "ShoppingList"("todoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
