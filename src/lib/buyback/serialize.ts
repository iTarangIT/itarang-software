/**
 * Role-scoped serializers (BRD M08/M23, invariant 4).
 *
 * "API-layer redaction: dealer payloads structurally exclude margin/vendor
 *  fields. AC: keys absent, not nulled."
 *
 * The rule that makes this safe: a dealer payload is BUILT UP from scratch, one
 * named field at a time. It is never an admin object with the secrets deleted,
 * and never `{...deal}` with an omit list — both of those leak the moment
 * somebody adds a column, because the new field rides along by default. Here,
 * a new column is invisible to dealers until a human writes a line to expose it.
 *
 * The contract test in __tests__/serialize.contract.test.ts is release-blocking.
 */

import { formatBatteryLine, lineTotal, type BatteryCondition } from "./format";
import type { DealState } from "./state-machine";

/** The full internal shape, as read from the DB by the admin queries. */
export interface AdminLineView {
  id: string;
  variant_id: string;
  variant_type: string;
  voltage: number | string;
  ah: number | string;
  quantity: number;
  condition: BatteryCondition;
  measured_voltage: number | string | null;
  expected_price_per_unit: number | string | null;
  // --- E-191 dealer-declared spec. The DEALER typed these — not secrets. ----
  brand: string | null;
  chemistry: string | null;
  form_factor: string | null;
  nominal_voltage: number | string | null;
  nominal_ampere: number | string | null;
  unit_weight_kg: number | string | null;
  warranty_cycles: number | null;
  functional_qty: number | null;
  non_functional_qty: number | null;
  iot_battery: boolean | null;
  iot_brand_name: string | null;
  photo_count: number;
  /** The price the dealer accepted (from the ACCEPTED final offer / lock). */
  dealer_price: number | string | null;
  // --- Secrets. A dealer must never see any of these. -----------------------
  margin_value: number | string | null;
  margin_mode: "FLAT" | "PCT" | null;
  vendor_ask: number | string | null;
  vendor_price: number | string | null;
}

export interface AdminDealView {
  request_id: string;
  request_no: string;
  deal_id: string;
  status: DealState;
  offer_version: number;
  source_channel: string;
  created_at: Date | string;
  submitted_at: Date | string | null;
  dealer_entity_id: string;
  dealer_name: string | null;
  dealer_city: string | null;
  lines: AdminLineView[];
  // --- Secrets --------------------------------------------------------------
  floor_total: number | string | null;
}

// ---------------------------------------------------------------------------
// Dealer-facing shapes. Note what is NOT here: no margin_*, no vendor_*, no
// floor_total. These interfaces are the contract — TypeScript will not let a
// secret through, and the contract test proves it at runtime too.
// ---------------------------------------------------------------------------

export interface DealerLineView {
  id: string;
  variant_type: string;
  spec_label: string;
  condition: string;
  condition_key: BatteryCondition;
  // The spec itself is not a secret, and shipping it means the client never has
  // to re-parse "60V 120Ah" back into numbers to re-render a label.
  voltage: number | string;
  ah: number | string;
  quantity: number;
  measured_voltage: number | string | null;
  expected_price_per_unit: number | string | null;
  // E-191 spec — the dealer declared it at intake; it is theirs to see back.
  brand: string | null;
  chemistry: string | null;
  form_factor: string | null;
  nominal_voltage: number | string | null;
  nominal_ampere: number | string | null;
  unit_weight_kg: number | string | null;
  warranty_cycles: number | null;
  functional_qty: number | null;
  non_functional_qty: number | null;
  iot_battery: boolean | null;
  iot_brand_name: string | null;
  photo_count: number;
  /** What iTarang has agreed to pay them. Their own price is not a secret. */
  dealer_price: number | string | null;
  line_total: number | null;
}

export interface DealerDealView {
  request_id: string;
  request_no: string;
  /** The dealer's OWN registered firm name. Not a secret from the dealer. */
  dealer_firm: string | null;
  status: DealState;
  offer_version: number;
  source_channel: string;
  created_at: Date | string;
  submitted_at: Date | string | null;
  lines: DealerLineView[];
  dealer_quote_total: number | null;
}

