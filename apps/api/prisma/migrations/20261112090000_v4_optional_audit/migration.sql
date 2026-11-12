-- V4: new strategies and campaigns are built on F1 and F3 only (the SEO/GEO Marketing Audit is no longer run).
-- Additive and non-destructive: the columns only stop being required; every existing row and foreign key is kept as it is.
ALTER TABLE "MarketingStrategyReport" ALTER COLUMN "f2AuditId" DROP NOT NULL;
ALTER TABLE "CreativeCampaign" ALTER COLUMN "f2AuditId" DROP NOT NULL;
