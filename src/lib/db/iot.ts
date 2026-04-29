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

const globalForIotDb = globalThis as unknown as {
  iotPgClient: ReturnType<typeof postgres> | undefined;
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
  });
}

export function getIotSql() {
  if (globalForIotDb.iotPgClient) return globalForIotDb.iotPgClient;

  const connectionString = process.env.IOT_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "IOT_DATABASE_URL is not set. Run phase5_pg_external.sh on the VPS, then export the printed connection string.",
    );
  }

  const client = createClient(connectionString);
  if (process.env.NODE_ENV !== "production") {
    globalForIotDb.iotPgClient = client;
  } else {
    // Cache in production too — avoids reopening pools per request.
    globalForIotDb.iotPgClient = client;
  }
  return client;
}

export function getIotDb() {
  if (cachedDb) return cachedDb;
  cachedDb = drizzle(getIotSql());
  return cachedDb;
}