/** Fields a dealer payload must never contain. Exported so the test can assert on them. */
export const DEALER_FORBIDDEN_KEYS = [
  "margin_value",
  "margin_mode",
  "vendor_ask",
  "vendor_price",
  "floor_total",
  "vendor_threads",
  "dealer_entity_id",
  // Ext-1/Ext-2 additions. Internal ids and S3 capabilities that must never ride
  // along on the dealer-leg negotiation rounds or the dealer PO summary:
  //   · counterparty_id       — the vendor-leg counterparty on a round row
  //   · counterparty_entity_id — the PO's counterparty account id
  //   · pdf_s3                 — an S3 key is a capability, never handed to a client
  "counterparty_id",
  "counterparty_entity_id",
  "pdf_s3",
  // Ext-8/Ext-9 additions. The pickup row and the settlement row both carry
  // things that are not the dealer's to see:
  //   · eway_bill_s3 / weighbridge_slip_s3 — BWM compliance documents, S3
  //     capabilities like pdf_s3 above
  //   · proof_s3               — the payment proof, another S3 capability
  //   · created_by/recorded_by — internal user ids (who scheduled, who paid)
  "eway_bill_s3",
  "weighbridge_slip_s3",
  "proof_s3",
  "created_by",
  "recorded_by",
] as const;

export function toDealerLine(line: AdminLineView): DealerLineView {
  const f = formatBatteryLine({
    id: line.id,
    quantity: line.quantity,
    condition: line.condition,
    voltage: line.voltage,
    ah: line.ah,
  });

  // Built field-by-field. A new column on AdminLineView does NOT appear here.
  return {
    id: line.id,
    variant_type: line.variant_type,
    spec_label: f.specLabel,
    condition: f.condition,
    condition_key: f.conditionKey,
    voltage: line.voltage,
    ah: line.ah,
    quantity: line.quantity,
    measured_voltage: line.measured_voltage,
    expected_price_per_unit: line.expected_price_per_unit,
    brand: line.brand ?? null,
    chemistry: line.chemistry ?? null,
    form_factor: line.form_factor ?? null,
    nominal_voltage: line.nominal_voltage ?? null,
    nominal_ampere: line.nominal_ampere ?? null,
    unit_weight_kg: line.unit_weight_kg ?? null,
    warranty_cycles: line.warranty_cycles ?? null,
    functional_qty: line.functional_qty ?? null,
    non_functional_qty: line.non_functional_qty ?? null,
    iot_battery: line.iot_battery ?? null,
    iot_brand_name: line.iot_brand_name ?? null,
    photo_count: line.photo_count,
    dealer_price: line.dealer_price,
    line_total: lineTotal(line.quantity, line.dealer_price ?? line.expected_price_per_unit),
  };
}

export function toDealerDeal(deal: AdminDealView): DealerDealView {
  const lines = deal.lines.map(toDealerLine);

  const total = lines.reduce<number | null>((sum, l) => {
    if (l.line_total === null) return sum;
    return (sum ?? 0) + l.line_total;
  }, null);

  return {
    request_id: deal.request_id,
    request_no: deal.request_no,
    // The dealer's own firm — shown as the addressee on the PO iTarang issues to
    // them. dealer_entity_id (the internal account id) stays structurally absent.
    dealer_firm: deal.dealer_name ?? null,
    status: deal.status,
    offer_version: deal.offer_version,
    source_channel: deal.source_channel,
    created_at: deal.created_at,
    submitted_at: deal.submitted_at,
    lines,
    dealer_quote_total: total,
  };
}

/** The admin sees everything. Identity, but named so call sites read symmetrically. */
export function toAdminDeal(deal: AdminDealView): AdminDealView {
  return deal;
}

// ---------------------------------------------------------------------------
// DEALER-LEG NEGOTIATION (Ext-1).
//
// The dealer sees THEIR OWN negotiation: the back-and-forth of the prices they
// offered and the prices iTarang countered/finalised. That data is theirs to
// see. What must NOT ride along is the internal identity behind an offer — the
// `offered_by` user uuid and the vendor-leg `counterparty_id` — and, as ever,
// any margin/vendor column a careless join might hang on a line row. So a round
// is rebuilt field-by-field: only the ROLE ("dealer"|"admin"), a friendly actor
// label, the note, the timestamp and the per-SKU prices survive.
// ---------------------------------------------------------------------------

export interface DealerNegLineView {
  line_id: string;
  label: string;
  price_per_unit: number;
}

export interface DealerNegRoundView {
  round_no: number;
  /** ROLE only — never the internal user id that authored the round. */
  offered_by: "dealer" | "admin";
  /** "You" for the dealer's own rounds, "iTarang" for admin/final offers. */
  actor_label: string;
  note: string | null;
  created_at: Date | string;
  lines: DealerNegLineView[];
  is_final: boolean;
  is_accept: boolean;
}

