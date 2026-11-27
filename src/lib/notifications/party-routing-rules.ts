/**
 * 27 Nov 2026 — "who hears about each file action" (Sales Head → Settings →
 * File action alerts). Pure and framework-free: the settings screen, the API
 * route and emit() all import it, so the screen and the sender can never drift.
 *
 * For every lead-file notification type the Sales Head ticks, per PARTY of
 * that file, which CHANNELS it goes out on (CRM bell, email, WhatsApp).
 *
 * A type with NO saved row keeps the built-in behaviour exactly (whatever the
 * code in events.ts addresses). A type WITH a saved row is "custom": for the
 * six parties below the ticks are the whole answer — ticked adds the party,
 * unticked silences that channel for them. Everybody outside those parties
 * (admin, CEO, business head…) keeps the built-in behaviour either way.
 * The one exception is EMAIL_LOCKED types (agreement / consent / sanction
 * links): a person the code already emails keeps that email.
 */
import { CATEGORIES, categorize, type NotificationCategory } from "./catalog";

export const PARTIES = [
  "actor",
  "dealer",
  "salesperson",
  "sales_head",
  "nbfc_partner",
  "nbfc_child",
] as const;
export type PartyKey = (typeof PARTIES)[number];

export const PARTY_LABELS: Record<PartyKey, { label: string; hint: string }> = {
  actor: { label: "Action person", hint: "The person who did the action" },
  dealer: { label: "Dealer", hint: "The dealer the file belongs to" },
  salesperson: {
    label: "Salesperson",
    hint: "Who sent the file for the dealer (iTarang salesperson or the dealer's own sales staff)",
  },
  sales_head: { label: "Sales Head", hint: "Every Sales Head login" },
  nbfc_partner: { label: "NBFC partner", hint: "NBFC logins on the file (approvers / main users)" },
  nbfc_child: { label: "NBFC child user", hint: "NBFC team members who report to an approver" },
};

export const CHANNELS = ["bell", "email", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = {
  bell: "CRM bell",
  email: "Email",
  whatsapp: "WhatsApp",
};

export type ChannelSet = Record<Channel, boolean>;
export type TypeRule = Record<PartyKey, ChannelSet>;
export interface PartyRoutingSettings {
  /** notification type → rule. Only types the Sales Head customised. */
  rules: Record<string, TypeRule>;
}

/** The lead-file categories this screen governs — the NBFC / Sales Head actions on a customer file. */
export const FILE_CATEGORIES: NotificationCategory[] = [
  "Leads",
  "KYC & Consent",
  "NBFC Requests",
  "Loan & Sanction",
  "Field Investigation",
  "Video KYC",
  "E-NACH",
  "Agreements",
  "Product & Dispatch",
];

export function isFileType(type: string): boolean {
  return FILE_CATEGORIES.includes(categorize(type));
}

/** Category order for the screen, from the one canonical list. */
export function fileCategoryOrder(): NotificationCategory[] {
  return CATEGORIES.filter((c) => FILE_CATEGORIES.includes(c));
}

export const EMPTY_CHANNELS: ChannelSet = { bell: false, email: false, whatsapp: false };

export function emptyRule(): TypeRule {
  return Object.fromEntries(PARTIES.map((p) => [p, { ...EMPTY_CHANNELS }])) as TypeRule;
}

/** Starting point when a Sales Head first customises a type: everyone gets the bell, involved outsiders also get email + WhatsApp. */
export function suggestedRule(): TypeRule {
  const r = emptyRule();
  for (const p of PARTIES) r[p] = { bell: true, email: p !== "actor", whatsapp: p !== "actor" };
  return r;
}

/** Drops unknown types/parties/channels and coerces everything to booleans. */
export function normalizePartyRouting(
  raw: unknown,
  knownType: (t: string) => boolean = isFileType,
): PartyRoutingSettings {
  const out: PartyRoutingSettings = { rules: {} };
  const rules = (raw as { rules?: unknown } | null)?.rules;
  if (!rules || typeof rules !== "object") return out;
  for (const [type, rule] of Object.entries(rules as Record<string, unknown>)) {
    if (!knownType(type) || !rule || typeof rule !== "object") continue;
    const clean = emptyRule();
    for (const p of PARTIES) {
      const ch = (rule as Record<string, unknown>)[p];
      if (!ch || typeof ch !== "object") continue;
      for (const c of CHANNELS) clean[p][c] = (ch as Record<string, unknown>)[c] === true;
    }
    out.rules[type] = clean;
  }
  return out;
}

/**
 * Which channels one PERSON gets, given the parties they belong to on this
 * file. The action person is judged ONLY by the "Action person" column — an
 * NBFC approver who approved the file is not re-notified as "NBFC partner".
 * Everyone else gets the union of their parties' ticks.
 */
export function channelsForPerson(rule: TypeRule, parties: ReadonlySet<PartyKey>): ChannelSet {
  if (parties.has("actor")) return { ...rule.actor };
  const out = { ...EMPTY_CHANNELS };
  for (const p of parties) for (const c of CHANNELS) if (rule[p][c]) out[c] = true;
  return out;
}

/** A WhatsApp body for any staff / dealer phone. */
export function buildPartyWhatsApp(p: {
  title: string;
  message: string;
  customer: string;
  reference: string;
  actor?: string | null;
}): string {
  return [
    `*${p.title}*`,
    p.message,
    `Customer: ${p.customer}`,
    `Ref: ${p.reference}`,
    p.actor ? `By: ${p.actor}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
