-- F3 Market Research & Strategy: additive only (one new table).
-- CreateTable
CREATE TABLE "MarketingStrategyReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "f1ReportId" TEXT NOT NULL,
    "f2AuditId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingStrategyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingStrategyReport_runId_key" ON "MarketingStrategyReport"("runId");

-- CreateIndex
CREATE INDEX "MarketingStrategyReport_projectId_createdAt_idx" ON "MarketingStrategyReport"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingStrategyReport_f1ReportId_idx" ON "MarketingStrategyReport"("f1ReportId");

-- CreateIndex
CREATE INDEX "MarketingStrategyReport_f2AuditId_idx" ON "MarketingStrategyReport"("f2AuditId");

-- AddForeignKey
ALTER TABLE "MarketingStrategyReport" ADD CONSTRAINT "MarketingStrategyReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingStrategyReport" ADD CONSTRAINT "MarketingStrategyReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CampaignRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NO ACTION: checked at the end of the statement, so deleting a whole project still cascades cleanly)
ALTER TABLE "MarketingStrategyReport" ADD CONSTRAINT "MarketingStrategyReport_f1ReportId_fkey" FOREIGN KEY ("f1ReportId") REFERENCES "ProductDiscoveryReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingStrategyReport" ADD CONSTRAINT "MarketingStrategyReport_f2AuditId_fkey" FOREIGN KEY ("f2AuditId") REFERENCES "MarketingAuditReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
