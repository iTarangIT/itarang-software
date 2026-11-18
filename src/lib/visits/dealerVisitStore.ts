/**
 * Tracker ID 241 — reads and writes for visits on an existing dealer (account).
 * Rules: ./dealerVisitOutcomes.ts. Columns: drizzle/E-386_dealer_visit_outcomes.sql.
 *
 * E-386 is NOT mirrored in schema.ts (Drizzle lists every column in its INSERTs),
 * so its columns are raw SQL behind hasDealerVisitOutcomes(): before the
 * migration the visit form keeps today's outcome list and books nothing.
 *
 * A booked dealer visit is an ordinary lead_visits row: visit_status 'scheduled',
 * account_id set, dealer_lead_id NULL (so a converted lead's own "next visit" and
 * missed-visit lists are not touched). One open booking per account: a done visit
 * takes it over (as a lead visit does, ID 196) and a new date replaces any other.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceAccountSql } from "@/lib/accounts/accountList";
import { matchedUnion, REVENUE_IS_CREDIT, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import {
    DEALER_VISIT_OUTCOME_LABELS,
    isDealerVisitOutcome,
    sortHistory,
    type HistoryItem,
} from "./dealerVisitOutcomes";
import { VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let probe: { at: number; ok: boolean } | null = null;

/** Is E-386 on this database? Cached for a minute. */
export async function hasDealerVisitOutcomes(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 60_000) return probe.ok;
    let ok = false;
    try {
        const r = rowsOf<{ ok: boolean }>(
            await db.execute(sql`
                SELECT EXISTS (SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'lead_visits'
                                  AND column_name = 'dealer_outcome') AS ok`),
        );
        ok = Boolean(r[0]?.ok);
    } catch {
        ok = false;
    }
    probe = { at: Date.now(), ok };
    return ok;
}

/**
 * A done visit on the account takes over its open booking dated on or before the
 * visit day (keeping the planned date); any other open booking is cancelled with
 * a "replaced by" note. Returns the booking's id to update, or null.
 */
export async function takeOverAccountBooking(tx: Tx, accountId: string, day: string): Promise<string | null> {
    const open = rowsOf<{ visit_id: string; due: boolean }>(
        await tx.execute(sql`
            SELECT visit_id::text AS visit_id, (scheduled_date IS NULL OR scheduled_date <= ${day}::date) AS due
              FROM lead_visits
             WHERE account_id = ${accountId}
               AND visit_status IN ('scheduled', 'pending_scheduling')
             ORDER BY scheduled_date DESC NULLS LAST, created_at DESC
             FOR UPDATE
        `),
    );
    const keep = open.find((o) => o.due) ?? null;
    const rest = open.filter((o) => o !== keep).map((o) => o.visit_id);
    if (rest.length > 0) {
        await tx.execute(sql`
            UPDATE lead_visits
               SET visit_status = 'cancelled',
                   visit_remarks = concat_ws(' · ', NULLIF(visit_remarks, ''), ${`replaced by the visit on ${day}`}::text),
                   updated_at = NOW()
             WHERE visit_id::text IN (${sql.join(rest.map((id) => sql`${id}`), sql`, `)})
        `);
    }
    return keep?.visit_id ?? null;
}

/** Write the 241-2 fields on a visit row (E-386 must be on). */
export async function setDealerVisitFields(
    tx: Tx,
    visitId: string,
    f: { dealerOutcome: string; reportedAmount: number | null; nextVisitDate: string | null; noFollowUp: boolean },
): Promise<void> {
    await tx.execute(sql`
        UPDATE lead_visits
           SET dealer_outcome = ${f.dealerOutcome},
               reported_amount = ${f.reportedAmount},
               no_follow_up = ${f.noFollowUp},
               next_visit_date = ${f.nextVisitDate}::date,
               next_action = ${f.nextVisitDate ? "schedule_visit" : null},
               updated_at = NOW()
         WHERE visit_id::text = ${visitId}
    `);
}

/** Book the next dealer visit for `asmId` (after takeOverAccountBooking cleared the others). */
export async function bookAccountVisit(tx: Tx, accountId: string, asmId: string, date: string): Promise<string> {
    const [row] = rowsOf<{ visit_id: string }>(
        await tx.execute(sql`
            INSERT INTO lead_visits (dealer_lead_id, account_id, asm_id, scheduled_date, visit_status, meeting_mode)
            VALUES (NULL, ${accountId}, ${asmId}, ${date}::date, 'scheduled', 'ground')
            RETURNING visit_id::text AS visit_id
        `),
    );
    return row!.visit_id;
}

export type AccountBooking = { visit_id: string; scheduled_date: string | null; asm_name: string | null };

