// ID 167 — delete the AI Analyst's saved OUTSIDE database sources.
//
//   node --import tsx --env-file=.env.local scripts/_delete-analyst-outside-connections.ts           (dry run)
//   node --import tsx --env-file=.env.local scripts/_delete-analyst-outside-connections.ts --apply
//
// The "Other database" tab is gone and the proxy now refuses any Postgres source but the
// iTarang preset, which is always named CRM_SOURCE_NAME. A Postgres source with any other name
// was made through the retired tab, and its address bypasses the read-only role's withheld
// columns and masked views. Files and Google Sheets / Drive sources are left alone (on hold).
//
// The agent is one tenant for the whole CRM, so this is the same list on every environment
// that points at the same ANALYST_API_URL. Signs in the way verify-analyst-sources.ts does.

import { CRM_SOURCE_NAME } from "../src/lib/analyst/sources-routes";
import type { Connection } from "../src/lib/analyst/types";

const need = ["ANALYST_API_URL", "ANALYST_SUPABASE_URL", "ANALYST_SUPABASE_KEY", "ANALYST_SERVICE_EMAIL", "ANALYST_SERVICE_PASSWORD"];

async function main() {
  const apply = process.argv.includes("--apply");
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new Error(`missing ${missing.join(", ")}`);

  const api = process.env.ANALYST_API_URL!.trim().replace(/\/+$/, "");
  const supabase = process.env.ANALYST_SUPABASE_URL!.trim().replace(/\/+$/, "");
  const login = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.ANALYST_SUPABASE_KEY!.trim(), "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.ANALYST_SERVICE_EMAIL!.trim(), password: process.env.ANALYST_SERVICE_PASSWORD }),
  });
  const session = (await login.json()) as { access_token?: string; error_description?: string };
  if (!login.ok || !session.access_token) throw new Error(`service sign-in failed: ${session.error_description ?? login.status}`);
  const headers = { authorization: `Bearer ${session.access_token}` };

  // The agent sleeps on its free tier; the first call can take a minute.
  const res = await fetch(`${api}/connections`, { headers, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`/connections → ${res.status} ${await res.text()}`);
  const connections = (await res.json()) as Connection[];

  const outside = connections.filter((c) => c.kind === "postgres" && c.name !== CRM_SOURCE_NAME);
  console.log(`agent: ${new URL(api).host} — ${connections.length} source(s), ${outside.length} outside database(s)`);
  for (const c of connections) {
    const tag = outside.includes(c) ? (apply ? "DELETE" : "would delete") : "keep";
    console.log(`  ${tag.padEnd(12)} ${c.name} [${c.kind}] ${c.id}`);
  }
  if (!apply || outside.length === 0) {
    if (!apply && outside.length) console.log("\ndry run — add --apply to delete");
    process.exit(0);
  }

  let failed = 0;
  for (const c of outside) {
    const del = await fetch(`${api}/connections/${encodeURIComponent(c.id)}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) {
      failed++;
      console.log(`  FAIL ${c.name}: ${del.status} ${await del.text()}`);
    }
  }
  const after = (await (await fetch(`${api}/connections`, { headers })).json()) as Connection[];
  const left = after.filter((c) => c.kind === "postgres" && c.name !== CRM_SOURCE_NAME);
  console.log(left.length ? `\nSTILL PRESENT: ${left.map((c) => c.name).join(", ")}` : "\nCheck: no outside database source is left.");
  process.exit(failed || left.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
