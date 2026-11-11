// Point every test process at the dedicated test database (created by global-setup.js).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.UPLOAD_DIR = './uploads-test';
process.env.NODE_ENV = 'test';
// Safety net: if a test forgets to start the fake OpenAI server, calls go to a closed local port
// (connection refused) instead of ever reaching api.openai.com with a test key.
process.env.LAUNCHPILOT_OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
// Safety net: no optional external provider key from a developer's .env can ever be used by an automated test.
for (const k of ['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'GITHUB_TOKEN', 'PAGESPEED_API_KEY', 'YOUTUBE_API_KEY', 'MOZAIK_API_KEY', 'PIXABAY_API_KEY', 'PEXELS_API_KEY', 'OPENVERSE_ENABLED', 'OPENVERSE_TOKEN', 'LAUNCHPILOT_REFERENCE_IMAGE_SEARCH']) process.env[k] = '';
