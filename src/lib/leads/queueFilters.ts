/**
 * The filter shape the Inside Sales and ASM queues share.
 *
 * CLIENT-SAFE — no `db` import, so the filter bar can read the vocabulary
 * without dragging the postgres driver into the browser bundle. Same split, and
 * the same reason, as src/lib/leads/access.ts.
 *
 * ONE SHAPE FOR BOTH DASHBOARDS. The two queues ask the same five questions —
 * which stage, how warm, where, and over what dates — and each adds its own on
 * top (visit status/outcome for the ASM; NeoDove and callback for the rep).
 * Holding the common five here is what lets one <QueueFilterBar>, one SQL
 * builder and one CSV export serve both, so a fix to either lands on both.
 *
 * EVERY FIELD IS A STRING, and "" means "not set". They are bound to <select>
 * and <input type="date"> elements, which have no other empty value, and it
 * makes the URL round-trip (`?status=Converted`) exactly the same shape as the
 * state.
 */

import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";

export type QueueFilters = {
  /** `dealer_leads.lead_status`, exact. "" = any. */
  status: string;
  /** `dealer_leads.interest_level`, lower-cased. "" = any. */
  interest: string;
  /** `dealer_leads.state`, exact — the options come from the same column. */
  state: string;
  /** `dealer_leads.city`, exact. Narrowed by `state` in the UI. */
  city: string;
  /** Start of the date range, YYYY-MM-DD, inclusive. */
  from: string;
  /** End of the date range, YYYY-MM-DD, INCLUSIVE — see queueFilterSql. */
  to: string;
};

export const EMPTY_QUEUE_FILTERS: QueueFilters = {
  status: "",
  interest: "",
  state: "",
  city: "",
  from: "",
  to: "",
};

export const QUEUE_FILTER_KEYS = Object.keys(
  EMPTY_QUEUE_FILTERS,
) as (keyof QueueFilters)[];

/**
 * How each status is written for a human.
 *
 * The raw values are database identifiers (`Assigned_Not_Contacted`) and a
 * filter that offers them verbatim reads as a data dump. StatusChip renders the
 * same labels from this map, so the chip in a row and the option that selects it
 * can never disagree.
 */
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  New_Unassigned: "Unassigned",
  Assigned_Not_Contacted: "Assigned",
  Under_Discussion: "Under Discussion",
  Commercials_Explained: "Commercials Explained",
  Commercials_Finalised: "Commercials Finalised",
  Awaiting_Customer_Decision: "Awaiting Decision",
  Transferred_to_ASM: "Transferred to ASM",
  Converted: "Converted",
  Lost: "Lost",
};

export const LEAD_STATUS_OPTIONS: { value: string; label: string }[] =
  LEAD_STATUS.map((s) => ({ value: s, label: LEAD_STATUS_LABEL[s] }));

/**
 * The interest vocabulary, matching InterestChip's colour map.
 *
 * `order_placed` is in the list because the AI scorer writes it and a lead
 * carrying it would otherwise be unreachable by any filter value — invisible
 * rather than merely uncoloured.
 */
export const INTEREST_OPTIONS: { value: string; label: string }[] = [
  { value: "hot", label: "Hot" },
  { value: "warm", label: "Warm" },
  { value: "cold", label: "Cold" },
  { value: "order_placed", label: "Order Placed" },
];

/** How many filters are currently doing work — drives the "Filters (n)" badge. */
export function countQueueFilters(f: QueueFilters): number {
  return QUEUE_FILTER_KEYS.filter((k) => f[k] !== "").length;
}

export function hasAnyQueueFilter(f: QueueFilters): boolean {
  return countQueueFilters(f) > 0;
}

/** YYYY-MM-DD. Anything else is dropped rather than sent to the server. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read filters back off a URL.
 *
 * Every closed vocabulary is VALIDATED, not trusted: a value outside it would
 * seed a <select> with no matching option, which renders as a blank selection
 * that is silently filtering the list. State and city are deliberately NOT
 * validated — they are data, not a vocabulary, and an unknown one matching
 * nothing is the truthful answer for a place this queue has no leads in.
 */
export function readQueueFilters(sp: URLSearchParams): QueueFilters {
  const status = sp.get("status") ?? "";
  const interest = (sp.get("interest") ?? "").toLowerCase();
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  return {
    status: (LEAD_STATUS as readonly string[]).includes(status) ? status : "",
    interest: INTEREST_OPTIONS.some((o) => o.value === interest) ? interest : "",
    state: sp.get("state")?.trim() ?? "",
    city: sp.get("city")?.trim() ?? "",
    from: ISO_DATE.test(from) ? from : "",
    to: ISO_DATE.test(to) ? to : "",
  };
}

/** Write filters onto a URLSearchParams. Unset filters write no param at all. */
export function writeQueueFilters(
  p: URLSearchParams,
  f: QueueFilters,
): URLSearchParams {
  for (const k of QUEUE_FILTER_KEYS) {
    if (f[k]) p.set(k, f[k]);
  }
  return p;
}

/**
 * The region tree a queue's own leads span — what the State/City selects offer.
 *
 * Scoped to the tab rather than to the whole `dealer_leads` table on purpose: an
 * ASM offered every state in the country would spend most clicks discovering
 * that their queue has nothing there.
 */
export type QueueRegion = { state: string; cities: string[] };
