// Keep the official ONNX binary's telemetry disabled when tests import it
// directly instead of entering through the worker server bootstrap.
process.env.ORT_DISABLE_TELEMETRY = '1';
process.env.COMPUTE_WORKER_TOKEN = process.env.COMPUTE_WORKER_TOKEN || 'test-token';
process.env.COMPUTE_CREDENTIAL_BROKER_URL = process.env.COMPUTE_CREDENTIAL_BROKER_URL || 'http://127.0.0.1:3003/api/internal/compute/tts-credentials';
process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN || 'test-credential-broker-token';
process.env.TTS_PLAYBACK_TOKEN_SECRET = process.env.TTS_PLAYBACK_TOKEN_SECRET || 'test-playback-token-secret';
process.env.NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222';
process.env.COMPUTE_PREWARM_MODELS = 'false';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
process.env.S3_REGION = process.env.S3_REGION || 'us-east-1';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || 'test';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || 'test';
process.env.S3_PREFIX = process.env.S3_PREFIX || 'openreader';
