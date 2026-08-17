/**
 * The database lookup a quotation view needs, kept out of ./view so the mapper
 * stays pure and unit-testable. Same split as ./config vs ./config-store.
 *
 * BEST-EFFORT by design. It runs downstream of an approval that has already
 * committed, so it may not throw: a missing product master degrades the
 * document (a line marked "rate not set") rather than preventing the quotation
 * from existing.
 *
 * Place of supply used to live here too, resolved against the `states` table.
 * It doesn't any more — that table's `code` column holds alpha codes, not GST
 * codes, and the mismatch mis-taxed every intra-state quote. See ./gst-states.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { taxRefKey, type LineTaxRef } from "./view";

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
