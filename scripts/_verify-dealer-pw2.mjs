import fs from "node:fs";
import pg from "pg";

const env = fs.readFileSync(".env.local", "utf8");
const line = env
  .split(/\r?\n/)
  .find((l) => l.startsWith("# DATABASE_URL=") && l.includes("database-2"));
const url = line.replace(/^#\s*DATABASE_URL=/, "").trim().replace(/[?&]sslmode=require/, "");

const EMAIL = "gurpreetsidana1979@gmail.com";

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
console.log("host:", url.split("@")[1].split("/")[0]);
const r = await c.query(
  `select id, email, name, role, is_active, dealer_id, must_change_password
   from users where lower(email) = $1`,
  [EMAIL.toLowerCase()],
);
console.log("database-2 users rows:", JSON.stringify(r.rows, null, 2));
await c.end();
