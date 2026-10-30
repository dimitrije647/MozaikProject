-- AlterTable: per-provider model preference and last successful connection test
ALTER TABLE "ApiCredential" ADD COLUMN "model" TEXT,
ADD COLUMN "verifiedModel" TEXT,
ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProductDiscoveryReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductDiscoveryReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductDiscoveryReport_runId_key" ON "ProductDiscoveryReport"("runId");

-- CreateIndex
CREATE INDEX "ProductDiscoveryReport_projectId_createdAt_idx" ON "ProductDiscoveryReport"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductDiscoveryReport" ADD CONSTRAINT "ProductDiscoveryReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDiscoveryReport" ADD CONSTRAINT "ProductDiscoveryReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CampaignRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
