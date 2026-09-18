/**
 * E-297 — who gets CC'd when an approved quotation is emailed to a dealer.
 *
 *   (a) the lead's current owner      dealer_leads.current_owner_id
 *   (b) whoever is sending it         the route's authenticated user (B4 —
 *                                     this replaced the quote approver)
 *   (c) an admin-configured fixed list  app_settings['quotation_cc_emails']
 *   (+) optional per-send extras typed into the send dialog
 *
 * Deduped case-insensitively, the dealer's own address removed, inactive users
 * dropped. Both id columns are text while users.id is uuid, so the join casts
 * the uuid (`u.id::text = …`) — never the text, so a non-uuid value cannot
 * throw.
 *
 * EVERYTHING HERE DEGRADES TO "NO CC". A CC is a courtesy copy; a missing
 * settings row, a DB hiccup or an unapplied migration must never stop the
 * dealer receiving their quotation. Each read is caught separately and warns.
 *
 * The pure rules live in ./quotationCcRules.ts (unit-tested).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { buildCcList, normalizeCcEmails } from "@/lib/leads/quotationCcRules";

export {
  buildCcList,
  normalizeCcEmails,
  MAX_EXTRA_CC,
  MAX_FIXED_CC,
} from "@/lib/leads/quotationCcRules";

const SETTINGS_KEY = "quotation_cc_emails";

export interface QuotationCcSettings {
  emails: string[];
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

/** The admin fixed list. Never throws — failure reads as an empty list. */
export async function getQuotationCcSettings(): Promise<QuotationCcSettings> {
  try {
    const rows = await db.execute<{
      value: unknown;
      updated_at: string | null;
      updated_by_name: string | null;
    }>(sql`
      SELECT s.value, s.updated_at, u.name AS updated_by_name
        FROM app_settings s
        LEFT JOIN users u ON u.id::text = s.value->>'updated_by'
       WHERE s.key = ${SETTINGS_KEY}
       LIMIT 1
    `);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    const value = (row?.value ?? {}) as { emails?: unknown; updated_by?: unknown };
    return {
      emails: normalizeCcEmails(value.emails),
      updated_by: typeof value.updated_by === "string" ? value.updated_by : null,
      updated_by_name: row?.updated_by_name == null ? null : String(row.updated_by_name),
      updated_at: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    };
  } catch (e) {
    console.warn("[quotationCc] could not read fixed CC list — using none", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { emails: [], updated_by: null, updated_by_name: null, updated_at: null };
  }
}

/** Replace the admin fixed list. Throws on a DB failure (the admin must know). */
export async function setQuotationCcSettings(
  emails: unknown,
  updatedBy: string,
): Promise<QuotationCcSettings> {
  const value = { emails: normalizeCcEmails(emails), updated_by: updatedBy };
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value, updated_at: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updated_at: now },
    });
  return getQuotationCcSettings();
}

/** Lower-cased addresses among `emails` that belong to an INACTIVE user. */
async function inactiveUserEmails(emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  try {
    const list = sql.join(
      emails.map((e) => sql`${e.toLowerCase()}`),
      sql`, `,
    );
    const rows = await db.execute<{ email: string }>(sql`
      SELECT lower(email) AS email
        FROM users
       WHERE lower(email) IN (${list})
         AND is_active = false
    `);
    return new Set(
      (rows as unknown as { email: string }[]).map((r) => String(r.email)),
    );
  } catch (e) {
    console.warn("[quotationCc] could not check inactive users on fixed list", {
      error: e instanceof Error ? e.message : String(e),
    });
    return new Set();
  }
}

export interface ResolvedQuotationCc {
  /** The final list to hand to sendEmail. */
  cc: string[];
  ownerEmail: string | null;
  actorEmail: string | null;
  fixed: string[];
}

/**
 * Resolve the CC list for one quotation send. Never throws.
 *
 * `dealerEmail` overrides the lead's stored address when the send dialog
 * corrected it — the exclusion must match the address actually in TO.
 * `actorId` is the authenticated sender; their address is looked up here (not
 * trusted from the client) and dropped if the account is inactive.
 */
export async function resolveQuotationCc(
  leadId: string,
  commercialId: string,
  opts: {
    dealerEmail?: string | null;
    extra?: readonly string[] | null;
    actorId?: string | null;
  } = {},
): Promise<ResolvedQuotationCc> {
  let ownerEmail: string | null = null;
  let actorEmail: string | null = null;
  let storedDealerEmail: string | null = null;

  try {
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT l.contact_email AS dealer_email,
             (SELECT u.email FROM users u
               WHERE u.id::text = l.current_owner_id AND u.is_active = true
               LIMIT 1) AS owner_email,
             (SELECT u.email FROM users u
               WHERE u.id::text = ${opts.actorId ?? null} AND u.is_active = true
               LIMIT 1) AS actor_email
        FROM dealer_lead_commercials c
        LEFT JOIN dealer_leads l ON l.id = c.dealer_lead_id
       WHERE c.commercial_id = ${commercialId}::uuid
         AND c.dealer_lead_id = ${leadId}
       LIMIT 1
    `);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (row) {
      ownerEmail = row.owner_email == null ? null : String(row.owner_email);
      actorEmail = row.actor_email == null ? null : String(row.actor_email);
      storedDealerEmail = row.dealer_email == null ? null : String(row.dealer_email);
    }
  } catch (e) {
    console.warn("[quotationCc] could not resolve owner/actor — skipping them", {
      leadId,
      commercialId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const { emails: configured } = await getQuotationCcSettings();
  const inactive = await inactiveUserEmails(configured);
  const fixed = configured.filter((e) => !inactive.has(e.toLowerCase()));

  const dealerEmail = opts.dealerEmail?.trim() || storedDealerEmail;

  return {
    cc: buildCcList({
      ownerEmail,
      actorEmail,
      fixed,
      extra: opts.extra ?? [],
      dealerEmail,
    }),
    ownerEmail,
    actorEmail,
    fixed,
  };
}
