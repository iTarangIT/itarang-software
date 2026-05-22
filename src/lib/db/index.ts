import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
}

const globalForDb = globalThis as unknown as {
    pgClient: ReturnType<typeof postgres> | undefined;
    dbHostLogged: boolean | undefined;
};

const queryClient = globalForDb.pgClient ?? postgres(connectionString, {
    ssl: 'require',
    prepare: false,
    max: 10,
    idle_timeout: 20,
});

if (process.env.NODE_ENV !== 'production') {
    globalForDb.pgClient = queryClient;
    // Surface the target host once per dev-server start. Schema drift
    // bugs ("page shows 0 leads") almost always come down to the dev
    // server pointing at a DB where the latest E-NNN migration hasn't
    // landed. Printing the host removes one round-trip of detective work.
    if (!globalForDb.dbHostLogged) {
        try {
            const u = new URL(connectionString);
            console.log(
                `[DB] connected to ${u.hostname}${u.pathname} (apply E-NNN migrations against this host)`,
            );
        } catch {
            console.log("[DB] DATABASE_URL set (unparseable URL)");
        }
        globalForDb.dbHostLogged = true;
    }
}

export const db = drizzle(queryClient, { schema });
