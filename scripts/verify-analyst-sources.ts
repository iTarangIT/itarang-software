// Read-only check of the AI Analyst's data sources.
//
//   node --import tsx --env-file=.env.local scripts/verify-analyst-sources.ts
//
// Signs in the way src/lib/analyst/client.ts does (that module is server-only and cannot load
// outside Next), then prints every source with its kind, sync state and chosen tables, and
// whether the one-click iTarang database source is set up on this server. Changes nothing.

import type { Connection, TableList } from "../src/lib/analyst/types";

const need = ["ANALYST_API_URL", "ANALYST_SUPABASE_URL", "ANALYST_SUPABASE_KEY", "ANALYST_SERVICE_EMAIL", "ANALYST_SERVICE_PASSWORD"];

async function main() {
  const missing = need.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.log("NOT CONFIGURED — missing", missing.join(", "));
    process.exit(1);
  }
  console.log("ANALYST_CRM_READONLY_DSN:", process.env.ANALYST_CRM_READONLY_DSN ? "set" : "MISSING (one-click iTarang database disabled)");

  const api = process.env.ANALYST_API_URL!.trim().replace(/\/+$/, "");
  const supabase = process.env.ANALYST_SUPABASE_URL!.trim().replace(/\/+$/, "");
  const login = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.ANALYST_SUPABASE_KEY!.trim(), "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.ANALYST_SERVICE_EMAIL!.trim(), password: process.env.ANALYST_SERVICE_PASSWORD }),
  });
  const session = (await login.json()) as { access_token?: string; error_description?: string };
  if (!login.ok || !session.access_token) {
    console.log("service sign-in failed:", session.error_description ?? login.status);
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${session.access_token}` };

  const health = await fetch(`${api}/health`, { signal: AbortSignal.timeout(90_000) }).catch(() => null);
  if (!health?.ok) {
    console.log("agent did not answer /health within 90s");
    process.exit(1);
  }

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${api}${path}`, { headers });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  const connections = await get<Connection[]>("/connections");
  console.log(`${connections.length} source(s)`);
  for (const c of connections) {
    const tables = await get<TableList>(`/connections/${encodeURIComponent(c.id)}/tables`).catch((e: Error) => e);
    console.log(
      `- ${c.name} [${c.kind}] sync=${c.sync_status ?? "-"} files=${c.file_count} chosen=${c.selected_tables}/${c.total_tables}`,
      tables instanceof Error ? `tables: ERROR ${tables.message}` : `max=${tables.max_selected}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
