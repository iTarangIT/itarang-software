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
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.IOT_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "IOT_DATABASE_URL is not set. Run phase5_pg_external.sh on the VPS, then export the printed connection string.",
  );
}

const globalForIotDb = globalThis as unknown as {
  iotPgClient: ReturnType<typeof postgres> | undefined;
};

// Smaller pool than the CRM client — risk-engine reads are bursty.
// `prepare: false` aligns with the CRM client (Supabase pooler compatibility),
// but our IoT PG isn't behind a pooler — kept for code-style parity.
const queryClient =
  globalForIotDb.iotPgClient ??
  postgres(connectionString, {
    ssl: "require",
    prepare: false,
    max: 5,
    idle_timeout: 30,
    connect_timeout: 8,
  });

if (process.env.NODE_ENV !== "production") {
  globalForIotDb.iotPgClient = queryClient;
}

// Drizzle instance for typed `sql` queries. We pass an empty schema since
// none of the IoT tables are mirrored.
export const iotDb = drizzle(queryClient);

// Re-export postgres-js sql tag for callers that want raw access.
export const iotSql = queryClient;