/**
 * The source row as read from negotiation_rounds / final_offers. It MAY carry
 * internal ids (offered_by, counterparty_id) and — if a caller joins carelessly
 * — margin/vendor columns on a line. None of them survive toDealerNegRound.
 */
export interface DealerNegRoundSource {
  round_no: number;
  offered_by_role: string; // 'dealer' | 'admin'
  offered_by?: string | null;
  counterparty_id?: string | null;
  note?: string | null;
  created_at: Date | string;
  lines: Array<{ line_id: string; label: string; price_per_unit: number | string }>;
  is_final?: boolean;
  is_accept?: boolean;
}

export function toDealerNegRound(round: DealerNegRoundSource): DealerNegRoundView {
  const role: "dealer" | "admin" = round.offered_by_role === "admin" ? "admin" : "dealer";

  // Built field-by-field. `offered_by` (the uuid) and `counterparty_id` are
  // never read into the output; the only `offered_by` the dealer gets is a role.
  return {
    round_no: round.round_no,
    offered_by: role,
    actor_label: role === "dealer" ? "You" : "iTarang",
    note: round.note ?? null,
    created_at: round.created_at,
    lines: round.lines.map((l) => ({
      line_id: l.line_id,
      label: l.label,
      price_per_unit: Number(l.price_per_unit),
    })),
    is_final: round.is_final ?? false,
    is_accept: round.is_accept ?? false,
  };
}

export function toDealerNegotiation(rounds: DealerNegRoundSource[]): DealerNegRoundView[] {
  return rounds.map(toDealerNegRound);
}

// ---------------------------------------------------------------------------
// DEALER PO SUMMARY (Ext-2).
//
// The PO iTarang issues to the dealer (leg=DEALER, direction=ISSUED). Its number,
// status and issue date are the dealer's to see. Its `pdf_s3` key is a capability
// we never emit, and `counterparty_entity_id` is an internal account id — both
// stay structurally absent. There is no dealer-facing route that serves a PO PDF
// (the media route serves only photos/provenance), so `pdf_available` is false
// and the Documents card is rendered from the deal's own locked-price lines.
// ---------------------------------------------------------------------------

export interface DealerPoSource {
  number: string;
  status: string;
  issued_at: Date | string | null;
  pdf_s3?: string | null;
  counterparty_entity_id?: string | null;
}

export interface DealerPoView {
  number: string;
  status: string;
  issued_at: Date | string | null;
  pdf_available: boolean;
}

export function toDealerPo(po: DealerPoSource | null): DealerPoView | null {
  if (!po) return null;

  // Built field-by-field: pdf_s3 and counterparty_entity_id are structurally
  // absent. No dealer-facing PO PDF route exists, so pdf_available is false.
  return {
    number: po.number,
    status: po.status,
    issued_at: po.issued_at ?? null,
    pdf_available: false,
  };
}

// ---------------------------------------------------------------------------
// DEALER PICKUP SUMMARY (Ext-8).
//
// The dealer is a PARTY to the pickup — they have to be standing next to the
// batteries when the truck arrives — so the schedule, the address, the contact
// and the counts are theirs to see. What is NOT theirs: the BWM 2022 compliance
// documents (eway_bill_s3, weighbridge_slip_s3 — S3 keys are capabilities,
// same rule as pdf_s3 on the PO) and the internal id of the admin who scheduled
// it. Built field-by-field, so none of them can ride along.
// ---------------------------------------------------------------------------

/**
 * The pickup row as read from `pickups`. It MAY carry the compliance S3 keys
 * and the scheduler's user id — none of them survive toDealerPickup.
 */
export interface DealerPickupSource {
  scheduled_at: Date | string | null;
  completed_at: Date | string | null;
  address: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  /** Σ expected_counts quantities — what the dealer declared. Null until completion. */
  submitted_units?: number | string | null;
  /** Σ actual_counts quantities — what the collector counted. Null until completion. */
  actual_units?: number | string | null;
  // --- Never emitted -------------------------------------------------------
  eway_bill_s3?: string | null;
  weighbridge_slip_s3?: string | null;
  created_by?: string | null;
}

export interface DealerPickupView {
  scheduled_at: Date | string | null;
  completed_at: Date | string | null;
  address: string | null;
  /** "Ramesh Kumar · 9820011111" — one display label, built here so screens don't. */
  contact: string | null;
  submitted_units: number | null;
  actual_units: number | null;
}