/** The account's open booked visit (the newest), or null. Fail-soft. */
export async function openAccountBooking(accountId: string): Promise<AccountBooking | null> {
    try {
        const [r] = rowsOf<AccountBooking>(
            await db.execute(sql`
                SELECT v.visit_id::text AS visit_id, v.scheduled_date::text AS scheduled_date, u.name AS asm_name
                  FROM lead_visits v LEFT JOIN users u ON u.id::text = v.asm_id
                 WHERE (to_jsonb(v) ->> 'account_id') = ${accountId}
                   AND v.visit_status IN ('scheduled', 'pending_scheduling')
                 ORDER BY v.created_at DESC
                 LIMIT 1
            `),
        );
        return r ?? null;
    } catch {
        return null;
    }
}

export type BookedDealerVisit = {
    visit_id: string;
    account_id: string;
    dealer: string;
    city: string | null;
    scheduled_date: string;
    asm_id: string;
    asm_name: string | null;
};

/** My visits (241-2): dealer visits booked for these people, oldest date first. Fail-soft. */
export async function bookedDealerVisits(asmIds: readonly string[]): Promise<BookedDealerVisit[]> {
    if (asmIds.length === 0) return [];
    try {
        return rowsOf<BookedDealerVisit>(
            await db.execute(sql`
                SELECT v.visit_id::text AS visit_id, a.id AS account_id, a.business_entity_name AS dealer,
                       a.city, v.scheduled_date::text AS scheduled_date, v.asm_id, u.name AS asm_name
                  FROM lead_visits v
                  JOIN accounts a ON a.id = (to_jsonb(v) ->> 'account_id')
                  LEFT JOIN users u ON u.id::text = v.asm_id
                 WHERE v.dealer_lead_id IS NULL
                   AND (to_jsonb(v) ->> 'account_id') IS NOT NULL
                   AND v.visit_status IN ('scheduled', 'pending_scheduling')
                   AND v.asm_id IN (${sql.join(asmIds.map((id) => sql`${id}`), sql`, `)})
                 ORDER BY v.scheduled_date ASC NULLS LAST, a.business_entity_name
                 LIMIT 200
            `),
        );
    } catch (err) {
        console.warn("[dealerVisits] booked list failed", err instanceof Error ? err.message : err);
        return [];
    }
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * 241-1: the dealer's ONE history — visits (with outcome, remarks, photo, verified,
 * the rep-reported amount), the booked visit, account quotes, recorded orders and
 * invoices — newest first. Each part is fail-soft, so a database without one of
 * the tables still shows the rest.
 */
