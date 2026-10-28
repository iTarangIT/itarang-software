import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { applicationName } from './applicationName';
import * as schema from './schema';

/**
 * A separate, small pool for in-process background work (instrumentation-node
 * tickers): the Ops Console collectors and the Google Drive mirror.
 *
 * WHY. The request pool in ./index.ts is max 5. Those tickers used to share
 * it, and some of their queries run for tens of seconds (catalog scans,
 * pg_stat_statements, a full storage_drive_mirror scan — up to 299 s seen on
 * db-1). While they held connections, page requests queued in postgres.js
 * behind them; the Accounts tab, which fans out the most requests at once,
 * took over a minute. With its own pool, background work can only slow
 * itself down.
 *
 * statement_timeout bounds a runaway background query so it gives its
 * connection back; request queries are untouched. Connections report as
 * "<app>-bg" in pg_stat_activity (scripts/verify-db-pool-contention.ts).
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
}

const globalForBgDb = globalThis as unknown as {
    bgPgClient: ReturnType<typeof postgres> | undefined;
};

const name = applicationName();

const bgClient = globalForBgDb.bgPgClient ?? postgres(connectionString, {
    ssl: 'require',
    prepare: false,
    // 2 more connections per process on top of the request pool's 5; the RDS
    // cap is ~79 and db-1 runs ~14 in use.
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
        statement_timeout: 60_000,
        ...(name ? { application_name: `${name.slice(0, 60)}-bg` } : {}),
    },
});

if (process.env.NODE_ENV !== 'production') {
    globalForBgDb.bgPgClient = bgClient;
}

export const bgDb = drizzle(bgClient, { schema });
