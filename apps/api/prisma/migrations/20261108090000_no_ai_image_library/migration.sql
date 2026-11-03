-- NO AI HYBRID: the project's image library (uploads, website / repository / social candidates, imported pictures) with their rights, and a richer image provenance.
-- Additive only: one new table and four new NULLABLE (or defaulted) columns on ImageProvenance. No existing row, column or table is changed or removed.

-- AlterTable
ALTER TABLE "ImageProvenance" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'LICENSED_STOCK',
ADD COLUMN "originalUrl" TEXT,
ADD COLUMN "perceptualHash" TEXT,
ADD COLUMN "rightsJson" JSONB;

-- CreateTable
CREATE TABLE "ProjectImage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pageUrl" TEXT,
    "remoteUrl" TEXT,
    "creator" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "text" TEXT NOT NULL DEFAULT '',
    "rightsJson" JSONB NOT NULL,
    "analysisJson" JSONB,
    "scoreJson" JSONB,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "assetId" TEXT,
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectImage_assetId_key" ON "ProjectImage"("assetId");

-- CreateIndex
CREATE INDEX "ProjectImage_projectId_status_idx" ON "ProjectImage"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectImage_projectId_source_dedupeKey_key" ON "ProjectImage"("projectId", "source", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ProjectImage" ADD CONSTRAINT "ProjectImage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectImage" ADD CONSTRAINT "ProjectImage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ProjectAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
