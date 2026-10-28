/**
 * The KYC action log: one line per thing anybody did on a file's KYC — the
 * dealer uploading or submitting, Admin / Sales Head approving a card or asking
 * for documents, the final decision, the system auto-approving — with who did
 * it and when. Kept in audit_logs (entity_type 'kyc_event', entity_id = lead
 * id), read back by kycTimeline() for the KYC review page and the dealer's
 * KYC page.
 *
 * Each line is also sent on WhatsApp to the people who follow KYC files: the
 * iTarang house dealer logins, every active Admin and Sales Head, and the
 * dealer who owns the file — never to the person who did it. That send is off
 * unless KYC_EVENT_WHATSAPP=1, so a sandbox never messages real staff. Staff
 * rarely have an open 24h window with our number, so they are reached by the
 * `kyc_update` template once Meta approves it (WA_TEMPLATES_APPROVED); until
 * then the line goes out as free text and only lands inside the window.
 *
 * ID 201 (Kartik, 27 Oct): each line also holds the actor type (owning
 * dealer, its WhatsApp salesperson, the iTarang house login, iTarang staff,
 * a customer, the system), the channel (web / WhatsApp / system) and the
 * dealer acted for — in `changes`, no migration. The owning dealer sees
 * "iTarang team" instead of iTarang people's names (history and WhatsApp);
 * iTarang logins keep the names.
 *
 * Never throws: a log line or a WhatsApp send must never fail the action it
 * describes.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { fileDealerNames, recordActorStep, type LeadActor } from "@/lib/leads/actForDealerGuard";
import {
    actorLabel,
    istTime,
    ITARANG_TEAM,
    kycActorType,
    kycChannel,
    kycEventMessage,
    kycRecipients,
    type KycActor,
    type KycActorType,
    type KycChannel,
} from "./kycEventText";

export { kycCardLabel, kycDecisionLine, type KycActor, type KycActorType, type KycChannel } from "./kycEventText";

export const KYC_EVENT = "kyc_event";


export interface KycEventInput {
    leadId: string;
    /** What happened, in words: "PAN card approved", "Documents requested: …". */
    action: string;
    actor: KycActor;
    /** Extra facts stored with the line (ids, reasons). Not sent on WhatsApp. */
    detail?: Record<string, unknown>;
    /** false = log only, no WhatsApp (high-volume or already-announced steps). */
    notify?: boolean;
}

// ── Write ───────────────────────────────────────────────────────────────────

export async function recordKycEvent(input: KycEventInput): Promise<void> {
    const at = new Date();
    try {
        // Callers that only know the user id (the final decision) get the name here.
        if (input.actor.id && !input.actor.name) {
            const [u] = (await db.execute(sql`
                SELECT name, lower(role) AS role FROM users WHERE id::text = ${input.actor.id} LIMIT 1`)) as unknown as Array<{
                name: string | null;
                role: string | null;
            }>;
            input = { ...input, actor: { ...input.actor, name: u?.name ?? null, role: input.actor.role ?? u?.role ?? null } };
        }
    } catch {
        /* the line is still worth writing without a name */
    }
    // ID 201: a dealer-role login that is the house is iTarang, not the dealer.
    try {
        if (input.actor.id && kycActorType(input.actor) === "dealer" && (await isHouseUser(input.actor.id))) {
            input = { ...input, actor: { ...input.actor, type: "house" } };
        }
        if (input.actor.forDealerId && !input.actor.forDealerName) {
            const { display } = await fileDealerNames(input.actor.forDealerId);
            input = { ...input, actor: { ...input.actor, forDealerName: display } };
        }
    } catch {
        /* written without the house / dealer name */
    }
    try {
        await db.insert(auditLogs).values({
            id: `AUDIT-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}-kyc`,
            entity_type: KYC_EVENT,
            entity_id: input.leadId,
            action: input.action.slice(0, 50),
            changes: {
                line: input.action,
                by_name: input.actor.name,
                by_role: input.actor.role,
                ...(input.detail ?? {}),
                actor_type: kycActorType(input.actor),
                channel: kycChannel(input.actor),
                for_dealer_id: input.actor.forDealerId ?? null,
                for_dealer_name: input.actor.forDealerName ?? null,
            },
            performed_by: input.actor.id,
            timestamp: at,
        });
    } catch (err) {
        console.error(`[kycEventLog] log for ${input.leadId} failed:`, err);
    }

    if (input.notify === false || process.env.KYC_EVENT_WHATSAPP !== "1") return;
    // Not awaited: the action's response must not wait on a dozen WhatsApp sends.
    void fanOutKycEvent(input, at).catch((err) =>
        console.error(`[kycEventLog] WhatsApp for ${input.leadId} failed:`, err),
    );
}

