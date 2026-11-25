// E-396 — WhatsApp visit proof, READ-ONLY checks against a real database.
//
//   node --import tsx --env-file=.env.local scripts/verify-wa-visit-proof.mts database-1|database-2
//
// Picks that host's DATABASE_URL from the env file (never printed), then uses the
// feature's own code: the E-363 / E-396 probes, the waiting-card query, the shop
// position query (geocoding stubbed off — no outside calls), and the 100 m rule
// replayed on real verified visits. Writes nothing.
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target ?? "")) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in the env file`);
process.env.DATABASE_URL = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");

const { sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { hasVerifiedVisits, hasWhatsAppVisitProof, shopPosition } = await import("@/lib/visits/verifiedStore");
const { checkShopDistance, MAX_SHOP_DISTANCE_M } = await import("@/lib/visits/verifiedCapture");
const { haversineMeters } = await import("@/lib/assistant/geo");
const { loadProofRow } = await import("@/lib/wa-assistant/visitProof");

const rows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`target: ${target}\n`);

// 1. Probes the feature switches on.
check("E-363 verified visits present", await hasVerifiedVisits());
check("E-396 present (visit_captures.source)", await hasWhatsAppVisitProof());

// 2. Columns as the code writes them.
const cols = rows<{ column_name: string; is_nullable: string }>(
    await db.execute(sql`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'visit_captures'
           AND column_name IN ('source', 'shop_distance_m', 'gps_accuracy_m')`),
);
const col = (n: string) => cols.find((c) => c.column_name === n);
check("gps_accuracy_m accepts NULL (a WhatsApp pin)", col("gps_accuracy_m")?.is_nullable === "YES");
check("shop_distance_m present", !!col("shop_distance_m"));

// 3. The waiting-card query runs (jsonb path, stage filter) — for every ASM.
const asms = rows<{ id: string }>(await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'asm' AND is_active = true`));
let waiting = 0;
for (const a of asms) if (await loadProofRow({ userId: a.id, stages: ["location", "photo", "ready"] })) waiting++;
check("waiting-card query runs for all active ASMs", true, `${asms.length} ASMs, ${waiting} with a visit waiting for proof`);

// 4. Shop position from the first verified visit (geocoding off).
const verified = rows<{ lead: string; lat: number; lng: number; at: string }>(
    await db.execute(sql`
        SELECT dealer_lead_id AS lead, gps_check_in_lat::float8 AS lat, gps_check_in_lng::float8 AS lng,
               COALESCE((to_jsonb(v) ->> 'captured_at')::timestamptz, v.created_at)::text AS at
          FROM lead_visits v
         WHERE dealer_lead_id IS NOT NULL AND (to_jsonb(v) ->> 'verified') = 'true'
           AND gps_check_in_lat IS NOT NULL AND gps_check_in_lng IS NOT NULL
         ORDER BY dealer_lead_id, at`),
);
const byLead = new Map<string, typeof verified>();
for (const v of verified) byLead.set(v.lead, [...(byLead.get(v.lead) ?? []), v]);
const sample = [...byLead.keys()].slice(0, 5);
let positionsOk = 0;
for (const lead of sample) {
    const pos = await shopPosition(lead, async () => null);
    const first = byLead.get(lead)![0];
    if (pos?.from === "visit" && Math.abs(pos.lat - first.lat) < 1e-6 && Math.abs(pos.lng - first.lng) < 1e-6) positionsOk++;
}
check("shopPosition = the lead's first verified visit", positionsOk === sample.length, `${positionsOk}/${sample.length} sampled leads`);
const noAnchor = rows<{ id: string }>(
    await db.execute(sql`SELECT id FROM dealer_leads WHERE id NOT IN (SELECT dealer_lead_id FROM lead_visits WHERE dealer_lead_id IS NOT NULL) LIMIT 1`),
)[0];
if (noAnchor) check("a lead never visited has no position (first visit sets it)", (await shopPosition(noAnchor.id, async () => null)) === null);

// 5. Replay: every repeat verified visit against that lead's first one.
const dists: number[] = [];
for (const visits of byLead.values()) {
    for (const v of visits.slice(1)) dists.push(haversineMeters(v.lat, v.lng, visits[0].lat, visits[0].lng));
}
const within = dists.filter((d) => checkShopDistance(d).ok).length;
const pct = (n: number) => (dists.length ? `${Math.round((100 * n) / dists.length)}%` : "n/a");
const sorted = [...dists].sort((a, b) => a - b);
const q = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : 0);
console.log(
    `\nREPLAY  ${verified.length} verified visits on ${byLead.size} leads; ${dists.length} repeat visits.\n` +
        `        within ${MAX_SHOP_DISTANCE_M} m of the first visit: ${within} (${pct(within)}); refused: ${dists.length - within} (${pct(dists.length - within)})\n` +
        `        distance median ${q(0.5)} m, 90th pct ${q(0.9)} m, max ${q(1)} m`,
);
const acc = rows<{ n: number; med: number; p90: number }>(
    await db.execute(sql`
        SELECT count(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY gps_accuracy_m)::float8 AS med,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY gps_accuracy_m)::float8 AS p90
          FROM visit_captures WHERE gps_accuracy_m IS NOT NULL`),
)[0];
console.log(`        CRM captures' own GPS accuracy: median ${Math.round(acc?.med ?? 0)} m, 90th pct ${Math.round(acc?.p90 ?? 0)} m (n=${acc?.n ?? 0})`);

console.log(`\n${failed ? `${failed} FAILED` : "ALL PASS"} (read-only; nothing written)`);
process.exit(failed ? 1 : 0);
