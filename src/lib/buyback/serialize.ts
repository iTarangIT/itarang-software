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
// No cycle: line-spec imports only zod.
import { resolveIotBrand } from "./line-spec";
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

/**
 * A line of the dealer's OWN DRAFT, shaped for the intake editor to reload.
 *
 * Why this exists rather than reusing DealerLineView: the editor needs
 * `variant_id` to re-select the SKU in the picker, and DealerLineView has no
 * such field — it carries `spec_label` for display. Adding an id to the
 * read-only view to serve the editor would widen a redaction boundary for a
 * reason unrelated to it.
 *
 * Why not just hand back the AdminLineView the query already produced: because
 * it carries dealer_price, margin_value, vendor_ask and vendor_price. On a
 * DRAFT every one of those is null — there are no locks and no offers yet — so
 * shipping the raw row would "work". It would also mean the only thing between
 * a dealer and our margin is that the deal happens to be young. Built
 * field-by-field like every other serializer here, so it stays impossible
 * rather than merely currently-empty.
 */
export interface DraftLineView {
  line_id: string;
  variant_id: string;
  quantity: number;
  condition: BatteryCondition;
  /** The dealer's OWN asking price. Not dealer_price — that is what we settled on. */
  expected_price_per_unit: number | string | null;
  measured_voltage: number | string | null;
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
}

