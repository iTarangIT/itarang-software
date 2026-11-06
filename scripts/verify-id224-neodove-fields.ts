// ID 224 (read-only) — what NeoDove actually sends. Lists every key path seen
// in the recent inbound webhook bodies (neodove_sync_events.request_payload),
// how often, and a sample value for any path that looks like a duration or a
// recording — so the mapper reads the names NeoDove really uses. Also counts
// how many of the stored NeoDove call touchpoints have a duration / recording.
//
//   node --import tsx --env-file=.env.local scripts/verify-id224-neodove-fields.ts [--days=14] [--limit=500]
//
// Writes nothing. Phone numbers and names are not printed (only key paths and
// duration / recording / time-like samples).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const args = process.argv.slice(2);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const days = Number(value("days") ?? 14);
const limit = Number(value("limit") ?? 500);

const INTERESTING = /dur|record|audio|talk|call_?time|length|seconds|secs|billsec|url|link/i;

function walk(v: unknown, path: string, out: Map<string, { n: number; sample: string }>) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, out);
        return;
    }
    if (Array.isArray(v)) {
        v.slice(0, 3).forEach((x) => walk(x, `${path}[]`, out));
        return;
    }
    const cur = out.get(path) ?? { n: 0, sample: "" };
    cur.n++;
    if (!cur.sample && INTERESTING.test(path) && v != null && v !== "") cur.sample = String(v).slice(0, 120);
    out.set(path, cur);
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    console.log(`DB host: ${host} · last ${days} days · up to ${limit} inbound events (read-only)`);
    const rows = (await db.execute(sql`
        SELECT event_type, created_at::text AS created_at, request_payload
          FROM neodove_sync_events
         WHERE direction = 'inbound'
           AND created_at > now() - make_interval(days => ${days})
         ORDER BY created_at DESC
         LIMIT ${limit}
    `)) as unknown as Array<{ event_type: string | null; created_at: string; request_payload: unknown }>;
    console.log(`${rows.length} events; newest ${rows[0]?.created_at ?? "-"}, oldest ${rows[rows.length - 1]?.created_at ?? "-"}`);

    const byType = new Map<string, number>();
    const paths = new Map<string, { n: number; sample: string }>();
    for (const r of rows) {
        byType.set(r.event_type ?? "(none)", (byType.get(r.event_type ?? "(none)") ?? 0) + 1);
        let body = r.request_payload;
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            } catch {
                /* leave as string */
            }
        }
        walk(body, "", paths);
    }
    console.log("\nevent types:", Object.fromEntries(byType));
    console.log("\nkey paths (count · sample for duration / recording-like paths):");
    for (const [p, v] of [...paths].sort((a, b) => b[1].n - a[1].n)) {
        if (INTERESTING.test(p) || v.n >= rows.length * 0.2) console.log(`  ${String(v.n).padStart(5)}  ${p}${v.sample ? `  = ${v.sample}` : ""}`);
    }

    const [tp] = (await db.execute(sql`
        SELECT COUNT(*)::int AS calls,
               COUNT(*) FILTER (WHERE call_duration_sec IS NOT NULL)::int AS with_duration,
               COUNT(*) FILTER (WHERE to_jsonb(t) ->> 'recording_url' IS NOT NULL)::int AS with_recording
          FROM lead_touchpoints t
         WHERE external_system = 'neodove' AND performed_at > now() - make_interval(days => ${days})
    `)) as unknown as Array<{ calls: number; with_duration: number; with_recording: number }>;
    console.log(`\nNeoDove call touchpoints (last ${days} days): ${tp?.calls ?? 0}; with duration ${tp?.with_duration ?? 0}; with recording ${tp?.with_recording ?? 0}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
