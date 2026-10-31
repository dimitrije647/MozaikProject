-- F4 Creative Production: additive only (two new tables). Nothing existing is altered.
-- CreateTable
CREATE TABLE "CreativeCampaign" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "f1ReportId" TEXT NOT NULL,
    "f2AuditId" TEXT NOT NULL,
    "f3StrategyId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "imageModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "campaignName" TEXT NOT NULL,
    "approvalStatus" TEXT,
    "packageJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativeCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAsset" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "channel" TEXT,
    "format" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentAssetId" TEXT,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "quality" TEXT,
    "requestedSize" TEXT,
    "status" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "altText" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreativeCampaign_runId_key" ON "CreativeCampaign"("runId");

-- CreateIndex
CREATE INDEX "CreativeCampaign_projectId_createdAt_idx" ON "CreativeCampaign"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeCampaign_f3StrategyId_idx" ON "CreativeCampaign"("f3StrategyId");

-- CreateIndex
CREATE INDEX "CampaignAsset_campaignId_idx" ON "CampaignAsset"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignAsset_projectId_idx" ON "CampaignAsset"("projectId");

-- AddForeignKey
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CampaignRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NO ACTION: checked at the end of the statement, so deleting a whole project still cascades cleanly)
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_f1ReportId_fkey" FOREIGN KEY ("f1ReportId") REFERENCES "ProductDiscoveryReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_f2AuditId_fkey" FOREIGN KEY ("f2AuditId") REFERENCES "MarketingAuditReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeCampaign" ADD CONSTRAINT "CreativeCampaign_f3StrategyId_fkey" FOREIGN KEY ("f3StrategyId") REFERENCES "MarketingStrategyReport"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CreativeCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
