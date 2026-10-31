-- Full-campaign orchestration state: additive only (one new table). Nothing existing is altered.
-- CreateTable
CREATE TABLE "FactoryRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentPhase" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "configJson" JSONB NOT NULL,
    "phasesJson" JSONB NOT NULL,
    "warningsJson" JSONB NOT NULL DEFAULT '[]',
    "f1ReportId" TEXT,
    "f2AuditId" TEXT,
    "f3StrategyId" TEXT,
    "campaignId" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactoryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FactoryRun_projectId_createdAt_idx" ON "FactoryRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "FactoryRun_userId_idx" ON "FactoryRun"("userId");

-- One queued/running factory run per project (atomic duplicate-start protection); finished runs are unconstrained.
CREATE UNIQUE INDEX "FactoryRun_one_active_per_project" ON "FactoryRun"("projectId") WHERE "status" IN ('queued', 'running');

-- AddForeignKey
ALTER TABLE "FactoryRun" ADD CONSTRAINT "FactoryRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryRun" ADD CONSTRAINT "FactoryRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
