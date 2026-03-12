import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

let _telemetryDb: ReturnType<typeof drizzle> | null = null;

function getDb() {
    if (!_telemetryDb) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is not set');
        }
        const queryClient = postgres(connectionString, {
            ssl: 'require',
            prepare: false,
        });
        _telemetryDb = drizzle(queryClient);
    }
    return _telemetryDb;
}

export const telemetryDb = new Proxy({} as ReturnType<typeof drizzle>, {
    get(_, prop) {
        const db = getDb();
        const val = (db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof val === 'function' ? val.bind(db) : val;
    },
});

export { sql };