function toCount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toDealerPickup(pickup: DealerPickupSource | null): DealerPickupView | null {
  if (!pickup) return null;

  // Built field-by-field: the S3 keys and created_by are never read into the
  // output. Counts pass through as numbers or null — a scheduled-but-not-yet-
  // collected pickup has no counts, and the UI must be able to tell.
  return {
    scheduled_at: pickup.scheduled_at ?? null,
    completed_at: pickup.completed_at ?? null,
    address: pickup.address ?? null,
    contact:
      [pickup.contact_name, pickup.contact_phone].filter(Boolean).join(" · ") || null,
    submitted_units: toCount(pickup.submitted_units),
    actual_units: toCount(pickup.actual_units),
  };
}

// ---------------------------------------------------------------------------
// DEALER PAYOUT SUMMARY (Ext-9).
//
// The dealer's own money: the locked dealer total (Σ qty × dealer_price from
// the current lock generation — computed in lib, the same source the invoice
// GET bills from) and whether their -D settlement leg has been recorded. The
// VENDOR leg is excluded with exactly the rule visibleActivityForDealer uses:
// a second money leg existing at all is half the margin, so a VENDOR-leg row
// contributes nothing here — not its txn_ref, not its amount, not `paid`.
// ---------------------------------------------------------------------------

/** A settlement row as read from settlement_transactions. May be either leg. */
export interface DealerPayoutSettlementSource {
  leg: string; // 'DEALER' | 'VENDOR'
  txn_ref?: string | null;
  // --- Never emitted -------------------------------------------------------
  amount?: number | string | null;
  proof_s3?: string | null;
  recorded_by?: string | null;
}

export interface DealerPayoutSource {
  /** Σ qty × dealer_price over the current lock generation. Null = no locks yet. */
  locked_dealer_total: number | string | null;
  /** The deal's settlement rows. A VENDOR-leg row never survives. */
  settlements: DealerPayoutSettlementSource[];
}

export interface DealerPayoutView {
  /** What iTarang owes (or paid) them — their own number, never the vendor's. */
  amount: number;
  paid: boolean;
  txn_ref: string | null;
}

export function toDealerPayout(source: DealerPayoutSource): DealerPayoutView | null {
  // No locked prices yet = the deal has not reached the money stage. NULL, not
  // a zero — a ₹0 payout and "no payout yet" are different statements.
  const total =
    source.locked_dealer_total === null || source.locked_dealer_total === undefined
      ? null
      : Number(source.locked_dealer_total);
  if (total === null || !Number.isFinite(total)) return null;

  // The same leg filter as visibleActivityForDealer's record_settlement rule:
  // only the DEALER leg exists as far as this payload is concerned.
  const mine = source.settlements.find((s) => s.leg === "DEALER") ?? null;

  // Built field-by-field. The vendor row's txn_ref/amount — and even the
  // dealer row's amount (the payout is the LOCKED total, not a restatement of
  // whatever was typed into the settlement form) — are never read into this.
  return {
    amount: total,
    paid: mine !== null,
    txn_ref: mine?.txn_ref ?? null,
  };
}

/**
 * Activity-log redaction for the dealer's audit tab (M21/M08).
 *
 * The prototype filtered these client-side, which means the rows were still on
 * the wire. This runs server-side, before serialization.
 */
const DEALER_HIDDEN_ACTIONS = new Set([
  "set_margin",
  "start_review",
  // The whole vendor leg (Sprint 2A). A dealer learning that we routed their
  // batteries to three scrap vendors — and what those vendors offered — hands
  // them both our margin and our buyer list. `exchange_pos`, `schedule_pickup`
  // and `complete_pickup` are deliberately NOT hidden: those are events the
  // dealer is a party to and must see.
  "route_to_vendors",
  "record_vendor_counter",
  "record_vendor_agreement",
  // The vendor's PO arriving is a vendor-leg event; only the completed
  // exchange (which the dealer is party to) is theirs to see.
  "record_vendor_po",
]);

export function visibleActivityForDealer<
  T extends { action: string; role: string; after?: unknown },
>(entries: T[]): T[] {
  return entries.filter((e) => {
    if (e.role === "vendor" || DEALER_HIDDEN_ACTIONS.has(e.action)) return false;

    // Settlements are per-leg under one action name. The dealer's own payout
    // is theirs to see; the VENDOR receipt is the other half of the margin —
    // two "payment recorded" rows tell a dealer a second money leg exists.
    if (e.action === "record_settlement") {
      const leg = (e.after as { leg?: string } | null | undefined)?.leg;
      return leg !== "VENDOR";
    }

    return true;
  });
}

