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
 * Resumable: an invoice already read (E-340 zoho_invoice_line_fetches, or
 * lines present) and a customer whose GSTIN was already fetched are skipped,
 * so an interrupted run continues where it stopped. A customer is written as
 * "no GSTIN" only once every one of their invoices has been read — a --max
 * trial run defers the rest instead of storing a NULL that is never retried.
 * Item names seen are added to Invoice Ledger › Item mapping (vyapar_item_map),
 * and a GSTIN refused by the check is kept as refused_gstin (E-340) so the
 * invoice shows in Needs attention. Throttled to ~80 calls / minute (Zoho allows 100), with backoff on
 * HTTP 429. Dry run makes NO Zoho calls and writes nothing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchInvoiceDetail } from "@/lib/zoho/invoices";
import { fetchContactGstin } from "@/lib/zoho/contacts";
import { classifyHsn, normalizeHsn } from "@/lib/sales/invoiceLines";
import { classFor, itemKeySql, mappedItems, productFor } from "@/lib/sales/itemMap";
import { screenCustomerGstin } from "@/lib/leads/gstin";

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
    const e340 =
        rows<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.zoho_invoice_line_fetches') IS NOT NULL AS ok`))[0]?.ok ?? false;
    if (!e340) console.warn("E-340 is not applied: invoices Zoho holds with no lines are re-read every run, and refused GSTINs are not kept.");
    const readMarker = e340
        ? sql`EXISTS (SELECT 1 FROM zoho_invoice_line_fetches f WHERE f.invoice_id = zi.id::text)`
        : sql`FALSE`;

    const invoices = rows<{ id: string; zoho_invoice_id: string; organization_id: string | null; customer_id: string | null; has_lines: boolean }>(
        await db.execute(sql`
            SELECT zi.id::text AS id, zi.zoho_invoice_id, zi.organization_id, zi.customer_id,
                   (EXISTS (SELECT 1 FROM invoice_line_items l
                             WHERE l.source = 'zoho' AND l.invoice_id = zi.id::text) OR ${readMarker}) AS has_lines
              FROM zoho_invoices zi
             WHERE (${ONLY_ORG}::text IS NULL OR zi.organization_id = ${ONLY_ORG})
             ORDER BY zi.invoice_date DESC NULLS LAST
        `),
    );
    const done = new Set(
        rows<{ k: string }>(await db.execute(sql`SELECT organization_id || ':' || customer_id AS k FROM zoho_customer_gstins`)).map((r) => r.k),
    );

    const todo = invoices.filter((i) => !i.has_lines).slice(0, MAX);
    const customers = new Map<string, { org: string | null; customer: string; unread: number }>();
    for (const i of invoices) {
        if (!i.customer_id) continue;
        const k = `${i.organization_id}:${i.customer_id}`;
        if (done.has(k)) continue;
        const c = customers.get(k) ?? { org: i.organization_id, customer: i.customer_id, unread: 0 };
        if (!i.has_lines) c.unread += 1;
        customers.set(k, c);
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
    let gone = 0;
    const gstinFromInvoice = new Map<string, string>();
    // ID 62 — GSTINs refused by the check (bad check character, or iTarang's
    // own), listed at the end for finance instead of being dropped silently.
    const refused: Array<{ where: string; reason: string }> = [];
    const refusedByCustomer = new Map<string, { gstin: string; reason: string }>();
    // ID 147 — lines of an item already mapped land linked to its product.
    const mapped = await mappedItems();
    for (const inv of todo) {
        try {
            const d = await throttled(() => fetchInvoiceDetail(inv.zoho_invoice_id, inv.organization_id ?? undefined));
            await db.transaction(async (tx) => {
                await tx.execute(sql`DELETE FROM invoice_line_items WHERE source = 'zoho' AND invoice_id = ${inv.id}`);
                let n = 0;
                for (const l of d.line_items) {
                    n += 1;
                    const hsn = normalizeHsn(l.hsn_or_sac);
                    const name = l.name ?? l.description ?? null;
                    const m = productFor(mapped, name);
                    await tx.execute(sql`
                        INSERT INTO invoice_line_items
                               (source, invoice_id, line_no, item_name, hsn, product_class, asset_type, product_id,
                                quantity, rate, amount_excl_gst)
                        VALUES ('zoho', ${inv.id}, ${n}, ${name}, ${hsn}, ${classFor(m, classifyHsn(hsn))}, ${m.asset_type},
                                ${m.product_id}, ${l.quantity ?? null}, ${l.rate ?? null}, ${l.item_total ?? null})
                    `);
                }
                if (e340) {
                    await tx.execute(sql`
                        INSERT INTO zoho_invoice_line_fetches (invoice_id, line_count) VALUES (${inv.id}, ${n})
                        ON CONFLICT (invoice_id) DO UPDATE SET line_count = EXCLUDED.line_count, fetched_at = now()`);
                }
                lineRows += n;
            });
            const k = `${inv.organization_id}:${inv.customer_id}`;
            const g = screenCustomerGstin(d.gst_no);
            if (g.attention) {
                refused.push({ where: `invoice ${inv.zoho_invoice_id}`, reason: g.attention });
                if (d.gst_no) refusedByCustomer.set(k, { gstin: d.gst_no, reason: g.attention });
            }
            if (inv.customer_id && g.gstin) gstinFromInvoice.set(k, g.gstin);
            const c = customers.get(k);
            if (c) c.unread -= 1;
            fetched += 1;
            if (fetched % 25 === 0) console.log(`  ${fetched}/${todo.length} invoices, ${lineRows} lines`);
        } catch (e) {
            // Deleted in Zoho since the sync copied it: nothing to read, ever.
            // Mark it read (0 lines) so it neither blocks its customer nor is retried.
            if (e340 && /Zoho API 404/.test(e instanceof Error ? e.message : String(e))) {
                gone += 1;
                await db.execute(sql`
                    INSERT INTO zoho_invoice_line_fetches (invoice_id, line_count) VALUES (${inv.id}, 0)
                    ON CONFLICT (invoice_id) DO NOTHING`);
                const c = customers.get(`${inv.organization_id}:${inv.customer_id}`);
                if (c) c.unread -= 1;
                continue;
            }
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
            let refusedHere = g ? null : (refusedByCustomer.get(k) ?? null);
            if (!g) {
                // Some of this customer's invoices are still unread (a --max
                // run, or a fetch failed): one of them may carry the GSTIN, so
                // don't store "none" yet.
                if (c.unread > 0) {
                    deferred += 1;
                    continue;
                }
                if (contactsDenied && !refusedHere) {
                    deferred += 1;
                    continue;
                }
                let raw: string | null = null;
                if (!contactsDenied) {
                    try {
                        raw = await throttled(() => fetchContactGstin(c.customer, c.org ?? undefined));
                    } catch (e) {
                        if (!/Zoho API 401/.test(e instanceof Error ? e.message : String(e))) throw e;
                        contactsDenied = true;
                        console.warn("  contacts: 401 — the Zoho token lacks the contacts scope; using invoice GSTINs only.");
                        // A refused invoice GSTIN is still worth keeping (Needs attention).
                        if (!refusedHere) {
                            deferred += 1;
                            continue;
                        }
                    }
                }
                const screened = screenCustomerGstin(raw);
                if (screened.attention) {
                    refused.push({ where: `customer ${c.customer}`, reason: screened.attention });
                    if (raw) refusedHere = { gstin: raw, reason: screened.attention };
                }
                g = screened.gstin;
            }
            if (g) refusedHere = null;
            if (e340) {
                await db.execute(sql`
                    INSERT INTO zoho_customer_gstins (organization_id, customer_id, gstin, refused_gstin, refused_reason)
                    VALUES (${c.org ?? ""}, ${c.customer}, ${g}, ${refusedHere?.gstin ?? null}, ${refusedHere?.reason ?? null})
                    ON CONFLICT (organization_id, customer_id) DO UPDATE
                       SET gstin = EXCLUDED.gstin, refused_gstin = EXCLUDED.refused_gstin,
                           refused_reason = EXCLUDED.refused_reason, fetched_at = now()
                `);
            } else {
                await db.execute(sql`
                    INSERT INTO zoho_customer_gstins (organization_id, customer_id, gstin)
                    VALUES (${c.org ?? ""}, ${c.customer}, ${g})
                    ON CONFLICT (organization_id, customer_id) DO UPDATE SET gstin = EXCLUDED.gstin, fetched_at = now()
                `);
            }
            if (g) gstins += 1;
            else none += 1;
        } catch (e) {
            failed += 1;
            console.warn(`  ✗ customer ${c.customer}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
        }
    }

    // Every Zoho item name, mapped or not — this run's and earlier runs' — so
    // Item mapping lists it (as the Vyapar import does).
    const listed = rows<{ n: number }>(
        await db.execute(sql`
            WITH ins AS (
                INSERT INTO vyapar_item_map (item_key, item_name)
                SELECT DISTINCT ON (k) k, name
                  FROM (SELECT ${itemKeySql(sql`l.item_name`)} AS k, btrim(l.item_name) AS name
                          FROM invoice_line_items l
                         WHERE l.source = 'zoho' AND btrim(COALESCE(l.item_name, '')) <> '') s
                ON CONFLICT (item_key) DO NOTHING
                RETURNING 1)
            SELECT COUNT(*)::int AS n FROM ins`),
    )[0]?.n ?? 0;

    console.log("\n================ SUMMARY ================");
    console.log(`invoices fetched      : ${fetched} (${lineRows} lines)`);
    console.log(`invoices gone in Zoho : ${gone}${gone ? " — deleted in Zoho after the sync copied them; marked read, no lines" : ""}`);
    console.log(`customers with GSTIN  : ${gstins}`);
    console.log(`customers without one : ${none}`);
    console.log(`customers deferred    : ${deferred}${deferred ? " — invoices still unread, or no GSTIN on them and /contacts unavailable; re-run later" : ""}`);
    console.log(`item names added      : ${listed} (Invoice Ledger › Item mapping)`);
    console.log(`failures              : ${failed}${failed ? " — re-run to retry; done rows are skipped" : ""}`);
    console.log(`GSTINs refused        : ${refused.length}${refused.length ? " — not matched to a dealer; fix them in Zoho or link by hand:" : ""}`);
    for (const r of refused) console.log(`  needs attention  ${r.where}: ${r.reason}`);
}

main()
    .then(() => process.exit(0))
    .catch((e: Row | Error) => {
        console.error(e);
        process.exit(1);
    });
