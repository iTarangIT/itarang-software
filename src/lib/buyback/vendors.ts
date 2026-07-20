/**
 * Vendor-leg reads (M09/M10).
 *
 * Raw SQL, like queries.ts, because every one of these is a multi-table join
 * that Drizzle's query builder makes longer rather than clearer.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { NotFoundError } from "./errors";
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
  /** Battery photo row ids for this line — bytes served by the vendor photo route. */
  photos: { id: string }[];
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
            'agreed_price',  vtl.agreed_price,
            -- Battery photo ids for this line (capped). IDs only — the vendor
            -- photo route re-scopes each id to the caller's own thread before it
            -- serves bytes, so an id is safe to hand over; a key never is.
            'photos', COALESCE((
              SELECT json_agg(pj) FROM (
                SELECT json_build_object('id', p.id) AS pj
                FROM buyback_photos p
                WHERE p.line_id = vtl.line_id
                ORDER BY p.created_at
                LIMIT 12
              ) ph
            ), '[]'::json)
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

/** A vendor awaiting approval, plus what they told us about themselves. */
export interface PendingVendorRow extends VendorRow {
  gstin: string | null;
  pan: string | null;
  /** 'vendor_self' — they registered themselves; 'vendor_manual' — an admin added them. */
  onboarding_status: string | null;
  registered_at: Date | null;
  /** Whether a login exists for this vendor (self-registration always makes one). */
  has_login: boolean;
}

/**
 * Vendors who have registered but nobody has vetted (E-195).
 *
 * The counterpart to listRoutableVendors, and the reason self-serve sign-up is
 * safe: a registrant lands with business_entity_roles.status = 'PENDING', which
 * that query joins away, so they cannot be routed a single deal. But a PENDING
 * vendor nobody can SEE is a vendor nobody can approve — self-registration
 * without this list would be a trapdoor, not a queue.
 *
 * Deliberately shows gstin/pan: this list is where a human decides whether the
 * firm is real, and those are what they check.
 */
export async function listPendingVendors(): Promise<PendingVendorRow[]> {
  const rows = await db.execute(sql`
    SELECT
      sv.id, sv.entity_id, sv.categories, sv.regions, sv.payment_terms, sv.active,
      a.business_entity_name AS name,
      a.contact_email        AS email,
      a.contact_phone        AS phone,
      a.city, a.state, a.gstin, a.pan,
      a.onboarding_status,
      sv.created_at AS registered_at,
      EXISTS (SELECT 1 FROM users u WHERE u.vendor_entity_id = sv.entity_id) AS has_login
    FROM scrap_vendors sv
    JOIN accounts a ON a.id = sv.entity_id
    JOIN business_entity_roles ber
      ON ber.entity_id = sv.entity_id
     AND ber.role = 'SCRAP_VENDOR'
     AND ber.status = 'PENDING'
    ORDER BY sv.created_at DESC
  `);

  return (rows as unknown as PendingVendorRow[]).map((r) => ({
    ...r,
    regions: r.regions ?? [],
    has_login: Boolean(r.has_login),
  }));
}

/** One of a vendor's own threads, before serialization. */
export interface VendorOwnThreadRow {
  thread_id: string;
  deal_id: string;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  quotation_no: string | null;
  sent_at: Date | null;
  responded_at: Date | null;
  pickup_city: string | null;
  pickup_state: string | null;
  lines: ThreadLineRow[];
  /** E-196 — has this vendor already raised their PO on this deal? */
  has_vendor_po: boolean;
  /** E-196 — the live proforma iTarang issued against their PO, if any. */
  proforma: { number: string; total: number | string; pdf_s3: string | null } | null;
}

/**
 * The threads routed to ONE vendor — the read behind their dashboard (E-195).
 *
 * Scoped by the vendor's OWN accounts.id, in the WHERE. Same rule as
 * loadOwnRequest: not fetched-then-filtered, so there is no window in which
 * another vendor's thread is in memory relying on us to remember to drop it.
 *
 * NOTE WHAT IS NOT SELECTED. No dealer name, no dealer entity id, no address
 * line, no dealer_price, no margin, no deal status. A vendor who can identify
 * the dealer can go around us, and a vendor who knows what we paid knows our
 * margin — this query is the first of the two places that has to hold that
 * line (toVendorThread is the second, and the contract test asserts on it).
 * The pickup city/state is the same masking pickupLocation() applies for the
 * quotation PDF: enough to price transport, not enough to find the seller.
 */
