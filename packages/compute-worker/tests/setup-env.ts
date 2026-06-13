process.env.COMPUTE_WORKER_TOKEN = process.env.COMPUTE_WORKER_TOKEN || 'test-token';
process.env.NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222';
process.env.COMPUTE_PREWARM_MODELS = 'false';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
process.env.S3_REGION = process.env.S3_REGION || 'us-east-1';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || 'test';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || 'test';
process.env.S3_PREFIX = process.env.S3_PREFIX || 'openreader';
