// Jest cannot load the ESM-only telemetry package @mozaik-ai/cloud-sdk (Node itself can, via require(esm)).
// Mozaik core only uses it inside runLoop() to forward events to Mozaik Cloud. Tests never call
// runLoop (no inference), and a disabled no-op client is exactly what core gets when no key is set.
module.exports = { createCloudClient: () => ({ enabled: false, send() {}, join() {}, async end() {} }) };
