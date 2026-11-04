// Read-only: where every open item on the 2 Nov sheet (Aditya tab) stands on
// one database, so a live step is run only when it is still needed.
//
//   node --import tsx --env-file=.env.local      scripts/verify-02nov-live-state.ts   # sandbox (db-1)
//   node --import tsx --env-file=.env.production scripts/verify-02nov-live-state.ts   # live (db-2)
//
// Each line says what was found and what to do next. Only SELECTs; each read
// is on its own, so one missing table never hides the rest.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

type Row = Record<string, unknown>;
const one = async (q: ReturnType<typeof sql>): Promise<Row> => ((await db.execute(q)) as unknown as Row[])[0] ?? {};

async function line(label: string, read: () => Promise<string>) {
    try {
        console.log(`${label.padEnd(26)} ${await read()}`);
    } catch (e) {
        console.log(`${label.padEnd(26)} could not read: ${(e as Error).message.split("\n")[0]}`);
    }
}

const days = (t: unknown) => (t ? Math.floor((Date.now() - new Date(String(t)).getTime()) / 86_400_000) : null);

async function main() {
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host.split(".")[0]}  (${new Date().toISOString()})\n`);

    await line("Migrations", async () => {
        const r = await one(sql`
            SELECT to_regclass('public.zoho_invoice_payments') IS NOT NULL AS e369,
                   to_regclass('public.online_store_finance_leads') IS NOT NULL AS e366,
                   to_regclass('public.lead_route_log') IS NOT NULL AS e367,
                   to_regclass('public.credit_note_applications') IS NOT NULL AS e368,
                   to_regclass('public.vyapar_register_rows') IS NOT NULL AS e370,
                   EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'lead_callbacks' AND column_name = 'escalated_at') AS e362`);
        const missing = Object.entries(r).filter(([, v]) => !v).map(([k]) => k.toUpperCase().replace("E", "E-"));
        return missing.length ? `MISSING ${missing.join(", ")}` : "E-362, E-366..E-370 all present";
    });

    await line("L1 NeoDove calls", async () => {
        const r = await one(sql`
            SELECT MAX(created_at)::text AS last,
                   COUNT(*) FILTER (WHERE created_at > now() - interval '3 days')::int AS last3d
              FROM neodove_sync_events WHERE direction = 'inbound'`);
        const age = days(r.last);
        return `newest inbound ${r.last ?? "never"} (${age ?? "-"} days ago), ${r.last3d} in 3 days → ${
            age != null && age <= 2 ? "OK, calls reach this CRM" : "NOT reaching: repoint the NeoDove webhook, then replay"
        }`;
    });

    await line("L2 / 85 limit events", async () => {
        const r = await one(sql`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE clock = 'lead' AND owner_id IS NOT NULL)::int AS lead_charged,
                   MAX(recorded_at)::text AS newest
              FROM lead_limit_events`);
        return `${r.total} events, newest ${r.newest ?? "-"}; lead-wide charged to a person: ${r.lead_charged} → ${
            Number(r.lead_charged) === 0 ? "clean" : "run cleanup-limit-events-l2.ts (dry run, then --apply --confirm-live)"
        }`;
    });

    await line("70 / L9 Zoho copy", async () => {
        const r = await one(sql`
            SELECT COUNT(*)::int AS invoices,
                   COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoice_line_items l
                                                   WHERE l.source = 'zoho' AND l.invoice_id = zi.id::text))::int AS lined
              FROM zoho_invoices zi`);
        return `${r.lined} of ${r.invoices} Zoho invoices have lines → details: verify-id70-zoho-copy.ts`;
    });

    await line("L16 / 71 credit notes", async () => {
        const r = await one(sql`
            SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE drive_file_id IS NOT NULL)::int AS drive FROM credit_notes`);
        // L16 is the Drive scan's line fill-in; Vyapar notes come with their lines.
        return Number(r.drive) === 0
            ? `${r.total} (none from Drive) → no Drive credit-note folder yet, nothing to fill in`
            : `${r.total} (${r.drive} from Drive) → run backfill-drive-line-items.ts --credit-notes (dry run, then --commit)`;
    });

    await line("194 / 198 reporting lines", async () => {
        const r = await one(sql`
            SELECT COUNT(*) FILTER (WHERE effective_to IS NULL OR effective_to > now())::int AS current,
                   COUNT(DISTINCT manager_id) FILTER (WHERE effective_to IS NULL OR effective_to > now())::int AS managers
              FROM user_reporting_lines`);
        return Number(r.current) === 0
            ? "NONE set → needs who-reports-to-whom before My day / My team can switch on"
            : `${r.current} current lines under ${r.managers} managers`;
    });

    await line("194 / 198 My day switch", async () => {
        const r = await one(sql`SELECT value, updated_at::text AS at FROM app_settings WHERE key = 'my_day_digest'`);
        if (!r.value) return "never saved → OFF";
        const v = r.value as { enabled?: boolean; roles?: unknown };
        return `${v.enabled ? "ON" : "OFF"}, roles ${JSON.stringify(v.roles ?? null)}, saved ${r.at}`;
    });

    await line("206 login record", async () => {
        const r = await one(sql`
            SELECT MAX(occurred_at)::text AS newest,
                   COUNT(*) FILTER (WHERE occurred_at > now() - interval '2 days')::int AS recent
              FROM user_login_events`);
        return `newest sign-in recorded ${r.newest ?? "never"}, ${r.recent} in 2 days → ${
            Number(r.recent) > 0 ? "recording" : "sign in fresh, then re-run"
        }`;
    });

    await line("167 / L3 Analyst login", async () => {
        const r = await one(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst_ro') AS ok`);
        return r.ok ? "analyst_ro exists" : "analyst_ro MISSING → docs/analyst/ANALYST_RO_RUNS.md";
    });

    console.log(`\nMore detail (read-only):
  verify-id85-86-time-limits.ts   (85 / L2)      verify-id70-zoho-copy.ts         (70 / L9)
  verify-section3-report-places.ts (148/185/A16)  verify-accounts-list-perf.ts     (203)
  backfill-item-families.ts        (A16 / L19, dry run without --apply)`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
