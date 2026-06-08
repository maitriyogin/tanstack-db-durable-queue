-- CreateTable
CREATE TABLE "ClientOpResult" (
    "clientOpId" TEXT NOT NULL PRIMARY KEY,
    "responseJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
