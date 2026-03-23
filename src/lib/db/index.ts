import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
}

// For queries
const queryClient = postgres(connectionString, {
    ssl: 'require',
    prepare: false, // Recommended for Supabase
});

export const db = drizzle(queryClient, { schema });
