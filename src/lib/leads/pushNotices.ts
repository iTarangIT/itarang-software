// 14 Oct — the two notices that make a pushed customer file a shared file
// between the iTarang house dealer and the dealer it was pushed to:
//
//   notifyDealerOfPush(leadId)        bell + email to the dealer that now has
//                                     the file (type lead.pushed_to_dealer).
//                                     Before, the only notice was WhatsApp —
//                                     a dealer with no chat heard nothing.
//   notifyHouseOfDealerStep(...)      bell to the house dealer when the dealer
//                                     moves a file the house pushed out forward
//                                     (KYC submitted, consent sent, products
//                                     submitted, dispatched, closed …), from
//                                     the CRM or WhatsApp (type
//                                     lead.dealer_progress; email off by
//                                     default, switchable in Settings).
//
// Both are best-effort: never throw, never block the action that fired them.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, users } from "@/lib/db/schema";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { dealerDisplayNames, houseOriginatedLeadIds } from "@/lib/leads/pushGuards";
import { emit, toLeadDealer } from "@/lib/notifications/emit";
import { ADMIN_PARTY, dealerParty } from "@/lib/notifications/provenance";

async function fileFacts(leadId: string) {
    const [l] = await db
        .select({ dealerId: leads.dealer_id, name: leads.full_name, owner: leads.owner_name, ref: leads.reference_id })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
    if (!l) return null;
    return { dealerId: l.dealerId, customer: l.name || l.owner || "a customer", ref: l.ref || leadId };
}

/** Bell + email to the dealer the file was just pushed to. */
export async function notifyDealerOfPush(leadId: string, reason?: string | null): Promise<void> {
    try {
        const f = await fileFacts(leadId);
        if (!f?.dealerId) return;
        await emit({
            type: "lead.pushed_to_dealer",
            title: "New customer file from iTarang",
            message: `iTarang sent you ${f.customer}'s file (${f.ref}). Open it to continue${reason ? ` — note: ${reason}` : ""}.`,
            leadId,
            stage: "Step 1",
            from: ADMIN_PARTY,
            emailSubject: `New customer file from iTarang: ${f.customer}`,
            to: [toLeadDealer(leadId, { href: `/dealer-portal/leads/${encodeURIComponent(leadId)}` })],
        });
    } catch (err) {
        console.error(`[pushNotices] dealer notice for ${leadId} failed:`, err);
    }
}

/**
 * ID 33 (16 Oct): bell + email + WhatsApp to the dealer a file was just moved
 * AWAY from (an admin's second move). The house is never told this way — the
 * house pushing its own file out is the normal first push.
 */
export async function notifyDealerOfPushAway(leadId: string, fromDealerId: string): Promise<void> {
    try {
        const house = await houseDealerCode();
        if (!fromDealerId || fromDealerId === house) return;
        const f = await fileFacts(leadId);
        if (!f || f.dealerId === fromDealerId) return;
        await emit({
            type: "lead.pushed_away",
            title: "Customer file moved to another dealer",
            message: `iTarang moved ${f.customer}'s file (${f.ref}) to another dealer. It is no longer on your list; any coupon you reserved on it is back in your pool.`,
            leadId,
            from: ADMIN_PARTY,
            emailSubject: `Customer file moved: ${f.customer}`,
            to: [{ audience: { kind: "dealer", dealerId: fromDealerId }, as: { party: "dealer", label: "Dealer" }, href: "/dealer-portal/leads" }],
        });
        const { pushToLeadDealer } = await import("@/lib/whatsapp/lead-push");
        const result = await pushToLeadDealer(
            leadId,
            (t) => ({
                prompt: {
                    kind: "text",
                    body:
                        `Hi ${t.greetName}, iTarang has moved *${t.customerName}*'s file (Ref: ${t.referenceId}) to another dealer.\n\n` +
                        "It is no longer on your list. Any coupon you reserved on it is back in your pool.",
                },
                nudge: { template: "lead_action", params: [t.customerName, t.referenceId, "note that iTarang moved this file to another dealer"] },
            }),
            { dealerCode: fromDealerId },
        );
        console.log(`[pushNotices] push-away notice lead=${leadId} dealer=${fromDealerId}: ${result}`);
    } catch (err) {
        console.error(`[pushNotices] push-away notice for ${leadId} failed:`, err);
    }
}

/**
 * ID 183: tell the file's dealer that iTarang worked his file ("Done by
 * <name> for <dealer>") — bell + WhatsApp (his chat, else the approved
 * template). Callers throttle (actForDealerGuard.recordActorStep).
 */
export async function notifyDealerOfAssist(leadId: string, line: string, step: string): Promise<void> {
    try {
        const f = await fileFacts(leadId);
        if (!f?.dealerId) return;
        await emit({
            type: "lead.acted_for_dealer",
            title: `iTarang worked on ${f.customer}'s file`,
            message: `${line}: ${step} on ${f.customer}'s file (${f.ref}). The file is still yours — open it to see.`,
            leadId,
            from: ADMIN_PARTY,
            to: [toLeadDealer(leadId, { href: `/dealer-portal/leads/${encodeURIComponent(leadId)}` })],
        });
        const { pushToLeadDealer } = await import("@/lib/whatsapp/lead-push");
        await pushToLeadDealer(leadId, (t) => ({
            prompt: {
                kind: "text",
                body:
                    `Hi ${t.greetName}, ${line.charAt(0).toLowerCase()}${line.slice(1)}: ${step} on *${t.customerName}*'s file (Ref: ${t.referenceId}).\n\n` +
                    "The file is still yours. Open it on the dealer portal to see.",
            },
            nudge: { template: "lead_action", params: [t.customerName, t.referenceId, `see what iTarang did: ${step}`] },
        }));
    } catch (err) {
        console.error(`[pushNotices] assist notice for ${leadId} failed:`, err);
    }
}

/**
 * Bell to the iTarang house dealer when the dealer works a file the house
 * pushed out. `actorDealerCode` = the dealer code of whoever did it; only a
 * step by the file's current dealer notifies (not the house, not an admin).
 */
export async function notifyHouseOfDealerStep(
    leadId: string,
    step: string,
    actorDealerCode: string | null | undefined,
): Promise<void> {
    try {
        const house = await houseDealerCode();
        if (!house) return;
        const f = await fileFacts(leadId);
        if (!f?.dealerId || f.dealerId === house) return;
        // Only the dealer's own work: not the house, not an iTarang admin.
        if (!actorDealerCode || actorDealerCode !== f.dealerId) return;
        if (!(await houseOriginatedLeadIds(house, [leadId])).has(leadId)) return;
        const names = await dealerDisplayNames([f.dealerId]);
        const dealer = names.get(f.dealerId) ?? f.dealerId;
        await emit({
            type: "lead.dealer_progress",
            title: `${dealer}: ${step}`,
            message: `${dealer} — ${step} for ${f.customer} (${f.ref}), a file iTarang pushed to them.`,
            leadId,
            from: dealerParty(dealer),
            to: [{ audience: { kind: "dealer", dealerId: house }, as: ADMIN_PARTY, href: `/dealer-portal/leads/${encodeURIComponent(leadId)}` }],
        });
    } catch (err) {
        console.error(`[pushNotices] house notice for ${leadId} failed:`, err);
    }
}

/** The dealer code of a signed-in user (users.dealer_id), for notifyHouseOfDealerStep. */
export async function dealerCodeOfUser(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    try {
        const [u] = await db.select({ code: users.dealer_id }).from(users).where(eq(users.id, userId)).limit(1);
        return u?.code ?? null;
    } catch {
        return null;
    }
}
