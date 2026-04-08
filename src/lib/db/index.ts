import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
}

const globalForDb = globalThis as unknown as {
    pgClient: ReturnType<typeof postgres> | undefined;
};

const queryClient = globalForDb.pgClient ?? postgres(connectionString, {
    ssl: 'require',
    prepare: false,
    max: 10,
    idle_timeout: 20,
});

if (process.env.NODE_ENV !== 'production') {
    globalForDb.pgClient = queryClient;
}

export const db = drizzle(queryClient, { schema });