// ===========================================================================
// VENDOR-FACING SHAPES (Sprint 2A, M09).
//
// Invariant 4 has a mirror image on this side. Dealer payloads must not carry
// margin; VENDOR payloads must not carry DEALER IDENTITY.
//
//   M09 AC: "PDF contains no dealer name/phone/GST."
//
// The same discipline applies, for the same reason: the quotation is built
// field-by-field from scratch, so the PDF template physically cannot render a
// dealer's name — it is never handed one. Enforcing this in the template (by
// "just not writing {{dealerName}}") would be a convention; enforcing it in the
// type is a guarantee.
//
// This is the non-circumvention clause in code: iTarang is a back-to-back
// principal. If a vendor can identify the dealer, the vendor can go around us.
// ===========================================================================

/** One SKU on a vendor's quotation / thread. Prices here are VENDOR-side only. */
export interface VendorLineView {
  line_id: string;
  spec_label: string;
  condition: string;
  condition_key: BatteryCondition;
  voltage: number | string;
  ah: number | string;
  quantity: number;
  /** ₹/unit we asked this vendor for. */
  ask_price: number | string | null;
  /** ₹/unit they countered with, if they have. */
  counter_price: number | string | null;
  /** ₹/unit finally struck. */
  agreed_price: number | string | null;
  // NOTE what is absent: dealer_price and margin_value. A vendor who knows both
  // our ask and what we paid the dealer knows our margin exactly.
}

/** The masked quotation. This — and only this — is what the PDF template sees. */
export interface VendorQuotationView {
  quotation_no: string;
  /** City + state only. Enough to price transport; not enough to find the dealer. */
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLineView[];
  total_units: number;
  /** Σ qty × ask. The vendor is being asked for a number, so they get one. */
  ask_total: number | null;
  issued_on: Date | string;
}

/**
 * Everything a vendor payload must never contain. Exported so the contract test
 * can assert on it — and so the list is one place, not scattered through
 * templates.
 */
export const VENDOR_FORBIDDEN_KEYS = [
  // Dealer identity (M09 AC).
  "dealer_name",
  "dealer_entity_id",
  "dealer_phone",
  "dealer_email",
  "dealer_gstin",
  "dealer_code",
  "business_entity_name",
  "contact_name",
  "contact_phone",
  "contact_email",
  "gstin",
  "pan",
  "address_line1",
  "address_line2",
  "pincode",
  // Our economics.
  "dealer_price",
  "margin_value",
  "margin_mode",
  "floor_total",
] as const;

export interface VendorLineSource {
  line_id: string;
  quantity: number;
  condition: BatteryCondition;
  voltage: number | string;
  ah: number | string;
  ask_price: number | string | null;
  counter_price?: number | string | null;
  agreed_price?: number | string | null;
}

export function toVendorLine(line: VendorLineSource): VendorLineView {
  const f = formatBatteryLine({
    id: line.line_id,
    quantity: line.quantity,
    condition: line.condition,
    voltage: line.voltage,
    ah: line.ah,
  });

  // Built field-by-field, from a source type that has no dealer fields on it to
  // begin with. Two independent barriers, on purpose.
  return {
    line_id: line.line_id,
    spec_label: f.specLabel,
    condition: f.condition,
    condition_key: f.conditionKey,
    voltage: line.voltage,
    ah: line.ah,
    quantity: line.quantity,
    ask_price: line.ask_price,
    counter_price: line.counter_price ?? null,
    agreed_price: line.agreed_price ?? null,
  };
}

export function toVendorQuotation(input: {
  quotation_no: string;
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLineSource[];
  issued_on?: Date | string;
}): VendorQuotationView {
  const lines = input.lines.map(toVendorLine);

  const askTotal = lines.reduce<number | null>((sum, l) => {
    const t = lineTotal(l.quantity, l.ask_price);
    return t === null ? sum : (sum ?? 0) + t;
  }, null);

  return {
    quotation_no: input.quotation_no,
    pickup_city: input.pickup_city,
    pickup_state: input.pickup_state,
    lines,
    total_units: lines.reduce((n, l) => n + l.quantity, 0),
    ask_total: askTotal,
    issued_on: input.issued_on ?? new Date(),
  };
}
