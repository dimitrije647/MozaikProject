// Point every test process at the dedicated test database (created by global-setup.js).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.UPLOAD_DIR = './uploads-test';
process.env.NODE_ENV = 'test';
// Safety net: if a test forgets to start the fake OpenAI server, calls go to a closed local port
// (connection refused) instead of ever reaching api.openai.com with a test key.
process.env.LAUNCHPILOT_OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
