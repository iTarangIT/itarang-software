/**
 * One-time Zoho backfill — customer GSTINs and invoice line items
 * (tracker ID 70 / handover P1-7; decided by Kartik, 27 Sep).
 *
 * zoho_invoices carries the Zoho customer_id but no GSTIN and no lines (the
 * hourly sync reads the LIST endpoint, which has neither). So no Zoho-era
 * invoice can match a dealer account, and long-standing dealers read
 * "Never ordered". While the Zoho account is still live this fetches, for
 * every synced invoice:
 *   GET /invoices/{id}  → its lines (HSN, quantity, rate, amount before tax)
 *                          and the customer GSTIN printed on it
 *   GET /contacts/{id}  → only for a customer none of whose invoices carried
 *                          a GSTIN (one call per such customer)
 * into invoice_line_items (source 'zoho') and zoho_customer_gstins (E-322).
 * revenueSource.ts then matches Zoho invoices on that GSTIN.
 *
 * Usage (reads DATABASE_URL — point it at the DB you mean):
 *   node --import tsx --env-file=.env.local scripts/backfill-zoho-gstin-lines.ts            # dry run, counts only
 *   node --import tsx --env-file=.env.local scripts/backfill-zoho-gstin-lines.ts --commit
 *   … --org=60060919257   one organization only
 *   … --max=50            stop after N invoices (a trial run)
 *
 * Resumable: an invoice that already has lines and a customer whose GSTIN was
 * already fetched are skipped, so an interrupted run continues where it
 * stopped. Throttled to ~80 calls / minute (Zoho allows 100), with backoff on
 * HTTP 429. Dry run makes NO Zoho calls and writes nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchInvoiceDetail } from "@/lib/zoho/invoices";
import { fetchContactGstin } from "@/lib/zoho/contacts";
import { classifyHsn, normalizeHsn } from "@/lib/sales/invoiceLines";
import { isValidGstin, normalizeGstin } from "@/lib/leads/gstin";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const ONLY_ORG = opt("org");
const MAX = opt("max") ? Number(opt("max")) : Infinity;
const MIN_GAP_MS = 750; // ≈ 80 calls / minute

type Row = Record<string, unknown>;
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let lastCall = 0;
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const wait = lastCall + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();
        try {
            return await fn();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/Zoho API 429/.test(msg) && attempt < 5) {
                const backoff = 30_000 * (attempt + 1);
                console.warn(`  429 — backing off ${backoff / 1000}s`);
                await new Promise((r) => setTimeout(r, backoff));
                continue;
            }
            throw e;
        }
    }
}

async function main() {
    const present = rows<{ ok: boolean }>(
        await db.execute(sql`SELECT to_regclass('public.invoice_line_items') IS NOT NULL
                              AND to_regclass('public.zoho_customer_gstins') IS NOT NULL AS ok`),
    );
    if (!present[0]?.ok) throw new Error("E-322 is not applied to this database (invoice_line_items / zoho_customer_gstins missing).");

    const invoices = rows<{ id: string; zoho_invoice_id: string; organization_id: string | null; customer_id: string | null; has_lines: boolean }>(
        await db.execute(sql`
            SELECT zi.id::text AS id, zi.zoho_invoice_id, zi.organization_id, zi.customer_id,
                   EXISTS (SELECT 1 FROM invoice_line_items l
                            WHERE l.source = 'zoho' AND l.invoice_id = zi.id::text) AS has_lines
              FROM zoho_invoices zi
             WHERE (${ONLY_ORG}::text IS NULL OR zi.organization_id = ${ONLY_ORG})
             ORDER BY zi.invoice_date DESC NULLS LAST
        `),
    );
    const done = new Set(
        rows<{ k: string }>(await db.execute(sql`SELECT organization_id || ':' || customer_id AS k FROM zoho_customer_gstins`)).map((r) => r.k),
    );

    const todo = invoices.filter((i) => !i.has_lines).slice(0, MAX);
    const customers = new Map<string, { org: string | null; customer: string }>();
    for (const i of invoices) {
        if (!i.customer_id) continue;
        const k = `${i.organization_id}:${i.customer_id}`;
        if (!done.has(k)) customers.set(k, { org: i.organization_id, customer: i.customer_id });
    }

    console.log(`Mode: ${COMMIT ? "COMMIT — calling Zoho and writing" : "DRY RUN — no Zoho calls, nothing written"}`);
    console.log(`Zoho invoices: ${invoices.length} (${invoices.length - invoices.filter((i) => !i.has_lines).length} already have lines)`);
    console.log(`Invoices to fetch: ${todo.length}${Number.isFinite(MAX) ? ` (capped by --max=${MAX})` : ""}`);
    console.log(`Customers without a fetched GSTIN: ${customers.size}`);
    console.log(`Estimated Zoho calls: ≤ ${todo.length + customers.size} (~${Math.ceil(((todo.length + customers.size) * MIN_GAP_MS) / 60_000)} min)`);
    if (!COMMIT) {
        console.log("\nNothing was written. Re-run with --commit.");
        return;
    }

    let lineRows = 0;
    let fetched = 0;
    let failed = 0;
    const gstinFromInvoice = new Map<string, string>();
    for (const inv of todo) {
        try {
            const d = await throttled(() => fetchInvoiceDetail(inv.zoho_invoice_id, inv.organization_id ?? undefined));
            await db.transaction(async (tx) => {
                await tx.execute(sql`DELETE FROM invoice_line_items WHERE source = 'zoho' AND invoice_id = ${inv.id}`);
                let n = 0;
                for (const l of d.line_items) {
                    n += 1;
                    const hsn = normalizeHsn(l.hsn_or_sac);
                    await tx.execute(sql`
                        INSERT INTO invoice_line_items
                               (source, invoice_id, line_no, item_name, hsn, product_class, quantity, rate, amount_excl_gst)
                        VALUES ('zoho', ${inv.id}, ${n}, ${l.name ?? l.description ?? null}, ${hsn},
                                ${classifyHsn(hsn)}, ${l.quantity ?? null}, ${l.rate ?? null}, ${l.item_total ?? null})
                    `);
                }
                lineRows += n;
            });
            const g = normalizeGstin(d.gst_no);
            if (inv.customer_id && isValidGstin(g)) gstinFromInvoice.set(`${inv.organization_id}:${inv.customer_id}`, g);
            fetched += 1;
            if (fetched % 25 === 0) console.log(`  ${fetched}/${todo.length} invoices, ${lineRows} lines`);
        } catch (e) {
            failed += 1;
            console.warn(`  ✗ ${inv.zoho_invoice_id}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
        }
    }

    let gstins = 0;
    let none = 0;
    let deferred = 0;
    // The contacts endpoint needs the ZohoInvoice.contacts.READ scope, which
    // the CRM's token may not have. The invoice detail already carries the
    // customer GSTIN, so contacts is only a fallback: on the first 401 stop
    // calling it and leave those customers unwritten, so a later run with the
    // scope (or after more invoices are fetched) picks them up.
    let contactsDenied = false;
    for (const [k, c] of customers) {
        try {
            let g = gstinFromInvoice.get(k) ?? null;
            if (!g) {
                if (contactsDenied) {
                    deferred += 1;
                    continue;
                }
                let raw: string | null;
                try {
                    raw = await throttled(() => fetchContactGstin(c.customer, c.org ?? undefined));
                } catch (e) {
                    if (/Zoho API 401/.test(e instanceof Error ? e.message : String(e))) {
                        contactsDenied = true;
                        deferred += 1;
                        console.warn("  contacts: 401 — the Zoho token lacks the contacts scope; using invoice GSTINs only.");
                        continue;
                    }
                    throw e;
                }
                const n = normalizeGstin(raw);
                g = isValidGstin(n) ? n : null;
            }
            await db.execute(sql`
                INSERT INTO zoho_customer_gstins (organization_id, customer_id, gstin)
                VALUES (${c.org ?? ""}, ${c.customer}, ${g})
                ON CONFLICT (organization_id, customer_id) DO UPDATE SET gstin = EXCLUDED.gstin, fetched_at = now()
            `);
            if (g) gstins += 1;
            else none += 1;
        } catch (e) {
            failed += 1;
            console.warn(`  ✗ customer ${c.customer}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
        }
    }

    console.log("\n================ SUMMARY ================");
    console.log(`invoices fetched      : ${fetched} (${lineRows} lines)`);
    console.log(`customers with GSTIN  : ${gstins}`);
    console.log(`customers without one : ${none}`);
    console.log(`customers deferred    : ${deferred}${deferred ? " — no GSTIN on their fetched invoices and /contacts unavailable; re-run later" : ""}`);
    console.log(`failures              : ${failed}${failed ? " — re-run to retry; done rows are skipped" : ""}`);
}

main()
    .then(() => process.exit(0))
    .catch((e: Row | Error) => {
        console.error(e);
        process.exit(1);
    });
