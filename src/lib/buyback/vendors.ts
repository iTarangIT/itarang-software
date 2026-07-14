/**
 * Vendor-leg reads (M09/M10).
 *
 * Raw SQL, like queries.ts, because every one of these is a multi-table join
 * that Drizzle's query builder makes longer rather than clearer.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { BuybackTx } from "./tx";

export interface VendorRow {
  id: string;
  entity_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  categories: unknown;
  regions: string[];
  payment_terms: string | null;
  active: boolean;
}

/**
 * Vendors eligible to be routed to.
 *
 * "Eligible" means: active vendor profile AND an ACTIVE business_entity_roles
 * row for SCRAP_VENDOR. That second condition is M18's AC — "unonboarded vendor
 * unselectable for routing" — expressed as a join rather than a check the
 * routing screen has to remember. Sprint 4 tightens what makes a role ACTIVE (a
 * signed agreement); this query does not change when it does.
 */
export async function listRoutableVendors(): Promise<VendorRow[]> {
  const rows = await db.execute(sql`
    SELECT
      sv.id, sv.entity_id, sv.categories, sv.regions, sv.payment_terms, sv.active,
      a.business_entity_name AS name,
      a.contact_email        AS email,
      a.contact_phone        AS phone,
      a.city, a.state
    FROM scrap_vendors sv
    JOIN accounts a ON a.id = sv.entity_id
    JOIN business_entity_roles ber
      ON ber.entity_id = sv.entity_id
     AND ber.role = 'SCRAP_VENDOR'
     AND ber.status = 'ACTIVE'
    WHERE sv.active
    ORDER BY a.business_entity_name
  `);

  return (rows as unknown as VendorRow[]).map((r) => ({
    ...r,
    regions: r.regions ?? [],
  }));
}

export interface ThreadLineRow {
  line_id: string;
  quantity: number;
  condition: "WORKING" | "DEAD";
  voltage: string | number;
  ah: string | number;
  ask_price: string | null;
  counter_price: string | null;
  agreed_price: string | null;
}

export interface ThreadRow {
  id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_email: string | null;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  quotation_no: string | null;
  quotation_pdf_s3: string | null;
  email_message_id: string | null;
  sent_at: Date | null;
  responded_at: Date | null;
  close_reason: string | null;
  lines: ThreadLineRow[];
  /** Σ qty × (counter ?? ask) — what this vendor is currently worth to us. */
  current_total: number | null;
}

