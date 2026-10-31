-- F2 Marketing Audit: additive only (one new table).
-- CreateTable
CREATE TABLE "MarketingAuditReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "f1ReportId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAuditReport_runId_key" ON "MarketingAuditReport"("runId");

-- CreateIndex
CREATE INDEX "MarketingAuditReport_projectId_createdAt_idx" ON "MarketingAuditReport"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingAuditReport_f1ReportId_idx" ON "MarketingAuditReport"("f1ReportId");

-- AddForeignKey
ALTER TABLE "MarketingAuditReport" ADD CONSTRAINT "MarketingAuditReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAuditReport" ADD CONSTRAINT "MarketingAuditReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CampaignRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NO ACTION: checked at the end of the statement, so deleting a whole project still cascades cleanly)
ALTER TABLE "MarketingAuditReport" ADD CONSTRAINT "MarketingAuditReport_f1ReportId_fkey" FOREIGN KEY ("f1ReportId") REFERENCES "ProductDiscoveryReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
