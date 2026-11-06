// ID 205 — one-time fix (decided 2 Nov, Kartik): on quotes saved before the
// 29 Oct fix (f01958e6), clear any line "list price" that was really the OEM
// price, so a PDF re-made from an old quote never prints the OEM figure.
// Lead quotes (dealer_lead_commercials) and account quotations
// (account_quotations). The rule is in src/lib/leads/oemListPriceFix.ts.
//
// Already generated PDFs (quote_document_url / quote_pdf_url) do not change;
// only a re-made PDF is affected.
//
// Dry run by default: prints the database, per table how many quotes / lines
// would be cleared and how many lines are "unclear" (left alone). --apply
// writes a JSON backup of every row it changes first (reports/), then
// updates them in one transaction. On the live database --apply also needs
// --confirm-live (after Kartik's go-ahead). Re-running is a no-op.
//
//   node --import tsx --env-file=.env.local scripts/fix-id205-oem-list-prices.ts
//   node --import tsx --env-file=.env.production scripts/fix-id205-oem-list-prices.ts --apply --confirm-live
//   … --before=2026-10-29T13:40:00+05:30   the live deploy time of f01958e6 (default: its commit time)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { clearedLines, type FixLine, type OemEvalLine } from "@/lib/leads/oemListPriceFix";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const before = value("before") ?? "2026-10-29T13:40:00+05:30";
if (Number.isNaN(Date.parse(before))) throw new Error("--before must be a timestamp, e.g. 2026-10-29T13:40:00+05:30");
const apply = flag("apply");

type QuoteRow = { id: string; created_at: string; product_lines: FixLine[] | null; oem_evaluation: { lines?: OemEvalLine[] } | null };
type PriceRow = { asset_type: string; product_id: string; effective_from: string; effective_to: string | null };

const TABLES = [
    { table: "dealer_lead_commercials", pk: "commercial_id" },
    { table: "account_quotations", pk: "quotation_id" },
] as const;

async function tableExists(name: string): Promise<boolean> {
    const r = (await db.execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return !!r[0]?.ok;
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    const live = /database-2/i.test(host);
    console.log(`DB host: ${host}${live ? "  (LIVE)" : ""}  · quotes saved before ${before}  · ${apply ? "APPLY" : "dry run"}`);
    if (apply && live && !flag("confirm-live")) {
        throw new Error("this is the live database: add --confirm-live to --apply (after Kartik's go-ahead)");
    }

    const prices = (await tableExists("product_list_prices"))
        ? ((await db.execute(sql`
              SELECT asset_type, product_id, effective_from::text AS effective_from, effective_to::text AS effective_to
                FROM product_list_prices
          `)) as unknown as PriceRow[])
        : [];
    console.log(`product_list_prices: ${prices.length} rows`);
    const hadRealListPriceAt = (at: string) => (assetType: string, productId: string) =>
        prices.some(
            (p) =>
                p.asset_type === assetType &&
                p.product_id === productId &&
                Date.parse(p.effective_from) <= Date.parse(at) &&
                (p.effective_to == null || Date.parse(p.effective_to) > Date.parse(at)),
        );

    const changes: Array<{ table: string; pk: string; id: string; before: FixLine[]; after: FixLine[] }> = [];
    for (const t of TABLES) {
        if (!(await tableExists(t.table))) {
            console.log(`SKIP  ${t.table} is not on this database`);
            continue;
        }
        const rows = (await db.execute(sql`
            SELECT ${sql.raw(t.pk)}::text AS id, created_at::text AS created_at, product_lines, oem_evaluation
              FROM ${sql.raw(t.table)}
             WHERE created_at < ${before}::timestamptz
               AND jsonb_typeof(product_lines) = 'array'
               AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(product_lines) x
                    WHERE x ? 'list_price' AND jsonb_typeof(x -> 'list_price') <> 'null'
               )
        `)) as unknown as QuoteRow[];
        let lines = 0;
        let unclear = 0;
        for (const r of rows) {
            const res = clearedLines(r.product_lines ?? [], r.oem_evaluation?.lines ?? [], hadRealListPriceAt(r.created_at));
            unclear += res.unclear;
            if (res.cleared === 0) continue;
            lines += res.cleared;
            changes.push({ table: t.table, pk: t.pk, id: r.id, before: r.product_lines ?? [], after: res.lines });
        }
        const quotes = changes.filter((c) => c.table === t.table).length;
        console.log(
            `${t.table.padEnd(24)} ${rows.length} old quotes with a list price · ${quotes} quotes / ${lines} lines to clear · ${unclear} lines unclear (left)`,
        );
    }

    if (!apply) {
        console.log("\nDry run: nothing written. Post these counts in the tracker row; add --apply to clear.");
        process.exit(0);
    }
    if (changes.length === 0) {
        console.log("\nNothing to clear.");
        process.exit(0);
    }

    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `id205-oem-list-prices-backup-${host.split(".")[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ host, before, taken_at: new Date().toISOString(), rows: changes }, null, 1));
    console.log(`\nbacked up ${changes.length} rows → ${file}`);

    await db.transaction(async (tx) => {
        for (const c of changes) {
            await tx.execute(sql`
                UPDATE ${sql.raw(c.table)}
                   SET product_lines = ${JSON.stringify(c.after)}::jsonb
                 WHERE ${sql.raw(c.pk)}::text = ${c.id}
            `);
        }
    });
    console.log(`cleared list prices on ${changes.length} quotes. Re-run (dry) to confirm 0 left.`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
