/**
 * E-322 (tracker IDs 39, 71 / handover P1-8, P1-9) — applying a parsed Vyapar
 * sales register or GSTR-1 file. Parsing is ./vyaparParse.ts (pure).
 *
 * Sales register (weekly; Kartik, 26 Sep: batteries sold come from invoices
 * only). For each invoice in the file:
 *   * matched to sales_invoices by the normalised invoice number (the same
 *     dedupe key the Drive scan uses); an invoice the PDFs never produced is
 *     created with source 'vyapar';
 *   * the register OVERRIDES the PDF reading where it is better: the party
 *     GSTIN (so the invoice matches a dealer account) and the line items —
 *     replaced as a set in invoice_line_items (source 'vyapar');
 *   * an invoice the register lists as cancelled is voided (invoice_voids,
 *     origin 'vyapar'), which takes it out of revenue.
 * Lines are mapped to CRM products through vyapar_item_map; unmapped item
 * names are listed for someone to map (mapping back-fills earlier lines).
 *
 * GSTR-1: the filed rows go to gstr1_entries for the monthly reconciliation.
 * A re-import of the same month replaces that month's rows.
 *
 * Each import is recorded in invoice_imports with its summary.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { normalizeInvoiceNumber } from "@/lib/sales/normalizeInvoiceNumber";
import { resolveSalesOrg } from "@/lib/sales/resolveSalesOrg";
import { itemKey } from "@/lib/sales/invoiceLines";
import { voidInvoice } from "@/lib/sales/invoiceVoids";
import type { ImportKind, ParseResult, ParsedDocument } from "@/lib/sales/vyaparParse";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Runner = typeof db | Tx;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export interface ImportPlanRow {
    number: string;
    date: string | null;
    party: string | null;
    gstin: string | null;
    doc_type: "invoice" | "credit_note";
    cancelled: boolean;
    lines: number;
    batteries: number;
    taxable: number | null;
    /** invoice_imports apply outcome: 'update' an existing invoice, or 'create'. */
    action: "update" | "create" | "gstr1";
    existing_id: string | null;
}

export interface ImportPreview {
    kind: ImportKind;
    sheet: string | null;
    columns: ParseResult["columns"];
    unknown_columns: string[];
    warnings: string[];
    period: { from: string | null; to: string | null };
    totals: {
        documents: number;
        update: number;
        create: number;
        cancelled: number;
        lines: number;
        batteries: number;
        unmapped_items: number;
    };
    unmapped_items: string[];
    rows: ImportPlanRow[];
}

async function existingByKey(runner: Runner, keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const rows = rowsOf<{ k: string; id: string }>(
        await runner.execute(sql`
            SELECT invoice_number_key AS k, id::text AS id FROM sales_invoices
             WHERE invoice_number_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`),
    );
    return new Map(rows.map((r) => [r.k, r.id]));
}