/** Every vendor thread on a deal, itemized. Admin-only — this is never serialized to a dealer. */
export async function threadsForDeal(
  dealId: string,
  runner: BuybackTx | typeof db = db,
): Promise<ThreadRow[]> {
  const rows = await runner.execute(sql`
    SELECT
      vt.id, vt.vendor_id, vt.status, vt.quotation_no, vt.quotation_pdf_s3,
      vt.email_message_id, vt.sent_at, vt.responded_at, vt.close_reason,
      a.business_entity_name AS vendor_name,
      a.contact_email        AS vendor_email,
      COALESCE(
        json_agg(
          json_build_object(
            'line_id',       vtl.line_id,
            'quantity',      bl.quantity,
            'condition',     bl.condition,
            'voltage',       cv.voltage,
            'ah',            cv.ah,
            'ask_price',     vtl.ask_price,
            'counter_price', vtl.counter_price,
            'agreed_price',  vtl.agreed_price
          )
          ORDER BY cv.voltage, cv.ah
        ) FILTER (WHERE vtl.id IS NOT NULL),
        '[]'
      ) AS lines,
      -- The vendor's live worth: their counter where they have made one, our ask
      -- where they have not. The prototype showed a single "last" number per
      -- vendor, which cannot express a partial counter.
      SUM(bl.quantity * COALESCE(vtl.counter_price, vtl.ask_price)) AS current_total
    FROM vendor_threads vt
    JOIN scrap_vendors sv ON sv.id = vt.vendor_id
    JOIN accounts a       ON a.id = sv.entity_id
    LEFT JOIN vendor_thread_lines vtl ON vtl.thread_id = vt.id
    LEFT JOIN buyback_lines bl        ON bl.id = vtl.line_id
    LEFT JOIN catalog_variants cv     ON cv.id = bl.variant_id
    WHERE vt.deal_id = ${dealId}
    GROUP BY vt.id, a.business_entity_name, a.contact_email
    ORDER BY vt.created_at
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    vendor_id: String(r.vendor_id),
    vendor_name: String(r.vendor_name),
    vendor_email: (r.vendor_email as string) ?? null,
    status: r.status as ThreadRow["status"],
    quotation_no: (r.quotation_no as string) ?? null,
    quotation_pdf_s3: (r.quotation_pdf_s3 as string) ?? null,
    email_message_id: (r.email_message_id as string) ?? null,
    sent_at: (r.sent_at as Date) ?? null,
    responded_at: (r.responded_at as Date) ?? null,
    close_reason: (r.close_reason as string) ?? null,
    lines: (r.lines as ThreadLineRow[]) ?? [],
    current_total: r.current_total === null ? null : Number(r.current_total),
  }));
}

/**
 * Where the batteries are, at the granularity a vendor is allowed to know.
 *
 * City + state, never the address line or pincode (M09 AC). Prefers the request's
 * chosen pickup address, falling back to the dealer entity's own city/state.
 */
export async function pickupLocation(
  requestId: string,
  runner: BuybackTx | typeof db = db,
): Promise<{ city: string | null; state: string | null }> {
  const rows = await runner.execute(sql`
    SELECT
      COALESCE(pa.city,  a.city)  AS city,
      COALESCE(pa.state, a.state) AS state
    FROM buyback_requests br
    JOIN accounts a ON a.id = br.dealer_entity_id
    LEFT JOIN buyback_batches bb        ON bb.request_id = br.id
    LEFT JOIN buyback_pickup_addresses pa ON pa.id = bb.pickup_address_id
    WHERE br.id = ${requestId}
    LIMIT 1
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  return {
    city: (row?.city as string) ?? null,
    state: (row?.state as string) ?? null,
  };
}

/**
 * A few photos per line, for the quotation PDF (M09: "per-SKU asks + condition
 * + photos").
 *
 * Capped hard. A vendor quotation with 6 photos × 4 lines inlined as base64 is a
 * multi-megabyte email that mail providers will bounce or spam-bin — and the
 * vendor is pricing a SKU, not inspecting each cell. The full set stays in the
 * portal.
 */
export async function quotationPhotoKeys(
  requestId: string,
  perLine = 2,
  runner: BuybackTx | typeof db = db,
): Promise<Record<string, string[]>> {
  const rows = await runner.execute(sql`
    SELECT line_id, s3_key
    FROM (
      SELECT
        bp.line_id,
        COALESCE(bp.s3_key_display, bp.s3_key_original) AS s3_key,
        ROW_NUMBER() OVER (PARTITION BY bp.line_id ORDER BY bp.created_at) AS rn
      FROM buyback_photos bp
      JOIN buyback_lines bl   ON bl.id = bp.line_id
      JOIN buyback_batches bb ON bb.id = bl.batch_id
      WHERE bb.request_id = ${requestId}
    ) ranked
    WHERE rn <= ${perLine}
  `);

  const out: Record<string, string[]> = {};
  for (const r of rows as unknown as Array<{ line_id: string; s3_key: string }>) {
    if (!r.s3_key) continue;
    (out[r.line_id] ??= []).push(r.s3_key);
  }
  return out;
}

/** The lock rows for the deal's CURRENT offer version — what we ask vendors for. */
export async function currentLocks(
  dealId: string,
  runner: BuybackTx | typeof db = db,
): Promise<
  Array<{
    line_id: string;
    quantity: number;
    condition: "WORKING" | "DEAD";
    voltage: string;
    ah: string;
    dealer_price: string;
    vendor_ask: string | null;
  }>
> {
  const rows = await runner.execute(sql`
    SELECT
      dll.line_id, dll.dealer_price, dll.vendor_ask,
      bl.quantity, bl.condition,
      cv.voltage, cv.ah
    FROM deal_line_locks dll
    JOIN buyback_deals bd  ON bd.id = dll.deal_id
                          AND bd.offer_version = dll.offer_version
    JOIN buyback_lines bl  ON bl.id = dll.line_id
    JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE dll.deal_id = ${dealId}
    ORDER BY cv.voltage, cv.ah
  `);

  return rows as unknown as Array<{
    line_id: string;
    quantity: number;
    condition: "WORKING" | "DEAD";
    voltage: string;
    ah: string;
    dealer_price: string;
    vendor_ask: string | null;
  }>;
}
