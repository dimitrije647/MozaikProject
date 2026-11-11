-- Optional Pinterest connection: additive only (two new tables, their indexes and their foreign keys to "User"). Nothing existing is altered.
-- Only encrypted OAuth tokens and token metadata are stored; no Pinterest content (see the model comments in schema.prisma).
-- CreateTable
CREATE TABLE "PinterestConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinterestConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinterestOAuthState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "returnPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinterestOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PinterestConnection_userId_key" ON "PinterestConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PinterestOAuthState_stateHash_key" ON "PinterestOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "PinterestOAuthState_userId_idx" ON "PinterestOAuthState"("userId");

-- CreateIndex
CREATE INDEX "PinterestOAuthState_expiresAt_idx" ON "PinterestOAuthState"("expiresAt");

-- AddForeignKey
ALTER TABLE "PinterestConnection" ADD CONSTRAINT "PinterestConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinterestOAuthState" ADD CONSTRAINT "PinterestOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

