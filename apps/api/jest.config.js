/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\.e2e-spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@mozaik-ai/cloud-sdk$': '<rootDir>/test/stubs/cloud-sdk.js' },
  globalSetup: '<rootDir>/test/global-setup.js',
  setupFiles: ['<rootDir>/test/env.js'],
  // One shared test database: run files serially.
  maxWorkers: 1,
  testTimeout: 30000,
};