async function mappedItems(runner: Runner): Promise<Map<string, { asset_type: string | null; product_id: string | null }>> {
    const rows = rowsOf<{ item_key: string; asset_type: string | null; product_id: string | null }>(
        await runner.execute(sql`SELECT item_key, asset_type, product_id FROM vyapar_item_map WHERE product_id IS NOT NULL`),
    );
    return new Map(rows.map((r) => [r.item_key, r]));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function batteriesOf(d: ParsedDocument): number {
    return sum(d.lines.filter((l) => l.product_class === "battery").map((l) => l.quantity ?? 0));
}

export async function previewImport(parsed: ParseResult): Promise<ImportPreview> {
    const docs = parsed.documents;
    const keyOf = (d: ParsedDocument) => normalizeInvoiceNumber(d.number);
    const existing =
        parsed.kind === "vyapar_register"
            ? await existingByKey(db, docs.map(keyOf).filter((k): k is string => !!k))
            : new Map<string, string>();
    const mapped = await mappedItems(db);
    const unmapped = new Set<string>();
    const rows: ImportPlanRow[] = docs.map((d) => {
        for (const l of d.lines) if (l.item_name && !mapped.has(itemKey(l.item_name))) unmapped.add(l.item_name);
        const id = existing.get(keyOf(d) ?? "") ?? null;
        return {
            number: d.number,
            date: d.date,
            party: d.party,
            gstin: d.gstin,
            doc_type: d.doc_type,
            cancelled: d.cancelled,
            lines: d.lines.length,
            batteries: batteriesOf(d),
            taxable: d.taxable,
            action: parsed.kind === "gstr1" ? "gstr1" : id ? "update" : "create",
            existing_id: id,
        };
    });
    const dates = docs.map((d) => d.date).filter((d): d is string => !!d).sort();
    return {
        kind: parsed.kind,
        sheet: parsed.sheet,
        columns: parsed.columns,
        unknown_columns: parsed.unknown_columns,
        warnings: parsed.warnings,
        period: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
        totals: {
            documents: rows.length,
            update: rows.filter((r) => r.action === "update").length,
            create: rows.filter((r) => r.action === "create").length,
            cancelled: rows.filter((r) => r.cancelled).length,
            lines: sum(rows.map((r) => r.lines)),
            batteries: sum(rows.map((r) => r.batteries)),
            unmapped_items: unmapped.size,
        },
        unmapped_items: [...unmapped].sort(),
        rows,
    };
}

export async function commitImport(
    parsed: ParseResult,
    meta: { fileName: string | null; actorId: string },
): Promise<{ import_id: string; summary: ImportPreview["totals"] & { voided: number; created_ids: number } }> {
    const preview = await previewImport(parsed);
    if (!parsed.documents.length) throw new Error("Nothing to import — no documents were read from the file.");

    return db.transaction(async (tx) => {
        const [imp] = rowsOf<{ id: string }>(
            await tx.execute(sql`
                INSERT INTO invoice_imports (kind, file_name, period_from, period_to, summary, imported_by)
                VALUES (${parsed.kind}, ${meta.fileName}, ${preview.period.from}::date, ${preview.period.to}::date,
                        ${JSON.stringify(preview.totals)}::jsonb, ${meta.actorId}::uuid)
                RETURNING id::text AS id`),
        );
        let voided = 0;
        let created = 0;

        if (parsed.kind === "gstr1") {
            const months = [...new Set(parsed.documents.map((d) => (d.date ? d.date.slice(0, 7) + "-01" : null)).filter(Boolean))] as string[];
            if (months.length) {
                await tx.execute(sql`DELETE FROM gstr1_entries WHERE month IN (${sql.join(months.map((m) => sql`${m}::date`), sql`, `)})`);
            }
            for (const d of parsed.documents) {
                if (!d.date) continue;
                await tx.execute(sql`
                    INSERT INTO gstr1_entries (import_id, month, doc_type, doc_number, doc_number_key, doc_date, gstin, taxable_value, tax, total)
                    VALUES (${imp.id}::uuid, ${d.date.slice(0, 7) + "-01"}::date, ${d.doc_type}, ${d.number},
                            ${normalizeInvoiceNumber(d.number) ?? d.number.toUpperCase()}, ${d.date}::date, ${d.gstin},
                            ${d.taxable}, ${d.tax}, ${d.total})`);
            }
            return { import_id: imp.id, summary: { ...preview.totals, voided, created_ids: 0 } };
        }

        const mapped = await mappedItems(tx);
        for (const d of parsed.documents) {
            if (d.doc_type === "credit_note") continue; // credit notes arrive through their own Drive folder
            const key = normalizeInvoiceNumber(d.number);
            if (!key) continue;
            let id = preview.rows.find((r) => r.number === d.number)?.existing_id ?? null;
            if (!id) {
                const org = resolveSalesOrg({ invoiceNumber: d.number });
                const [row] = rowsOf<{ id: string }>(
                    await tx.execute(sql`
                        INSERT INTO sales_invoices (source, invoice_number, invoice_number_key, invoice_date, customer_name,
                                                    customer_gstin, organization_id, sub_total, tax_total, total, status)
                        VALUES ('vyapar', ${d.number}, ${key}, ${d.date}::date, ${d.party}, ${d.gstin},
                                ${org.organizationId}, ${d.taxable}, ${d.tax}, ${d.total}, 'sent')
                        ON CONFLICT DO NOTHING
                        RETURNING id::text AS id`),
                );
                if (!row) {
                    // Raced with a Drive scan that just created it.
                    id = (await existingByKey(tx, [key])).get(key) ?? null;
                } else {
                    id = row.id;
                    created++;
                }
                if (!id) continue;
            } else if (d.gstin) {
                // The register's party GSTIN overrides the PDF reading.
                await tx.execute(sql`
                    UPDATE sales_invoices SET customer_gstin = ${d.gstin}, updated_at = now()
                     WHERE id = ${id}::uuid AND customer_gstin IS DISTINCT FROM ${d.gstin}`);
            }

            if (d.lines.length) {
                await tx.execute(sql`DELETE FROM invoice_line_items WHERE invoice_id = ${id} AND source IN ('vyapar', 'drive')`);
                let n = 0;
                for (const l of d.lines) {
                    n++;
                    const m = l.item_name ? mapped.get(itemKey(l.item_name)) : undefined;
                    await tx.execute(sql`
                        INSERT INTO invoice_line_items (source, invoice_id, line_no, item_name, hsn, product_class,
                                                        asset_type, product_id, quantity, rate, amount_excl_gst, import_id)
                        VALUES ('vyapar', ${id}, ${n}, ${l.item_name}, ${l.hsn}, ${l.product_class},
                                ${m?.asset_type ?? null}, ${m?.product_id ?? null}, ${l.quantity}, ${l.rate},
                                ${l.amount_excl_gst}, ${imp.id}::uuid)`);
                }
            }
            if (d.cancelled) {
                const r = await voidInvoice(
                    { source: "drive", invoiceId: id, reason: "Cancelled in Vyapar (sales register import)", origin: "vyapar", actorId: meta.actorId },
                    tx,
                );
                if (r.voided) voided++;
            }
        }
        // Remember every item name seen, mapped or not, so the mapping list is complete.
        for (const name of preview.unmapped_items) {
            await tx.execute(sql`
                INSERT INTO vyapar_item_map (item_key, item_name) VALUES (${itemKey(name)}, ${name})
                ON CONFLICT (item_key) DO NOTHING`);
        }
        return { import_id: imp.id, summary: { ...preview.totals, voided, created_ids: created } };
    });
}

/** Map a Vyapar item name to a CRM product; back-fills lines already imported. */
export async function mapVyaparItem(input: {
    itemName: string;
    assetType: string | null;
    productId: string | null;
    actorId: string;
}): Promise<{ lines_updated: number }> {
    const key = itemKey(input.itemName);
    return db.transaction(async (tx) => {
        await tx.execute(sql`
            INSERT INTO vyapar_item_map (item_key, item_name, asset_type, product_id, mapped_by)
            VALUES (${key}, ${input.itemName}, ${input.assetType}, ${input.productId}, ${input.actorId}::uuid)
            ON CONFLICT (item_key) DO UPDATE SET asset_type = EXCLUDED.asset_type, product_id = EXCLUDED.product_id,
                                                 mapped_by = EXCLUDED.mapped_by, updated_at = now()`);
        const res = rowsOf<{ n: number }>(
            await tx.execute(sql`
                WITH u AS (
                    UPDATE invoice_line_items SET asset_type = ${input.assetType}, product_id = ${input.productId}
                     WHERE lower(regexp_replace(btrim(item_name), '\\s+', ' ', 'g')) = ${key}
                    RETURNING 1)
                SELECT count(*)::int AS n FROM u`),
        );
        return { lines_updated: res[0]?.n ?? 0 };
    });
}
