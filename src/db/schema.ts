import * as sqliteSchema from './schema_sqlite';
import * as postgresSchema from './schema_postgres';

const usePostgres = !!process.env.POSTGRES_URL;

// Auth tables (user, session, account, verification) are managed by Better Auth
// and are NOT part of the Drizzle schema. Only app-specific tables are exported here.

export const documents = usePostgres ? postgresSchema.documents : sqliteSchema.documents;
export const audiobooks = usePostgres ? postgresSchema.audiobooks : sqliteSchema.audiobooks;
export const audiobookChapters = usePostgres ? postgresSchema.audiobookChapters : sqliteSchema.audiobookChapters;
export const userTtsChars = usePostgres ? postgresSchema.userTtsChars : sqliteSchema.userTtsChars;
export const userPreferences = usePostgres ? postgresSchema.userPreferences : sqliteSchema.userPreferences;
export const userDocumentProgress = usePostgres ? postgresSchema.userDocumentProgress : sqliteSchema.userDocumentProgress;
export const documentPreviews = usePostgres ? postgresSchema.documentPreviews : sqliteSchema.documentPreviews;
