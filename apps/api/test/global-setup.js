const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const TEST_DB = 'launchpilot_test';

/**
 * Requires the dev PostgreSQL (docker compose, port 5433) to be running. Creates a separate
 * `launchpilot_test` database if needed and applies all migrations to it. Dev data is untouched.
 * If PostgreSQL is unreachable this throws, so the suite fails loudly instead of skipping.
 */
module.exports = async () => {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set. Run tests through "pnpm test" (loads ../../.env).');
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  const testUrl = url.toString();

  const admin = new PrismaClient({ datasources: { db: { url: base } } });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${TEST_DB}`);
  } catch (err) {
    if (!/already exists/i.test(String(err.message))) throw err;
  } finally {
    await admin.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: __dirname + '/..',
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  process.env.TEST_DATABASE_URL = testUrl;
};
