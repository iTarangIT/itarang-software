import dotenv from "dotenv";
import fs from "fs";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env" });

console.log("DATABASE_URL:", process.env.DATABASE_URL);

// Use sslmode=no-verify to bypass self-signed cert issue with AWS RDS
const dbUrl = process.env.DATABASE_URL!.replace("sslmode=require", "sslmode=no-verify");

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
    ssl: {
      rejectUnauthorized: false,
      ca: fs.readFileSync("./global-bundle.pem").toString(),
    },
  },
});