/**
 * ID 201 #3 — a KYC step taken on WhatsApp, in the file's KYC history with
 * channel "WhatsApp" and who took it:
 *   - an iTarang operator running a customer's KYC (whatsapp_operators.user_id)
 *     → iTarang staff, for the file's dealer;
 *   - a dealer's salesperson on the dealer console → their name, "dealer's
 *     salesperson" (they have no CRM login);
 *   - a customer onboarding themselves → "Customer";
 *   - otherwise the dealer's own login (the house login is recognised as
 *     iTarang house by recordKycEvent).
 * Log only unless `notify`. Never throws: a log line must never break the chat.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { ActiveDealer } from "@/lib/whatsapp/customer-lead";

import { recordKycEvent, type KycActor } from "./kycEventLog";

type SessionLike = {
    operator_id?: string | null;
    salesperson_id?: string | null;
    application_id?: string | null;
    context?: unknown;
};

async function whatsAppActor(session: SessionLike, dealer: ActiveDealer | null | undefined, leadId: string): Promise<KycActor> {
    const [lead] = (await db.execute(sql`
        SELECT dealer_id FROM leads WHERE id = ${leadId} LIMIT 1`)) as unknown as Array<{ dealer_id: string | null }>;
    const forDealerId = lead?.dealer_id ?? dealer?.dealerCode ?? null;

    if (session.operator_id) {
        const [op] = (await db.execute(sql`
            SELECT user_id::text AS user_id, display_name FROM whatsapp_operators WHERE id::text = ${session.operator_id} LIMIT 1`)) as unknown as Array<{
            user_id: string | null;
            display_name: string | null;
        }>;
        return {
            id: op?.user_id ?? null,
            name: op?.display_name ?? "iTarang operator",
            role: op?.user_id ? null : "operator",
            type: "itarang",
            channel: "whatsapp",
            forDealerId,
        };
    }
    if (dealer?.actor?.role === "salesperson") {
        return { id: null, name: dealer.actor.displayName ?? "Salesperson", role: "salesperson", type: "salesperson", channel: "whatsapp" };
    }
    if (!dealer && session.salesperson_id) {
        const [sp] = (await db.execute(sql`
            SELECT display_name FROM dealer_salespersons WHERE id::text = ${session.salesperson_id} LIMIT 1`)) as unknown as Array<{
            display_name: string | null;
        }>;
        return { id: null, name: sp?.display_name ?? "Salesperson", role: "salesperson", type: "salesperson", channel: "whatsapp" };
    }
    const flow = (session.context as { flow?: string } | null | undefined)?.flow;
    if (flow === "customer") {
        return { id: null, name: "Customer", role: "customer", type: "customer", channel: "whatsapp" };
    }
    let uploader = dealer?.uploaderId ?? null;
    if (!uploader) {
        const { whatsappUploaderId } = await import("@/lib/storage/uploaderStamp");
        uploader = await whatsappUploaderId(session.application_id);
    }
    return { id: uploader, name: dealer?.dealerName ?? null, role: "dealer", channel: "whatsapp" };
}

export async function recordWhatsAppKycStep(input: {
    session: SessionLike;
    dealer?: ActiveDealer | null;
    leadId: string | null | undefined;
    action: string;
    notify?: boolean;
    detail?: Record<string, unknown>;
}): Promise<void> {
    if (!input.leadId) return;
    try {
        const actor = await whatsAppActor(input.session, input.dealer, input.leadId);
        // The dealer login's own name is filled in from users when only the id is known.
        if (actor.id && actor.role === "dealer") actor.name = null;
        await recordKycEvent({
            leadId: input.leadId,
            action: input.action,
            actor,
            detail: input.detail,
            notify: input.notify ?? false,
        });
    } catch (err) {
        console.error(`[kycWhatsAppLog] ${input.leadId} "${input.action}" not logged:`, err);
    }
}
