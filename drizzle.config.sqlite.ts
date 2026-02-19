import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

export default {
  schema: ['./src/db/schema_sqlite.ts', './src/db/schema_auth_sqlite.ts'],
  out: './drizzle/sqlite',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'docstore/sqlite3.db',
  },
} satisfies Config;
