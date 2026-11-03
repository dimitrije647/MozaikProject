-- The campaign budget ledger of a factory run (one shared budget for text, images and reviews).
-- Additive only: one nullable column. Existing rows keep NULL and are read as they were; nothing is rewritten.
-- AlterTable
ALTER TABLE "FactoryRun" ADD COLUMN "ledgerJson" JSONB;
