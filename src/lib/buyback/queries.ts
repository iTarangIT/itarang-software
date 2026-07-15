/**
 * Shared read queries for the buyback module.
 *
 * Kept in one place because the same "lines with their photo counts, provenance
 * state and current locked price" shape is needed by the submit gate, the dealer
 * detail page, the admin review screen, the negotiation modals and the margin
 * pane. Five near-identical hand-rolled joins would drift.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { formatBatteryLine } from "./format";
import type { AdminLineView } from "./serialize";
import type { GateLine } from "./submit-gate";
import type { DealState } from "./state-machine";
import type { BuybackTx } from "./tx";

export interface DealHeader {
  request_id: string;
  request_no: string;
  deal_id: string;
  status: DealState;
  offer_version: number;
  source_channel: string;
  created_at: Date;
  submitted_at: Date | null;
  dealer_entity_id: string;
  dealer_name: string | null;
  dealer_city: string | null;
  floor_total: string | null;
}

/**
 * Lines for a request, with everything the screens need hung off them.
 *
 * The price columns come from the CURRENT lock generation only — i.e. the one
 * stamped with the deal's current offer_version. That is what makes a reopen
 * safe: v1's locks stay on disk for the audit trail but stop being read the
 * moment the deal moves to v2 (BRD M08/M22 — "margin from locked values only").
 */
