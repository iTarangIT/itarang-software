/**
 * The two database lookups a quotation view needs, kept out of ./view so the
 * mapper stays pure and unit-testable. Same split as ./config vs ./config-store.
 *
 * Both are BEST-EFFORT by design. They run downstream of an approval that has
 * already committed, so neither may throw: a missing product master or an
 * unresolvable state degrades the document (a line marked "rate not set", a
 * place of supply printed without its code) rather than preventing the
 * quotation from existing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { taxRefKey, type LineTaxRef, type PlaceOfSupply } from "./view";

/** Which product-master table an asset_type names. Mirrors oemPrices.ts. */
const MASTER_TABLES: Record<string, string> = {
  battery: "product_master_batteries",
  charger: "product_master_chargers",
  paraphernalia: "product_master_paraphernalia",
};

/**
 * HSN and GST rate for every line, from the three product masters.
 *
 * Best-effort PER ASSET TYPE: a master table that errors — E-242 not yet
 * applied on that database, say — contributes no refs rather than taking the
 * whole document down. The lines it would have covered then render as "rate not
 * set", which is the same degraded state as an unfilled catalogue and is
 * visible on the document rather than silent.
 */
export async function loadLineTaxRefs(
  lines: CommercialsProductLine[],
): Promise<Map<string, LineTaxRef>> {
  const out = new Map<string, LineTaxRef>();
  if (!lines.length) return out;

  const byType = new Map<string, string[]>();
  for (const l of lines) {
    if (!MASTER_TABLES[l.asset_type] || !l.product_id) continue;
    const ids = byType.get(l.asset_type) ?? [];
    ids.push(l.product_id);
    byType.set(l.asset_type, ids);
  }

  for (const [assetType, ids] of byType) {
    const table = MASTER_TABLES[assetType];
    try {
      // id is uuid and product_id arrives as text — cast the uuid, never the
      // text, so a non-uuid product_id cannot raise
      // invalid_text_representation and take the document down. Same guard the
      // CEO quotation queue and listOemPriceHistory use.
      const rows = await db.execute<{
        product_id: string;
        hsn_code: string | null;
        gst_rate_pct: string | null;
      }>(sql`
        SELECT id::text AS product_id, hsn_code, gst_rate_pct::text AS gst_rate_pct
          FROM ${sql.raw(table)}
         WHERE id::text = ANY(${ids})
      `);
      for (const r of rows as unknown as Record<string, unknown>[]) {
        const rate = r.gst_rate_pct == null ? null : Number(r.gst_rate_pct);
        out.set(taxRefKey(assetType, String(r.product_id)), {
          hsnCode: r.hsn_code == null ? null : String(r.hsn_code),
          gstRatePct: rate != null && Number.isFinite(rate) ? rate : null,
        });
      }
    } catch (e) {
      console.error(`[quote-pdf/view-store] tax refs unavailable for ${assetType}`, e);
    }
  }

  return out;
}

/**
 * The dealer's state, as a code and as the document's label.
 *
 * dealer_leads.state holds a free-text state NAME, so this resolves it against
 * the `states` table to get the numeric GST state code that decides IGST vs
 * CGST+SGST. An unmatched state still prints its name — that is useful to a
 * reader — but yields no code, and computeTotals then treats the supply as
 * inter-state. See the reasoning there.
 */
export async function resolvePlaceOfSupply(
  stateName: string | null | undefined,
): Promise<PlaceOfSupply> {
  const name = (stateName ?? "").trim();
  if (!name) return { stateCode: null, label: null };

  try {
    const rows = await db.execute<{ code: string; name: string }>(sql`
      SELECT code, name FROM states WHERE LOWER(name) = LOWER(${name}) LIMIT 1
    `);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) return { stateCode: null, label: name };
    const code = String(row.code);
    return { stateCode: code, label: `${String(row.name)} (${code})` };
  } catch (e) {
    console.error("[quote-pdf/view-store] place of supply lookup failed", e);
    return { stateCode: null, label: name };
  }
}
