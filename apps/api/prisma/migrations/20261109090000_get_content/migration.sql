-- Get Content (optional pre-campaign discovery of logo, photographs and brand colors): one runs table, one per-project brand content row and a role on the image library.
-- Additive only: two new tables and one new defaulted column. No existing row, column or table is changed or removed.

-- AlterTable
ALTER TABLE "ProjectImage" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'photo';

-- CreateTable
CREATE TABLE "GetContentRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sourcesJson" JSONB NOT NULL,
    "summaryJson" JSONB,
    "notesJson" JSONB,
    "paletteJson" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "GetContentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBrandContent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "logoAssetId" TEXT,
    "logoSource" TEXT,
    "logoFileName" TEXT,
    "logoSha256" TEXT,
    "logoWidth" INTEGER,
    "logoHeight" INTEGER,
    "logoRightsJson" JSONB,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBrandContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GetContentRun_projectId_startedAt_idx" ON "GetContentRun"("projectId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBrandContent_projectId_key" ON "ProjectBrandContent"("projectId");

-- AddForeignKey
ALTER TABLE "GetContentRun" ADD CONSTRAINT "GetContentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBrandContent" ADD CONSTRAINT "ProjectBrandContent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
