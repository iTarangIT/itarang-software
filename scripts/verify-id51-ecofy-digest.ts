/**
 * READ-ONLY preview of Sales Daily Block G (Ecofy) — tracker ID 51 #4.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id51-ecofy-digest.ts [istDay]
 *
 * Runs the digest's REAL builder (salesDailyDigest.collect, the same call the
 * mail ticker makes) on a read-only connection, prints Block G as the email
 * would show it, and recounts the block with plain queries written here (a
 * different query, the same definition). A mismatch exits 1. Never sends mail,
 * never writes: the connection has default_transaction_read_only=on.
 *
 * istDay = the day the mail COVERS (YYYY-MM-DD), default yesterday in IST.
 * To point at the other database, override DATABASE_URL in the command env.
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL = base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

function istYesterday(): string {
    const now = new Date(Date.now() + 5.5 * 3600_000);
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString().slice(0, 10);
}

async function main() {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@/lib/db");
    const { salesDailyDigest } = await import("@/lib/digests/kinds/sales-daily");

    const istDay = process.argv[2] ?? istYesterday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(istDay)) throw new Error("istDay must be YYYY-MM-DD");
    const host = (base.match(/@([^:/]+)/)?.[1] ?? "?").split(".")[0];
    console.log(`Sales Daily Block G — covering ${istDay} — database host ${host}`);

    // 1 · What the database holds.
    const probe = (await db.execute(sql`SELECT to_regclass('public.ecofy_leads') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!probe[0]?.ok) {
        console.log("ecofy_leads does not exist on this database — Block G will say it could not be read.");
    }
    const recount = probe[0]?.ok
        ? {
              total: Number(((await db.execute(sql`SELECT COUNT(*)::int AS n FROM ecofy_leads`)) as unknown as Array<{ n: number }>)[0]?.n ?? 0),
              queue: Number(
                  ((await db.execute(sql`
                      SELECT COUNT(*)::int AS n FROM ecofy_leads WHERE stage = 'S1' AND assigned_to_user_id IS NULL
                  `)) as unknown as Array<{ n: number }>)[0]?.n ?? 0,
              ),
              newDay: Number(
                  ((await db.execute(sql`
                      SELECT COUNT(*)::int AS n FROM ecofy_leads
                       WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDay}::date
                  `)) as unknown as Array<{ n: number }>)[0]?.n ?? 0,
              ),
              stages: (await db.execute(sql`
                  SELECT COALESCE(stage, '(none)') AS stage, COUNT(*)::int AS n FROM ecofy_leads GROUP BY 1 ORDER BY 1
              `)) as unknown as Array<{ stage: string; n: number }>,
          }
        : null;
    if (recount) {
        console.log(`ecofy_leads rows: ${recount.total} · by stage: ${recount.stages.map((s) => `${s.stage}=${s.n}`).join(", ") || "—"}`);
    }

    // 2 · The real builder.
    const t0 = Date.now();
    const out = await salesDailyDigest.collect(istDay);
    console.log(`collect(): ok=${out.ok} in ${Date.now() - t0} ms${out.error ? ` — error: ${out.error}` : ""}`);
    const g = out.figures.tables?.find((t) => t.key === "block_g");
    if (!g) {
        console.log("Block G missing from the figures.");
        process.exit(1);
    }
    console.log(`\n${g.title}`);
    if (g.note) console.log(`  (${g.note})`);
    if (g.rows.length === 0) console.log(`  ${g.empty ?? "(empty)"}`);
    for (const r of g.rows) {
        const [label, ...vals] = r;
        console.log(vals.every((v) => v === "") ? `  ── ${label}` : `  ${String(label).padEnd(34)} ${vals.join("  ")}`);
    }

    // 3 · Recount vs block.
    if (!recount) return;
    const val = (label: string) => g.rows.find((r) => r[0] === label)?.[1];
    const checks: Array<[string, unknown, number]> = [
        ["Pickup queue (unassigned)", val("Pickup queue (unassigned)"), recount.queue],
        ["New leads yesterday", val("New leads yesterday"), recount.newDay],
        ["All Ecofy leads", val("All Ecofy leads") ?? 0, recount.total],
    ];
    let bad = 0;
    console.log("\nRecount (block vs plain query):");
    for (const [label, got, want] of checks) {
        const ok = Number(got) === want;
        if (!ok) bad++;
        console.log(`  ${ok ? "OK  " : "DIFF"} ${label.padEnd(28)} block=${String(got)} recount=${want}`);
    }
    if (bad) process.exit(1);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
