import { inject } from 'vitest';

process.env.SQLITE_DB_PATH = inject('sqliteDbPath');
delete process.env.POSTGRES_URL;

if (!process.env.AUTH_SECRET?.trim()) {
  process.env.AUTH_SECRET = 'vitest-auth-secret';
}

if (!process.env.BASE_URL?.trim()) {
  process.env.BASE_URL = 'http://localhost:3003';
}
