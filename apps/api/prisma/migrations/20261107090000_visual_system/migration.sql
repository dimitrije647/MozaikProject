-- Visual System 2.0: the campaign design draft, the cached brand-color analysis, the cached visual discovery result and image provenance.
-- Additive only: four new tables and their indexes/foreign keys. No existing table, column or row is changed or removed.

-- CreateTable
CREATE TABLE "CampaignDesignDraft" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "designJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDesignDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandPaletteAnalysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandPaletteAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualDiscoveryRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "queryKey" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualDiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageProvenance" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerImageId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "creator" TEXT,
    "creatorUrl" TEXT,
    "license" TEXT NOT NULL,
    "licenseUrl" TEXT,
    "attribution" TEXT,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT false,
    "licenseBasis" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acquiredById" TEXT NOT NULL,

    CONSTRAINT "ImageProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDesignDraft_projectId_key" ON "CampaignDesignDraft"("projectId");

-- CreateIndex
CREATE INDEX "BrandPaletteAnalysis_projectId_fingerprint_idx" ON "BrandPaletteAnalysis"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "VisualDiscoveryRun_projectId_queryKey_idx" ON "VisualDiscoveryRun"("projectId", "queryKey");

-- CreateIndex
CREATE UNIQUE INDEX "ImageProvenance_assetId_key" ON "ImageProvenance"("assetId");

-- CreateIndex
CREATE INDEX "ImageProvenance_projectId_idx" ON "ImageProvenance"("projectId");

-- AddForeignKey
ALTER TABLE "CampaignDesignDraft" ADD CONSTRAINT "CampaignDesignDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandPaletteAnalysis" ADD CONSTRAINT "BrandPaletteAnalysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualDiscoveryRun" ADD CONSTRAINT "VisualDiscoveryRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageProvenance" ADD CONSTRAINT "ImageProvenance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageProvenance" ADD CONSTRAINT "ImageProvenance_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ProjectAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

