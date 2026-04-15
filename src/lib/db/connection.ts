import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// AWS RDS uses Amazon-signed certificates; tell Node's TLS layer not to verify
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function buildAwsDatabaseUrl() {
  const host = process.env.AWS_DB_HOST;
  const port = process.env.AWS_DB_PORT ?? "5432";
  const database = process.env.AWS_DB_NAME ?? "postgres";
  const user = process.env.AWS_DB_USER;
  const password = process.env.AWS_DB_PASSWORD;

  if (!host || !user || !password) {
    return undefined;
  }

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function getDatabaseUrl() {
  const rawUrl = process.env.DATABASE_URL ?? buildAwsDatabaseUrl();

  if (!rawUrl) {
    throw new Error(
      "Database connection not configured. Set DATABASE_URL or AWS_DB_* env vars."
    );
  }

  // Strip any ?sslmode=... query parameter — postgres-js will parse it and
  // override the `ssl` option we pass, which can re-enable cert verification
  // and break RDS connections with "self signed certificate in certificate chain".
  return rawUrl.replace(/([?&])sslmode=[^&]*(&|$)/, (_m, pre, post) =>
    post === "&" ? pre : ""
  ).replace(/\?$/, "");
}

type PostgresClient = ReturnType<typeof postgres>;

declare global {
  var __itarangAwsSqlClient__: PostgresClient | undefined;
}

const client: PostgresClient =
  globalThis.__itarangAwsSqlClient__ ??
  postgres(getDatabaseUrl(), {
    // 'require' = require TLS but do not verify the certificate chain.
    // RDS presents an Amazon-signed cert that Node's default CA bundle
    // doesn't trust, so verification must be disabled.
    ssl: "require",
    prepare: false,
    max: process.env.NODE_ENV === "production" ? 10 : 5,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__itarangAwsSqlClient__ = client;
}

export const sql = client;
export const db = drizzle(client, { schema });

export async function verifyDatabaseConnection() {
  const result = await sql`
    select
      now()::text as now,
      current_database() as current_database,
      current_user as current_user
  `;
  return result[0];
}