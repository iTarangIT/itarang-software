import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { applicationNameOption } from './applicationName';
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
    // Sandbox/prod RDS (`database-1`/`database-2`) is a small instance
    // (~79 max_connections) with NO pooler in front. Each app/worker/script
    // process opens its own pool, so a deploy-time burst of processes can
    // crowd the cap and trip `53300` — which fails /api/health and rolls the
    // deploy back. 5 halves each process's footprint with no downside at
    // sandbox traffic. connect_timeout bounds a stalled/unreachable RDS so
    // the attempt errors fast (~10s) instead of hanging on the default.
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Names this process in pg_stat_activity so /operations/database can say
    // WHICH service is holding connections instead of "postgres.js × 26".
    // Omitted entirely when the process has no name it can honestly claim —
    // see applicationName.ts.
    ...applicationNameOption(),
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