export function toDraftLine(line: AdminLineView): DraftLineView {
  return {
    line_id: line.id,
    variant_id: line.variant_id,
    quantity: line.quantity,
    condition: line.condition,
    expected_price_per_unit: line.expected_price_per_unit,
    measured_voltage: line.measured_voltage,
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
    // Null stays null: the Intellicar assumption is a read-time display concern
    // (resolveIotBrand), and the editor must show the dealer what they actually
    // typed — pre-filling the box with a guess would turn it into their answer
    // the moment they saved.
    iot_brand_name: line.iot_brand_name ?? null,
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
  /**
   * U5 — the offer_version this specific final offer belongs to. Only ever
   * set on is_final rounds (a final offer's own version_no); absent on plain
   * negotiation rounds. Additive: without it, a UI falls back to the deal's
   * CURRENT offer_version, which is what every caller did before this field
   * existed — but that mislabels an OLDER final offer still visible after a
   * reopen, since the deal has since moved on to a later version.
   */
  version?: number;
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
  /** U5 — this round's own offer_version, when the producer has one (a final
   * offer's version_no). See DealerNegRoundView.version. */
  version?: number;
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
    // Additive — only present when the producer set it (final-offer rounds).
    ...(round.version !== undefined ? { version: round.version } : {}),
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
// stay structurally absent. `pdf_available` tells the dealer detail page WHETHER
// a PDF exists, without ever handing back the key that would let it be fetched
// directly — the actual bytes come from GET /api/buyback/requests/:id/po (U1),
// which re-derives the key server-side, scoped to the caller's own request.
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
  // absent. pdf_available is a boolean derived FROM pdf_s3, never the key
  // itself — the source's Boolean-ness rides along, the string does not.
  return {
    number: po.number,
    status: po.status,
    issued_at: po.issued_at ?? null,
    pdf_available: Boolean(po.pdf_s3),
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

  // --- E-191 dealer-declared spec. Properties of the BATTERY, so a vendor may
  //     see all of it: none of it identifies who is selling.
  variant_type: string | null;
  brand: string | null;
  chemistry: string | null;
  form_factor: string | null;
  nominal_voltage: number | string | null;
  nominal_ampere: number | string | null;
  /** Per unit, as declared. */
  unit_weight_kg: number | string | null;
  /** qty × unit_weight_kg — the number a scrap buyer actually prices against. */
  line_weight_kg: number | null;
  /** RATED life, not consumed life. The template must label it as rated. */
  warranty_cycles: number | null;
  iot_battery: boolean | null;
  /**
   * The IOT brand WITH its provenance baked in — "Intellicar (assumed)" when the
   * dealer left it blank. One string, so a template cannot render the brand and
   * drop the caveat.
   */
  iot_brand_label: string | null;
  /** "6 working · 3 non-working · 1 untested", zero-parts omitted. */
  condition_split_label: string | null;
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
  /**
   * Σ line_weight_kg over the lines that DECLARED a weight — the single most
   * valuable number to a scrap buyer, who prices by the kilogram.
   *
   * Null when no line declares one. Never treats an undeclared weight as zero:
   * that would understate the lot, and understating the thing the vendor prices
   * on is how you get a quote you cannot honour.
   */
  total_weight_kg: number | null;
  /**
   * Says so when the total covers only some of the lot — "4 of 6 SKUs declared".
   *
   * Null when every line declared a weight. A partial total presented as a whole
   * one is the exact failure this module keeps making: a number that is true
   * about a subset, rendered as though it were true about everything.
   */
  weight_caveat: string | null;
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
  // --- E-191 dealer-declared spec. All optional: a caller that has not fetched
  //     it passes nothing and the view simply omits it. Every one of these is a
  //     property of the BATTERY, never of the dealer.
  variant_type?: string | null;
  brand?: string | null;
  chemistry?: string | null;
  form_factor?: string | null;
  nominal_voltage?: number | string | null;
  nominal_ampere?: number | string | null;
  unit_weight_kg?: number | string | null;
  warranty_cycles?: number | null;
  functional_qty?: number | null;
  non_functional_qty?: number | null;
  iot_battery?: boolean | null;
  iot_brand_name?: string | null;
}

/** Σ of a line's declared unit weight, or null when the dealer didn't declare one. */
function lineWeightKg(line: VendorLineSource): number | null {
  if (line.unit_weight_kg === null || line.unit_weight_kg === undefined) return null;
  const per = Number(line.unit_weight_kg);
  if (!Number.isFinite(per) || per <= 0) return null;
  return Math.round(per * line.quantity * 1000) / 1000;
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
    // E-191 spec — what a scrap buyer actually prices against. The quotation
    // said "60V 120Ah · Working ×3" and nothing else, while every one of these
    // sat unread on buyback_lines. A recycler prices by CHEMISTRY and by
    // KILOGRAMS, and we told them neither.
    variant_type: line.variant_type ?? null,
    brand: line.brand ?? null,
    chemistry: line.chemistry ?? null,
    form_factor: line.form_factor ?? null,
    nominal_voltage: line.nominal_voltage ?? null,
    nominal_ampere: line.nominal_ampere ?? null,
    unit_weight_kg: line.unit_weight_kg ?? null,
    line_weight_kg: lineWeightKg(line),
    warranty_cycles: line.warranty_cycles ?? null,
    iot_battery: line.iot_battery ?? null,
    // ONE string, not a brand plus a flag the template could render without.
    // resolveIotBrand's assumption has to be unstrippable: a vendor pricing an
    // "Intellicar" pack is entitled to know we guessed that, and a caller who
    // could render the brand and drop the caveat would eventually do exactly
    // that. Same reason condition_split_label below is a string, not three ints.
    iot_brand_label: iotBrandLabel(line),
    condition_split_label: conditionSplitLabel(line),
  };
}

/** "Intellicar (assumed)" vs the dealer's own answer — or null for a non-IOT pack. */
function iotBrandLabel(line: VendorLineSource): string | null {
  const resolved = resolveIotBrand(line.iot_battery, line.iot_brand_name);
  if (!resolved) return null;
  return resolved.assumed ? `${resolved.brand} (assumed)` : resolved.brand;
}

/**
 * "6 working · 3 non-working · 1 untested", omitting the zero parts.
 *
 * A string rather than three numbers because the UNTESTED remainder is the part
 * a template would forget: the submit gate treats the split as a ceiling, not an
 * equality (5 + 3 of 10 is a truthful partial declaration), so a vendor shown
 * only "5 working, 3 non-working" of a lot of 10 would silently misread two
 * batteries as one or the other.
 */
function conditionSplitLabel(line: VendorLineSource): string | null {
  const f = line.functional_qty;
  const nf = line.non_functional_qty;
  if ((f === null || f === undefined) && (nf === null || nf === undefined)) return null;

  const working = f ?? 0;
  const dead = nf ?? 0;
  const untested = Math.max(0, line.quantity - working - dead);

  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (dead > 0) parts.push(`${dead} non-working`);
  if (untested > 0) parts.push(`${untested} untested`);
  return parts.length > 0 ? parts.join(" · ") : null;
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

  // Weigh only what was declared, and say so when that is not everything.
  const declared = lines.filter((l) => l.line_weight_kg !== null);
  const totalWeight =
    declared.length === 0
      ? null
      : Math.round(declared.reduce((sum, l) => sum + (l.line_weight_kg ?? 0), 0) * 1000) / 1000;

  return {
    quotation_no: input.quotation_no,
    pickup_city: input.pickup_city,
    pickup_state: input.pickup_state,
    lines,
    total_units: lines.reduce((n, l) => n + l.quantity, 0),
    ask_total: askTotal,
    total_weight_kg: totalWeight,
    weight_caveat:
      declared.length > 0 && declared.length < lines.length
        ? `${declared.length} of ${lines.length} SKUs declared a weight`
        : null,
    issued_on: input.issued_on ?? new Date(),
  };
}

/**
 * The vendor's own status on their own thread (E-195 — the vendor dashboard).
 *
 * DELIBERATELY NOT the deal status. `buyback_deals.status` is a 21-state
 * narrative of the DEALER leg — DEALER_ACCEPTED, MARGIN_SET, INVOICE_APPROVED —
 * and handing it to a vendor would tell them we had already bought the lot and
 * roughly when, which is a negotiating position. The vendor's thread status is
 * the whole truth a vendor is entitled to about where they stand.
 */
export type VendorThreadStatus = "SENT" | "COUNTERED" | "AGREED" | "LOST";

/**
 * One routed quotation as the vendor themselves sees it, on their dashboard.
 *
 * A superset of VendorQuotationView by intent — same masking, plus where the
 * haggle has got to. Everything a vendor needs to answer "what is this lot,
 * where is it, what did they ask, what did I say, and did I win?" and nothing
 * that answers "who is the seller?" or "what did iTarang pay for it?".
 *
 * Built field-by-field from a source type that has no dealer identity on it, so
 * this is the same structural promise toVendorQuotation makes rather than a
 * discipline someone has to remember.
 */
export interface VendorThreadView {
  thread_id: string;
  quotation_no: string;
  status: VendorThreadStatus;
  /** City + state only. Enough to price transport; not enough to find the dealer. */
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLineView[];
  total_units: number;
  /** Σ qty × ask — what we are asking this vendor for. */
  ask_total: number | null;
  /** Σ qty × counter — what they have offered, once they have. */
  counter_total: number | null;
  /** Σ qty × agreed — the struck price, once struck. */
  agreed_total: number | null;
  sent_at: Date | string | null;
  responded_at: Date | string | null;
  /**
   * Whether this vendor may still act. Derived, so the dashboard does not
   * re-implement the state machine — and so a LOST vendor's buttons are gone
   * rather than merely ghosted.
   */
  can_respond: boolean;
}

export interface VendorThreadSource {
  thread_id: string;
  quotation_no: string;
  status: VendorThreadStatus;
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLineSource[];
  sent_at: Date | string | null;
  responded_at: Date | string | null;
}

function sumBy(
  lines: VendorLineView[],
  pick: (l: VendorLineView) => number | string | null,
): number | null {
  return lines.reduce<number | null>((sum, l) => {
    const t = lineTotal(l.quantity, pick(l));
    return t === null ? sum : (sum ?? 0) + t;
  }, null);
}

export function toVendorThread(input: VendorThreadSource): VendorThreadView {
  const lines = input.lines.map(toVendorLine);

  return {
    thread_id: input.thread_id,
    quotation_no: input.quotation_no,
    status: input.status,
    pickup_city: input.pickup_city,
    pickup_state: input.pickup_state,
    lines,
    total_units: lines.reduce((n, l) => n + l.quantity, 0),
    ask_total: sumBy(lines, (l) => l.ask_price),
    counter_total: sumBy(lines, (l) => l.counter_price),
    agreed_total: sumBy(lines, (l) => l.agreed_price),
    sent_at: input.sent_at,
    responded_at: input.responded_at,
    // A struck or lost thread is over. The server still refuses either way —
    // this only stops us showing a button that would 409.
    can_respond: input.status === "SENT" || input.status === "COUNTERED",
  };
}
