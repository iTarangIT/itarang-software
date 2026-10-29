import { sql, type SQL } from 'drizzle-orm';
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

/**
 * ID 203 — run `fn` in one background-pool transaction whose statements may
 * take up to `timeout` instead of the pool's 60 s. SET LOCAL ends with the
 * transaction, so every other job on the pool keeps the 60 s limit. For the
 * few long jobs: the Drive mirror's queue purge (299 s on the sandbox) and
 * the daily Ops rollup and prunes.
 */
export function withLongStatements<T>(
    fn: (tx: Parameters<Parameters<typeof bgDb.transaction>[0]>[0]) => Promise<T>,
    timeout: `${number}min` = '10min',
): Promise<T> {
    return bgDb.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeout}'`));
        return fn(tx);
    });
}

/** One statement under withLongStatements. */
export function bgExecuteLong(statement: SQL, timeout: `${number}min` = '10min') {
    return withLongStatements((tx) => tx.execute(statement), timeout);
}
