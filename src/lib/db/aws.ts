import postgres from "postgres";

import { applicationNameOption } from "./applicationName";

export const awsSql = postgres({
  host: process.env.AWS_DB_HOST!,
  port: Number(process.env.AWS_DB_PORT || 5432),
  database: process.env.AWS_DB_NAME!,
  username: process.env.AWS_DB_USER!,
  password: process.env.AWS_DB_PASSWORD!,
  ssl: "require",
  // The only pool besides src/lib/db/index.ts that this application can
  // actually reach (via /api/test-aws), so it needs the same name or its
  // connections show up on /operations/database as an anonymous `postgres.js`
  // row next to the named ones. Note this client is built at MODULE LOAD, so
  // the pool opens as soon as anything imports it.
  ...applicationNameOption(),
});