export async function accountHistory(accountId: string, convertedOn: string | null, cameThroughLead: boolean): Promise<HistoryItem[]> {
    const items: HistoryItem[] = [];

    try {
        const visits = rowsOf<Record<string, unknown>>(
            await db.execute(sql`
                SELECT v.visit_status, v.visit_outcome, v.visit_remarks, v.photos,
                       v.actual_visit_date::text AS actual_visit_date, v.scheduled_date::text AS scheduled_date,
                       COALESCE(to_jsonb(v) ->> 'captured_at', v.created_at::text) AS at,
                       to_jsonb(v) ->> 'verified' AS verified,
                       to_jsonb(v) ->> 'dealer_outcome' AS dealer_outcome,
                       to_jsonb(v) ->> 'reported_amount' AS reported_amount,
                       u.name AS by_name
                  FROM lead_visits v LEFT JOIN users u ON u.id::text = v.asm_id
                 WHERE (to_jsonb(v) ->> 'account_id') = ${accountId}
                   AND v.visit_status IN ('visited', 'scheduled', 'pending_scheduling')
                 ORDER BY v.created_at DESC
                 LIMIT 200
            `),
        );
        for (const v of visits) {
            const booked = v.visit_status !== "visited";
            if (booked) {
                items.push({
                    kind: "booked",
                    at: String(v.scheduled_date ?? v.at),
                    title: "Visit booked",
                    detail: v.scheduled_date ? null : "Date not set yet",
                    by: (v.by_name as string) ?? null,
                });
                continue;
            }
            const dOut = isDealerVisitOutcome(v.dealer_outcome) ? DEALER_VISIT_OUTCOME_LABELS[v.dealer_outcome] : null;
            const lOut = VISIT_OUTCOME_LABELS[v.visit_outcome as VisitOutcome] ?? null;
            const amount = v.reported_amount != null && v.reported_amount !== "" ? Number(v.reported_amount) : null;
            const photos = Array.isArray(v.photos) ? (v.photos as unknown[]).filter((p): p is string => typeof p === "string") : [];
            items.push({
                kind: "visit",
                at: String(v.at ?? v.actual_visit_date),
                title: `Visit${dOut || lOut ? ` · ${dOut ?? lOut}` : ""}`,
                detail: (v.visit_remarks as string) || null,
                by: (v.by_name as string) ?? null,
                photo: photos[0] ?? null,
                verified: v.verified === "true",
                reportedAmount: amount != null && Number.isFinite(amount) ? amount : null,
            });
        }
    } catch (err) {
        console.warn("[dealerHistory] visits", err instanceof Error ? err.message : err);
    }

    try {
        const quotes = rowsOf<Record<string, unknown>>(
            await db.execute(sql`
                SELECT q.quote_number, q.price_quoted, q.approval_status, q.dealer_decision,
                       COALESCE(to_jsonb(q) ->> 'created_at', q.approved_at::text) AS at,
                       u.name AS by_name
                  FROM account_quotations q
                  LEFT JOIN users u ON u.id::text = (to_jsonb(q) ->> 'created_by')
                 WHERE q.account_id = ${accountId} AND q.is_current
                 ORDER BY 5 DESC NULLS LAST
                 LIMIT 100
            `),
        );
        for (const q of quotes) {
            if (!q.at) continue;
            const price = q.price_quoted != null ? Number(q.price_quoted) : null;
            const state = q.dealer_decision
                ? `dealer ${String(q.dealer_decision).replace(/_/g, " ")}`
                : String(q.approval_status ?? "").replace(/_/g, " ");
            items.push({
                kind: "quote",
                at: String(q.at),
                title: `Quote${q.quote_number ? ` ${q.quote_number}` : ""}${price != null && Number.isFinite(price) ? ` · ${inr(price)}` : ""}`,
                detail: state ? `Status: ${state}` : null,
                by: (q.by_name as string) ?? null,
            });
        }
    } catch (err) {
        console.warn("[dealerHistory] quotes", err instanceof Error ? err.message : err);
    }

    try {
        const orders = rowsOf<Record<string, unknown>>(
            await db.execute(sql`
                SELECT c.order_date::text AS order_date, c.po_number, c.note, c.withdrawn_at, u.name AS by_name
                  FROM account_order_claims c LEFT JOIN users u ON u.id::text = c.claimed_by::text
                 WHERE c.account_id = ${accountId}
                 ORDER BY c.order_date DESC
                 LIMIT 100
            `),
        );
        for (const o of orders) {
            items.push({
                kind: "order",
                at: String(o.order_date),
                title: `Order recorded${o.po_number ? ` · PO ${o.po_number}` : ""}${o.withdrawn_at ? " (withdrawn)" : ""}`,
                detail: (o.note as string) || "Counts as the latest order for 15 days, until its invoice comes in.",
                by: (o.by_name as string) ?? null,
            });
        }
    } catch (err) {
        console.warn("[dealerHistory] orders", err instanceof Error ? err.message : err);
    }

    try {
        const inv = rowsOf<Record<string, unknown>>(
            await db.execute(sql`
                WITH ${await invoicesByAccountCteWithNumber()}
                SELECT invoice_date::text AS invoice_date, total, is_credit, invoice_number, source
                  FROM inv WHERE k = ${accountId}
                 ORDER BY invoice_date DESC
                 LIMIT 200
            `),
        );
        for (const r of inv) {
            const total = Number(r.total ?? 0);
            const credit = r.is_credit === true;
            items.push({
                kind: "invoice",
                at: String(r.invoice_date),
                title: `${credit ? "Credit note" : "Invoice"} · ${inr(Math.abs(total))}`,
                detail: [r.source === "zoho" ? "From Zoho" : r.source === "credit" ? null : "From Vyapar", r.invoice_number]
                    .filter(Boolean)
                    .join(" · ") || null,
            });
        }
    } catch (err) {
        console.warn("[dealerHistory] invoices", err instanceof Error ? err.message : err);
    }

    if (convertedOn) {
        items.push({
            kind: "joined",
            at: convertedOn,
            title: "Became a dealer",
            detail: cameThroughLead ? "Converted from a lead. Earlier calls and visits are on the lead's history." : null,
        });
    }
    return sortHistory(items);
}

/**
 * The same invoice set My dealers counts (orderClaims.invoicesByAccountCte: matched,
 * not void, keyed by invoiceAccountSql), plus the number and source for the history.
 */
async function invoicesByAccountCteWithNumber() {
    const invoices = await matchedUnion();
    const k = invoiceAccountSql();
    return sql`inv AS MATERIALIZED (
        SELECT ${k} AS k, r.invoice_date, r.total, ${REVENUE_IS_CREDIT} AS is_credit,
               r.invoice_number, r.source
          FROM ${invoices} AS r
         WHERE ${k} IS NOT NULL AND ${REVENUE_NOT_VOID}
    )`;
}
