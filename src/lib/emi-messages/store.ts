/**
 * Tracker ID 204 — EMI customer messages, the record (E-365). Server only.
 *
 * Every message is CLAIMED before it is sent: one row per (EMI, kind,
 * channel, ref), inserted ON CONFLICT DO NOTHING — so a scheduled message
 * goes once per EMI however many processes or ticks race for it, and a
 * restart mid-send never sends it twice. Each send is also written to the
 * file's history (audit_logs, entity 'lead').
 *
 * E-365 is NOT mirrored in schema.ts: raw SQL behind hasEmiMessages().
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { EmiChannel } from "./rules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let probe: { at: number; ok: boolean } | null = null;

/** Is E-365 on this database? Cached for a minute. */
export async function hasEmiMessages(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 60_000) return probe.ok;
    let ok = false;
    try {
        const r = rowsOf<{ ok: boolean }>(
            await db.execute(sql`SELECT to_regclass('public.emi_customer_messages') IS NOT NULL AS ok`),
        );
        ok = Boolean(r[0]?.ok);
    } catch {
        ok = false;
    }
    probe = { at: Date.now(), ok };
    return ok;
}

export type EmiMessageClaim = {
    emiScheduleId: string | null;
    loanSanctionId: string;
    leadId: string | null;
    nbfcId: string | null;
    kind: string;
    channel: EmiChannel;
    ref?: string;
    phone: string | null;
    body: string;
    isTest?: boolean;
};

/** Claim one message; returns its row id, or null when it was already claimed (sent before). */
export async function claimEmiMessage(c: EmiMessageClaim): Promise<string | null> {
    const r = rowsOf<{ id: string }>(
        await db.execute(sql`
            INSERT INTO emi_customer_messages
                (emi_schedule_id, loan_sanction_id, lead_id, nbfc_id, kind, channel, ref, phone, body, is_test)
            VALUES (${c.emiScheduleId}::uuid, ${c.loanSanctionId}, ${c.leadId}, ${c.nbfcId}::uuid, ${c.kind},
                    ${c.channel}, ${c.ref ?? ""}, ${c.phone}, ${c.body}, ${c.isTest ?? false})
            ON CONFLICT DO NOTHING
            RETURNING id::text AS id
        `),
    );
    return r[0]?.id ?? null;
}

/** The send's outcome on its claimed row, and a line on the file's history. */
export async function finishEmiMessage(
    id: string,
    c: EmiMessageClaim,
    out: { status: "sent" | "failed" | "skipped"; providerMessageId: string | null; error: string | null },
): Promise<void> {
    await db.execute(sql`
        UPDATE emi_customer_messages
           SET status = ${out.status},
               provider_message_id = ${out.providerMessageId},
               error = ${out.error},
               sent_at = CASE WHEN ${out.status} = 'sent' THEN now() ELSE sent_at END
         WHERE id = ${id}::uuid
    `);
    if (!c.leadId || c.isTest) return;
    try {
        await db.execute(sql`
            INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, new_data, changes)
            VALUES (${randomUUID()}, 'lead', ${c.leadId}, 'emi_message', NULL,
                    ${JSON.stringify({ kind: c.kind, channel: c.channel, status: out.status, error: out.error })}::jsonb,
                    ${JSON.stringify({
                        note: `EMI message (${c.kind}) by ${c.channel === "sms" ? "SMS" : "WhatsApp"}: ${out.status}${out.error ? ` — ${out.error}` : ""}`,
                        loan_sanction_id: c.loanSanctionId,
                        emi_schedule_id: c.emiScheduleId,
                        message_id: id,
                    })}::jsonb)
        `);
    } catch (err) {
        // The history line is a convenience; the message row is the record.
        console.warn("[emi-messages] history line not written:", err instanceof Error ? err.message : err);
    }
}

const RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * A delivery report (WhatsApp status webhook or MSG91 delivery report) →
 * the message row, forward only (a late "sent" never undoes "delivered").
 * Returns false when no EMI message has that provider id.
 */
export async function applyEmiDelivery(providerMessageId: string, status: string): Promise<boolean> {
    const s = status.toLowerCase();
    if (s !== "failed" && !(s in RANK)) return false;
    if (!(await hasEmiMessages())) return false;
    const r = rowsOf<{ id: string }>(
        await db.execute(sql`
            UPDATE emi_customer_messages
               SET status = ${s},
                   delivered_at = CASE WHEN ${s} IN ('delivered', 'read') THEN COALESCE(delivered_at, now()) ELSE delivered_at END
             WHERE provider_message_id = ${providerMessageId}
               AND (${s} = 'failed'
                    OR COALESCE(CASE status WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 END, 0)
                       < ${RANK[s] ?? 0})
            RETURNING id::text AS id
        `),
    );
    return r.length > 0;
}
