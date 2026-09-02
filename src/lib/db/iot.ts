/**
 * IoT bridge — read-only Postgres client for the Itarang VPS telemetry DB.
 *
 * The CRM (Supabase Postgres) holds borrowers, loans, KYC. The VPS Postgres
 * holds vehicle telemetry (vehicle_state, telemetry_gps, telemetry_battery,
 * telemetry_can, alerts). This module is the only place in the CRM that
 * connects to the VPS DB.
 *
 * Connection: IOT_DATABASE_URL=postgres://dashboard_ro:<pw>@<vps-ip>:5433/intellicar?sslmode=require
 *
 * The VPS-side `dashboard_ro` role only has SELECT on telemetry tables.
 * No drizzle schema is mirrored — queries use the `sql` template tag and
 * return typed result rows. We don't run migrations against the IoT DB.
 *
 * See phase5_pg_external.sh for the VPS configuration that exposes this
 * connection (TLS-only, scram-sha-256, role-restricted grants).
 *
 * Lazy init: callers go through getIotSql()/getIotDb(), so the env-var check
 * fires on first request rather than at module load. Without this, Next.js
 * "Collecting page data" during `next build` evaluates every API route module
 * and crashes the build whenever IOT_DATABASE_URL is absent in the build env.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { applicationNameOption } from "./applicationName";

const globalForIotDb = globalThis as unknown as {
  iotPgClient: ReturnType<typeof postgres> | undefined;
  iotPgClientUrl: string | undefined;
};

let cachedDb: ReturnType<typeof drizzle> | undefined;

function createClient(connectionString: string) {
  // SSL mode is driven by the URL's sslmode parameter (sslmode=require /
  // =disable / =prefer). Hardcoding ssl: "require" here used to override the
  // URL and broke connections to a non-SSL VPS Postgres in sandbox.
  const sslmode = (() => {
    try {
      return new URL(connectionString).searchParams.get("sslmode") ?? "prefer";
    } catch {
      return "prefer";
    }
  })();
  const sslOption: "require" | "prefer" | false =
    sslmode === "disable" ? false : sslmode === "require" ? "require" : "prefer";

  // Smaller pool than the CRM client — risk-engine reads are bursty.
  // `prepare: false` aligns with the CRM client (Supabase pooler compatibility),
  // but our IoT PG isn't behind a pooler — kept for code-style parity.
  return postgres(connectionString, {
    ssl: sslOption,
    prepare: false,
    max: 5,
    idle_timeout: 30,
    connect_timeout: 8,
    // Same reasoning as the CRM client: name the service in pg_stat_activity
    // when we know it, and stay silent when we don't.
    ...applicationNameOption(),
  });
}

/**
 * The host:port this process would dial for the IoT database, with the
 * credentials stripped — or null when IOT_DATABASE_URL is unset or unparseable.
 *
 * Exists for the "unreachable" message on /operations/database. The connection
 * is an SSH tunnel to a loopback port (docs/intellicar-live-data-vps-setup.md),
 * so "ECONNREFUSED" on its own leaves an operator unable to tell a stopped
 * tunnel from a tunnel listening on a different port than the env expects —
 * which is a real, current discrepancy: the runbook specifies 5500 and the
 * environment holds 5544. Showing the target turns that into a one-glance
 * diagnosis.
 *
 * NEVER returns the password: only hostname and port are read off the URL.
 */
export function iotTarget(): string | null {
  const connectionString = process.env.IOT_DATABASE_URL;
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    const port = url.port || "5432";
    return url.hostname ? `${url.hostname}:${port}` : null;
  } catch {
    return null;
  }
}

export function getIotSql() {
  const connectionString = process.env.IOT_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "IOT_DATABASE_URL is not set. Run phase5_pg_external.sh on the VPS, then export the printed connection string.",
    );
  }

  // Reuse the cached pool only when it was built from the *current* connection
  // string. Next.js dev reloads .env.local without killing the Node process,
  // so the client cached on globalThis (and a stale sslmode baked into it)
  // would otherwise survive until a full process restart.
  if (
    globalForIotDb.iotPgClient &&
    globalForIotDb.iotPgClientUrl === connectionString
  ) {
    return globalForIotDb.iotPgClient;
  }

  // First call, or the connection string changed — dispose any stale pool and
  // rebuild. In production the URL is stable, so this rebuilds exactly once.
  if (globalForIotDb.iotPgClient) {
    void globalForIotDb.iotPgClient.end({ timeout: 1 }).catch(() => {});
  }

  const client = createClient(connectionString);
  globalForIotDb.iotPgClient = client;
  globalForIotDb.iotPgClientUrl = connectionString;
  cachedDb = undefined; // force getIotDb() to re-wrap the fresh client
  return client;
}

export function getIotDb() {
  // Call getIotSql() first, unconditionally: it sets cachedDb back to undefined
  // when IOT_DATABASE_URL has changed. Returning cachedDb before this ran would
  // never see that invalidation, so a stale drizzle wrapper could outlive the
  // env-var change until a full process restart.
  const client = getIotSql();
  if (cachedDb) return cachedDb;
  cachedDb = drizzle(client);
  return cachedDb;
}