/** Is this user a login of the iTarang house dealer? */
async function isHouseUser(userId: string): Promise<boolean> {
    const { houseDealerCode } = await import("@/lib/leads/dealerByMobile");
    const house = await houseDealerCode();
    if (!house) return false;
    const [u] = (await db.execute(sql`
        SELECT dealer_id FROM users WHERE id::text = ${userId} LIMIT 1`)) as unknown as Array<{ dealer_id: string | null }>;
    return !!u?.dealer_id && u.dealer_id === house;
}

async function fanOutKycEvent(input: KycEventInput, at: Date): Promise<void> {
    const rowsOf = <T,>(r: unknown) => r as T[];
    const [lead] = rowsOf<{ reference_id: string | null; full_name: string | null; owner_name: string | null; dealer_id: string | null }>(
        await db.execute(sql`
            SELECT reference_id, full_name, owner_name, dealer_id FROM leads WHERE id = ${input.leadId} LIMIT 1`),
    );
    if (!lead) return;
    const customerName = lead.full_name || lead.owner_name || "a customer";
    const referenceId = lead.reference_id || input.leadId;
    const actor = actorLabel(input.actor);
    const body = kycEventMessage({ customerName, referenceId, action: input.action, actor, at });

    const { resolveHouseDealer } = await import("@/lib/whatsapp/customer-lead");
    const house = await resolveHouseDealer().catch(() => null);

    // Staff who follow KYC (Admin, Sales Head) and the house dealer logins.
    // A verified Sales Assistant binding wins over the free-text users.phone.
    const people = rowsOf<{ user_id: string; phone: string | null }>(
        await db.execute(sql`
            SELECT u.id::text AS user_id,
                   COALESCE(
                     (SELECT b.wa_phone FROM assistant_wa_bindings b
                       WHERE b.user_id = u.id AND b.status = 'active' AND b.wa_phone IS NOT NULL
                       LIMIT 1),
                     u.phone) AS phone
              FROM users u
             WHERE u.is_active IS NOT FALSE
               AND (lower(u.role) IN ('admin', 'sales_head')
                    OR (${house?.dealerCode ?? null}::text IS NOT NULL AND u.dealer_id = ${house?.dealerCode ?? null}))`),
    );
    let actorPhone: string | null = null;
    if (input.actor.id) {
        const [a] = rowsOf<{ phone: string | null }>(
            await db.execute(sql`SELECT phone FROM users WHERE id::text = ${input.actor.id} LIMIT 1`),
        );
        actorPhone = a?.phone ?? null;
    }
    const to = kycRecipients(people, { id: input.actor.id, phone: actorPhone });

    const { getAdapter } = await import("@/lib/whatsapp");
    const { logOutbound } = await import("@/lib/whatsapp/notifications");
    const { resolveTemplate } = await import("@/lib/whatsapp/templates");
    const { oneLine } = await import("@/lib/whatsapp/window");
    const tpl = resolveTemplate("kyc_update");
    const params = [customerName, referenceId, input.action, actor, istTime(at)].map((p) => oneLine(p));
    const adapter = getAdapter();
    await Promise.all(
        to.map(async (phone) => {
            const res = tpl
                ? await adapter.sendTemplate(phone, tpl.name, tpl.lang, params)
                : await adapter.sendText(phone, body);
            await logOutbound(null, res, tpl
                ? { messageType: "template", textBody: params.join(" | "), templateName: tpl.name }
                : { messageType: "text", textBody: body });
            if (!res.ok) console.warn(`[kycEventLog] WhatsApp to ${phone.slice(-4)} not delivered: ${res.error ?? "unknown"}`);
        }),
    );

    // The dealer who owns the file — unless their own side did it (their login,
    // their salesperson, their customer), or the file is the house's own
    // (already covered above). ID 201: the house acting on a file it pushed out
    // is iTarang, so the dealer is told; iTarang people are "iTarang team" to them.
    const type = kycActorType(input.actor);
    const ownSide = type === "dealer" || type === "salesperson" || type === "customer";
    if (!ownSide && lead.dealer_id && lead.dealer_id !== house?.dealerCode) {
        const forDealer = type === "system" ? actor : ITARANG_TEAM;
        const { pushToLeadDealer } = await import("@/lib/whatsapp/lead-push");
        await pushToLeadDealer(input.leadId, (t) => ({
            prompt: {
                kind: "text",
                body: kycEventMessage({ customerName: t.customerName, referenceId: t.referenceId, action: input.action, actor: forDealer, at }),
            },
            nudge: { template: "lead_action", params: [t.customerName, t.referenceId, `KYC update: ${input.action}`] },
        }));
    }
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface KycTimelineRow {
    at: string;
    line: string;
    byName: string | null;
    byRole: string | null;
    kind: "kyc" | "final_decision";
    /** ID 201. Lines written before 28 Oct are worked out from the role (house by the login's dealer). */
    actorType: KycActorType;
    channel: KycChannel;
    forDealerName: string | null;
}

/**
 * Every KYC line on a file, newest first: this log plus the final decisions
 * (their own audit row, which predates this log). The "Done by … for <dealer>"
 * history stays on its own panel (ActForDealerPanel); every KYC step it covers
 * is also a line here.
 */
export async function kycTimeline(leadId: string, limit = 200): Promise<KycTimelineRow[]> {
    const rows = (await db.execute(sql`
        SELECT l.timestamp AS at, l.entity_type, l.action, l.changes, u.name AS user_name, u.role AS user_role,
               u.dealer_id AS user_dealer_id, l.performed_by::text AS performed_by
          FROM audit_logs l
          LEFT JOIN users u ON u.id = l.performed_by
         WHERE l.entity_id = ${leadId}
           AND ((l.entity_type = ${KYC_EVENT} AND COALESCE(l.changes->>'final_decision', '') <> 'true')
                OR l.entity_type = 'kyc_final_decision')
         ORDER BY l.timestamp DESC
         LIMIT ${limit}`)) as unknown as Array<{
        at: string | Date;
        entity_type: string;
        action: string | null;
        changes: Record<string, unknown> | null;
        user_name: string | null;
        user_role: string | null;
        user_dealer_id: string | null;
        performed_by: string | null;
    }>;
    const { houseDealerCode } = await import("@/lib/leads/dealerByMobile");
    const house = await houseDealerCode();
    const TYPES: KycActorType[] = ["dealer", "salesperson", "house", "itarang", "customer", "system"];
    return rows.map((r) => {
        const c = r.changes ?? {};
        const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
        const kind: KycTimelineRow["kind"] = r.entity_type === KYC_EVENT ? "kyc" : "final_decision";
        const line =
            kind === "kyc"
                ? (str(c.line) ?? r.action ?? "KYC update")
                : `Final decision: ${(r.action ?? "").replace(/_/g, " ")}${
                      str(c.rejection_reason) ? ` — ${str(c.rejection_reason)}` : ""
                  }`;
        const byRole = str(c.by_role) ?? r.user_role;
        const stored = str(c.actor_type) as KycActorType | null;
        let actorType = stored && TYPES.includes(stored) ? stored : kycActorType({ id: r.performed_by, role: byRole });
        if (!stored && actorType === "dealer" && house && r.user_dealer_id === house) actorType = "house";
        const channel = (str(c.channel) as KycChannel | null) ?? (actorType === "system" ? "system" : "web");
        return {
            at: new Date(r.at).toISOString(),
            line,
            byName: str(c.by_name) ?? r.user_name ?? (c.decided_by === "system" ? "iTarang (automatic)" : null),
            byRole,
            kind,
            actorType,
            channel,
            forDealerName: str(c.for_dealer_name),
        };
    });
}

// ── CRM checks (ID 201 #2) ──────────────────────────────────────────────────

/**
 * A check, field override or consent decision on the CRM's KYC review screen
 * (Admin, Sales Head …): "PAN check run (passed)" with who, on the web, for the
 * file's dealer. Log only unless `notify`. Never throws.
 */
export async function recordStaffKycStep(
    leadId: string,
    user: { id: string; name?: string | null; role?: string | null },
    action: string,
    opts: { result?: unknown; detail?: Record<string, unknown>; notify?: boolean } = {},
): Promise<void> {
    try {
        const { kycCheckOutcome } = await import("./kycEventText");
        const outcome = "result" in opts ? kycCheckOutcome(opts.result) : null;
        const [lead] = (await db.execute(sql`
            SELECT dealer_id FROM leads WHERE id = ${leadId} LIMIT 1`)) as unknown as Array<{ dealer_id: string | null }>;
        await recordKycEvent({
            leadId,
            action: outcome ? `${action} (${outcome})` : action,
            actor: { id: user.id, name: user.name ?? null, role: user.role ?? null, channel: "web", forDealerId: lead?.dealer_id ?? null },
            detail: opts.detail,
            notify: opts.notify ?? false,
        });
    } catch (err) {
        console.error(`[kycEventLog] staff step for ${leadId} not logged:`, err);
    }
}

// ── Dealer-portal steps ─────────────────────────────────────────────────────

/** "uploaded pan card" → "Uploaded pan card". */
export function sentence(step: string): string {
    const s = step.trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "KYC step";
}

function actorOf(actor: LeadActor): KycActor {
    // ID 201: who it was and, for iTarang, which dealer's file.
    const type: KycActorType = actor.kind === "house" ? "house" : actor.kind === "itarang" ? "itarang" : "dealer";
    return {
        id: actor.userId,
        name: actor.userName,
        role: actor.role,
        type,
        channel: "web",
        forDealerId: actor.kind === "dealer" ? null : actor.leadDealerId,
    };
}

/**
 * A KYC step in the dealer portal, by the dealer or by iTarang acting for them:
 * the "Done by" line (recordActorStep) plus a KYC log line. Log only — for
 * steps that happen many times on a file (each upload, each check, drafts).
 */
export async function recordKycStep(
    actor: LeadActor,
    step: string,
    extra: Record<string, unknown> = {},
    opts: { coalesce?: boolean; kycLine?: boolean } = {},
): Promise<void> {
    // The KYC line is written below, so the dealer's own step is not logged twice.
    opts = { ...opts, kycLine: true };
    await recordActorStep(actor, step, extra, opts);
    // A draft autosave is not an action anybody needs to see on the timeline.
    if (opts.coalesce) return;
    await recordKycEvent({ leadId: actor.leadId, action: sentence(step), actor: actorOf(actor), detail: extra, notify: false });
}

/** Same, for a milestone worth a WhatsApp line (consent, submission, re-upload). */
export async function recordKycMilestone(
    actor: LeadActor,
    step: string,
    extra: Record<string, unknown> = {},
    opts: { coalesce?: boolean; kycLine?: boolean } = {},
): Promise<void> {
    opts = { ...opts, kycLine: true };
    await recordActorStep(actor, step, extra, opts);
    await recordKycEvent({ leadId: actor.leadId, action: sentence(step), actor: actorOf(actor), detail: extra });
}