export async function linesForRequest(
  requestId: string,
  runner: BuybackTx | typeof db = db,
): Promise<AdminLineView[]> {
  const rows = await runner.execute(sql`
    SELECT
      bl.id,
      bl.variant_id,
      cv.type                        AS variant_type,
      cv.voltage,
      cv.ah,
      bl.quantity,
      bl.condition,
      bl.measured_voltage,
      bl.expected_price_per_unit,
      -- E-191 dealer-declared spec (all nullable; required subset gated at submit).
      bl.brand,
      bl.chemistry,
      bl.form_factor,
      bl.nominal_voltage,
      bl.nominal_ampere,
      bl.unit_weight_kg,
      bl.warranty_cycles,
      bl.functional_qty,
      bl.non_functional_qty,
      bl.iot_battery,
      bl.iot_brand_name,
      (SELECT count(*)::int FROM buyback_photos p WHERE p.line_id = bl.id) AS photo_count,
      -- Provenance is satisfied by a LINE record, or by a UNIT record on every
      -- unit of the line. Anything less is a gap the submit gate must catch.
      (
        EXISTS (SELECT 1 FROM provenance_records pr
                WHERE pr.line_id = bl.id AND pr.scope = 'LINE')
        OR (
          (SELECT count(*) FROM buyback_units u WHERE u.line_id = bl.id) > 0
          AND NOT EXISTS (
            SELECT 1 FROM buyback_units u
            WHERE u.line_id = bl.id
              AND NOT EXISTS (SELECT 1 FROM provenance_records pr
                              WHERE pr.unit_id = u.id AND pr.scope = 'UNIT')
          )
        )
      ) AS has_provenance,
      -- The dealer's accepted price: the lock if margin is set, else the price on
      -- the ACCEPTED final offer at the current version.
      COALESCE(
        (SELECT dll.dealer_price FROM deal_line_locks dll
          WHERE dll.deal_id = bd.id AND dll.line_id = bl.id
            AND dll.offer_version = bd.offer_version),
        (SELECT fol.price_per_unit FROM final_offer_lines fol
           JOIN final_offers fo ON fo.id = fol.final_offer_id
          WHERE fo.deal_id = bd.id AND fol.line_id = bl.id
            AND fo.status = 'ACCEPTED' AND fo.version_no = bd.offer_version)
      ) AS dealer_price,
      (SELECT dll.margin_value FROM deal_line_locks dll
        WHERE dll.deal_id = bd.id AND dll.line_id = bl.id
          AND dll.offer_version = bd.offer_version) AS margin_value,
      (SELECT dll.margin_mode FROM deal_line_locks dll
        WHERE dll.deal_id = bd.id AND dll.line_id = bl.id
          AND dll.offer_version = bd.offer_version) AS margin_mode,
      (SELECT dll.vendor_ask FROM deal_line_locks dll
        WHERE dll.deal_id = bd.id AND dll.line_id = bl.id
          AND dll.offer_version = bd.offer_version) AS vendor_ask,
      (SELECT dll.vendor_price FROM deal_line_locks dll
        WHERE dll.deal_id = bd.id AND dll.line_id = bl.id
          AND dll.offer_version = bd.offer_version) AS vendor_price
    FROM buyback_lines bl
    JOIN buyback_batches bb ON bb.id = bl.batch_id
    JOIN buyback_deals   bd ON bd.request_id = bb.request_id
    JOIN catalog_variants cv ON cv.id = bl.variant_id
    WHERE bb.request_id = ${requestId}
    ORDER BY bl.created_at
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    variant_id: String(r.variant_id),
    variant_type: String(r.variant_type),
    voltage: r.voltage as string,
    ah: r.ah as string,
    quantity: Number(r.quantity),
    condition: r.condition as "WORKING" | "DEAD",
    measured_voltage: (r.measured_voltage as string) ?? null,
    expected_price_per_unit: (r.expected_price_per_unit as string) ?? null,
    brand: (r.brand as string) ?? null,
    chemistry: (r.chemistry as string) ?? null,
    form_factor: (r.form_factor as string) ?? null,
    nominal_voltage: (r.nominal_voltage as string) ?? null,
    nominal_ampere: (r.nominal_ampere as string) ?? null,
    unit_weight_kg: (r.unit_weight_kg as string) ?? null,
    warranty_cycles: r.warranty_cycles == null ? null : Number(r.warranty_cycles),
    functional_qty: r.functional_qty == null ? null : Number(r.functional_qty),
    non_functional_qty: r.non_functional_qty == null ? null : Number(r.non_functional_qty),
    iot_battery: r.iot_battery == null ? null : Boolean(r.iot_battery),
    iot_brand_name: (r.iot_brand_name as string) ?? null,
    photo_count: Number(r.photo_count),
    dealer_price: (r.dealer_price as string) ?? null,
    margin_value: (r.margin_value as string) ?? null,
    margin_mode: (r.margin_mode as "FLAT" | "PCT") ?? null,
    vendor_ask: (r.vendor_ask as string) ?? null,
    vendor_price: (r.vendor_price as string) ?? null,
    // Not part of AdminLineView, but the gate needs it. Carried as a extra prop.
    has_provenance: Boolean(r.has_provenance),
  })) as Array<AdminLineView & { has_provenance: boolean }>;
}

/** Adapt the line rows into what the submit gate wants, using the shared formatter. */
export function toGateLines(
  lines: Array<AdminLineView & { has_provenance: boolean }>,
): GateLine[] {
  return lines.map((l) => ({
    id: l.id,
    label: formatBatteryLine({
      id: l.id,
      quantity: l.quantity,
      condition: l.condition,
      voltage: l.voltage,
      ah: l.ah,
    }).full,
    quantity: l.quantity,
    photo_count: l.photo_count,
    has_provenance: l.has_provenance,
    // E-191 spec — the gate enforces the required subset at submit time.
    brand: l.brand,
    chemistry: l.chemistry,
    nominal_voltage: l.nominal_voltage,
    nominal_ampere: l.nominal_ampere,
    unit_weight_kg: l.unit_weight_kg,
    iot_battery: l.iot_battery,
    iot_brand_name: l.iot_brand_name,
    functional_qty: l.functional_qty,
    non_functional_qty: l.non_functional_qty,
  }));
}

/** Header for a request, with the dealer's firm details for the admin queue. */
export async function dealHeader(requestId: string): Promise<DealHeader | null> {
  const rows = await db.execute(sql`
    SELECT
      br.id            AS request_id,
      br.request_no,
      bd.id            AS deal_id,
      bd.status,
      bd.offer_version,
      br.source_channel,
      br.created_at,
      br.submitted_at,
      br.dealer_entity_id,
      a.business_entity_name AS dealer_name,
      a.city                 AS dealer_city,
      bd.floor_total
    FROM buyback_requests br
    JOIN buyback_deals bd ON bd.request_id = br.id
    LEFT JOIN accounts a  ON a.id = br.dealer_entity_id
    WHERE br.id = ${requestId}
  `);

  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!r) return null;

  return {
    request_id: String(r.request_id),
    request_no: String(r.request_no),
    deal_id: String(r.deal_id),
    status: r.status as DealState,
    offer_version: Number(r.offer_version),
    source_channel: String(r.source_channel),
    created_at: r.created_at as Date,
    submitted_at: (r.submitted_at as Date) ?? null,
    dealer_entity_id: String(r.dealer_entity_id),
    dealer_name: (r.dealer_name as string) ?? null,
    dealer_city: (r.dealer_city as string) ?? null,
    floor_total: (r.floor_total as string) ?? null,
  };
}

/** The next round number on a leg — negotiation_rounds is UNIQUE on (deal, leg, round_no). */
export async function nextRoundNo(
  tx: BuybackTx,
  dealId: string,
  leg: "DEALER" | "VENDOR" = "DEALER",
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT coalesce(max(round_no), 0) + 1 AS n
    FROM negotiation_rounds
    WHERE deal_id = ${dealId} AND leg = ${leg}
  `);
  return Number((rows as unknown as Array<{ n: string | number }>)[0].n);
}
