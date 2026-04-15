import postgres from "postgres";

export const awsSql = postgres({
  host: process.env.AWS_DB_HOST!,
  port: Number(process.env.AWS_DB_PORT || 5432),
  database: process.env.AWS_DB_NAME!,
  username: process.env.AWS_DB_USER!,
  password: process.env.AWS_DB_PASSWORD!,
  ssl: "require",
});