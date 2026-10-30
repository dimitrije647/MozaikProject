// Point every test process at the dedicated test database (created by global-setup.js).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.UPLOAD_DIR = './uploads-test';
process.env.NODE_ENV = 'test';