export async function threadsForVendor(entityId: string): Promise<VendorOwnThreadRow[]> {
  const rows = await db.execute(sql`
    SELECT
      vt.id        AS thread_id,
      vt.deal_id,
      vt.status,
      vt.quotation_no,
      vt.sent_at,
      vt.responded_at,
      COALESCE(pa.city,  da.city)  AS pickup_city,
      COALESCE(pa.state, da.state) AS pickup_state,
      -- E-196: whether this vendor has already raised their PO, and the live
      -- proforma iTarang has issued against it. Scalar subqueries — no GROUP BY
      -- entanglement, and no dealer-side money: a PI carries only the vendor's
      -- own agreed total.
      EXISTS (
        SELECT 1 FROM purchase_orders po
         WHERE po.deal_id = vt.deal_id AND po.leg = 'VENDOR'
      ) AS has_vendor_po,
      (
        SELECT json_build_object('number', pi.number, 'total', pi.total, 'pdf_s3', pi.pdf_s3)
          FROM proforma_invoices pi
         WHERE pi.deal_id = vt.deal_id AND pi.status = 'ISSUED'
         LIMIT 1
      ) AS proforma,
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
            'agreed_price',  vtl.agreed_price,
            -- Battery photo ids for this line (capped). IDs only — the vendor
            -- photo route re-scopes each id to the caller's own thread before it
            -- serves bytes, so an id is safe to hand over; a key never is.
            'photos', COALESCE((
              SELECT json_agg(pj) FROM (
                SELECT json_build_object('id', p.id) AS pj
                FROM buyback_photos p
                WHERE p.line_id = vtl.line_id
                ORDER BY p.created_at
                LIMIT 12
              ) ph
            ), '[]'::json)
          )
          ORDER BY cv.voltage, cv.ah
        ) FILTER (WHERE vtl.id IS NOT NULL),
        '[]'
      ) AS lines
    FROM vendor_threads vt
    JOIN scrap_vendors sv     ON sv.id = vt.vendor_id
    JOIN buyback_deals bd     ON bd.id = vt.deal_id
    JOIN buyback_requests br  ON br.id = bd.request_id
    LEFT JOIN buyback_batches bb        ON bb.request_id = br.id
    LEFT JOIN buyback_pickup_addresses pa ON pa.id = bb.pickup_address_id
    LEFT JOIN accounts da                 ON da.id = br.dealer_entity_id
    LEFT JOIN vendor_thread_lines vtl ON vtl.thread_id = vt.id
    LEFT JOIN buyback_lines bl        ON bl.id = vtl.line_id
    LEFT JOIN catalog_variants cv     ON cv.id = bl.variant_id
    -- The scope. Part of the query, not a check we might forget.
    WHERE sv.entity_id = ${entityId}
    GROUP BY vt.id, pa.city, pa.state, da.city, da.state
    ORDER BY vt.sent_at DESC NULLS LAST, vt.created_at DESC
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    thread_id: String(r.thread_id),
    deal_id: String(r.deal_id),
    status: r.status as VendorOwnThreadRow["status"],
    quotation_no: (r.quotation_no as string) ?? null,
    sent_at: (r.sent_at as Date) ?? null,
    responded_at: (r.responded_at as Date) ?? null,
    pickup_city: (r.pickup_city as string) ?? null,
    pickup_state: (r.pickup_state as string) ?? null,
    lines: (r.lines as ThreadLineRow[]) ?? [],
    has_vendor_po: Boolean(r.has_vendor_po),
    proforma: (r.proforma as VendorOwnThreadRow["proforma"]) ?? null,
  }));
}

/**
 * Load one of a vendor's own threads, or null (E-195).
 *
 * Someone else's thread is indistinguishable from a non-existent one — the same
 * reason loadOwnRequest 404s rather than 403s. A 403 would confirm the thread
 * exists, and a vendor who can enumerate thread ids can map our deal flow.
 */
export async function loadOwnThread(
  entityId: string,
  threadId: string,
): Promise<VendorOwnThreadRow | null> {
  const all = await threadsForVendor(entityId);
  return all.find((t) => t.thread_id === threadId) ?? null;
}

/**
 * The INTERNAL context a thread's write path needs — floor total, request no,
 * vendor name and email.
 *
 * SERVER-SIDE ONLY, and unscoped by design: it is the input to
 * applyVendorResponse, which needs the floor to refuse a below-cost agreement.
 * The caller is responsible for authorisation FIRST — the admin route proves
 * staff, the vendor route proves ownership via loadOwnThread. Nothing in here
 * may be serialized to a vendor: `floorTotal` is dealer_price + margin, which
 * is our whole position.
 *
 * Shared by both write paths so the two cannot disagree about what a thread is.
 */
export async function threadContextFor(threadId: string) {
  const rows = await db.execute(sql`
    SELECT
      vt.id, vt.deal_id, vt.vendor_id, vt.status, vt.quotation_no,
      bd.request_id, bd.floor_total,
      br.request_no,
      a.business_entity_name AS vendor_name,
      a.contact_email        AS vendor_email
    FROM vendor_threads vt
    JOIN buyback_deals bd    ON bd.id = vt.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    JOIN scrap_vendors sv    ON sv.id = vt.vendor_id
    JOIN accounts a          ON a.id = sv.entity_id
    WHERE vt.id = ${threadId}
    LIMIT 1
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) throw new NotFoundError("Vendor thread not found.");

  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    vendorId: String(row.vendor_id),
    status: String(row.status) as "SENT" | "COUNTERED" | "AGREED" | "LOST",
    quotationNo: (row.quotation_no as string) ?? null,
    requestId: String(row.request_id),
    requestNo: String(row.request_no),
    floorTotal: row.floor_total as string | null,
    vendorName: String(row.vendor_name),
    vendorEmail: (row.vendor_email as string) ?? null,
  };
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
