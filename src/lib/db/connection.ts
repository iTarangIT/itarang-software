import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// AWS RDS uses Amazon-signed certificates; allow them through Node's TLS layer
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

function buildAwsDatabaseUrl() {
  const host = process.env.AWS_DB_HOST;
  const port = process.env.AWS_DB_PORT ?? "5432";
  const database = process.env.AWS_DB_NAME;
  const user = process.env.AWS_DB_USER;
  const password = process.env.AWS_DB_PASSWORD;

  if (!host || !database || !user || !password) {
    return undefined;
  }

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;
}

export function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL ?? buildAwsDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      "Database connection not configured. Set DATABASE_URL or AWS_DB_* env vars."
    );
  }

  return databaseUrl;
}

type PostgresClient = ReturnType<typeof postgres>;

declare global {
  var __itarangAwsSqlClient__: PostgresClient | undefined;
}

const client: PostgresClient =
  globalThis.__itarangAwsSqlClient__ ??
  postgres(getDatabaseUrl(), {
    ssl: { rejectUnauthorized: false },
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