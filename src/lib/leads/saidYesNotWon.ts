// "Dealer said yes, not marked Won" (tracker ID 75.4) — the CEO card and the
// /ceo/said-yes list it opens. ONE query for both, so the card's count, ₹ and
// oldest wait are always the sum of the rows the list shows.
//
// Which leads: finalisedNotWonSql() with no age floor — the same predicate as
// the admin alert panel and the reps' queue chip. Per lead, the MOST RECENT
// quote the dealer approved supplies the value and the clock.
//
// Wait: working days (Mon–Sat, IST, active holidays off) since the dealer's
// yes — the same count as needsAttention's idle days. Limit: the ID 85 time
// limit said_yes_not_won (default 1 working day; getSaidYesLimit()). The admin
// alert panel lists the same "over limit" leads (finalisedNotWonSql's floor).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { finalisedNotWonSql } from "@/lib/leads/finalisedNotWon";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { dealCardJson } from "@/lib/leads/dealCard";
import { parseDealCard, type DealCard } from "@/lib/leads/dealCardRules";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";
import { getTimeLimits } from "@/lib/timeLimits/store";

/** The limit in force today, in working days. Never throws. */
export async function getSaidYesLimit(): Promise<number> {
    return (await getTimeLimits()).said_yes_not_won;
}

export type SaidYesRow = {
    lead_id: string;
    dealer: string;
    city: string | null;
    state: string | null;
    phone: string | null;
    lead_status: string | null;
    owner_name: string | null;
    owner_role: string | null;
    /** dealer_leads.current_owner_id — for the Sales Head person filter. */
    owner_id: string | null;
    commercial_id: string;
    quote_number: string | null;
    version_no: number | null;
    quote_pdf_url: string | null;
    value: number;
    lines: Array<{ product_name: string; quantity: number }>;
    credit_terms: string | null;
    customer_finance: boolean | null;
    /** ID 172: the quote's deal card (null on an older quote). */
    deal_card: DealCard | null;
    delivery_terms: string | null;
    warranty_terms: string | null;
    released_at: string | null;
    approval_mode: string | null;
    dealer_yes_at: string | null;
    dealer_yes_via: string | null;
    dealer_note: string | null;
    working_days_waiting: number;
};

export type SaidYesSummary = { count: number; value: number; oldestDays: number | null };

/** Every lead on the card, longest wait first. */
export async function listSaidYesNotWon(): Promise<SaidYesRow[]> {
    const rows = (await db.execute(sql`
        SELECT dl.id                                              AS lead_id,
               COALESCE(dl.shop_name, dl.dealer_name, '(unnamed)') AS dealer,
               dl.city, dl.state, dl.phone, dl.lead_status,
               u.name                                             AS owner_name,
               u.role                                             AS owner_role,
               dl.current_owner_id                                AS owner_id,
               v.*,
               ${workingDaysSinceSql(sql`v.dealer_yes_at`)}       AS working_days_waiting
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
          CROSS JOIN LATERAL (
              SELECT c.commercial_id, c.quote_number, c.version_no, c.quote_pdf_url,
                     COALESCE(c.final_price, c.price_quoted, 0) AS value,
                     c.product_lines, c.credit_terms, c.customer_finance,
                     ${dealCardJson("c")}                        AS deal_card,
                     c.delivery_terms, c.warranty_terms,
                     COALESCE(c.approved_at, c.created_at)     AS released_at,
                     c.approval_mode,
                     c.dealer_decision_at                      AS dealer_yes_at,
                     c.dealer_decision_via                     AS dealer_yes_via,
                     c.dealer_decision_note                    AS dealer_note
                FROM dealer_lead_commercials c
               WHERE c.dealer_lead_id = dl.id
                 AND c.dealer_decision = 'approved'
                 AND COALESCE(c.approval_status, 'approved') = 'approved'
                 AND c.withdrawn_at IS NULL
               ORDER BY c.dealer_decision_at DESC NULLS LAST
               LIMIT 1
          ) v
         WHERE ${finalisedNotWonSql()}
         ORDER BY v.dealer_yes_at ASC NULLS LAST
    `)) as unknown as Array<Record<string, unknown>>;

    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
    return rows.map((r) => ({
        lead_id: String(r.lead_id),
        dealer: String(r.dealer),
        city: (r.city as string | null) ?? null,
        state: (r.state as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        lead_status: (r.lead_status as string | null) ?? null,
        owner_name: (r.owner_name as string | null) ?? null,
        owner_role: (r.owner_role as string | null) ?? null,
        owner_id: (r.owner_id as string | null) ?? null,
        commercial_id: String(r.commercial_id),
        quote_number: (r.quote_number as string | null) ?? null,
        version_no: r.version_no == null ? null : Number(r.version_no),
        quote_pdf_url: (r.quote_pdf_url as string | null) ?? null,
        value: Number(r.value ?? 0),
        lines: Array.isArray(r.product_lines)
            ? (r.product_lines as CommercialsProductLine[]).map((l) => ({
                  product_name: l.product_name,
                  quantity: Number(l.quantity ?? 0),
              }))
            : [],
        credit_terms: (r.credit_terms as string | null) ?? null,
        customer_finance: (r.customer_finance as boolean | null) ?? null,
        deal_card: parseDealCard(r.deal_card),
        delivery_terms: (r.delivery_terms as string | null) ?? null,
        warranty_terms: (r.warranty_terms as string | null) ?? null,
        released_at: iso(r.released_at),
        approval_mode: (r.approval_mode as string | null) ?? null,
        dealer_yes_at: iso(r.dealer_yes_at),
        dealer_yes_via: (r.dealer_yes_via as string | null) ?? null,
        dealer_note: (r.dealer_note as string | null) ?? null,
        working_days_waiting: Number(r.working_days_waiting ?? 0),
    }));
}

/** The card's numbers — the sum of the list, never a second definition. */
export function summarizeSaidYes(rows: SaidYesRow[]): SaidYesSummary {
    return {
        count: rows.length,
        value: rows.reduce((a, r) => a + r.value, 0),
        oldestDays: rows.length ? Math.max(...rows.map((r) => r.working_days_waiting)) : null,
    };
}
