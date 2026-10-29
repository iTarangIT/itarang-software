// D8 — the callback loop. Every promise Priya makes becomes a timed task for
// ONE named ISR, in the CRM and (once switched on) in NeoDove. The CRM keeps
// the clock, because NeoDove cannot.
//
//   handOffToIsr()          right after the call (postCallOutcome): the lead's
//                           owner, or the next ISR on the "callback owners"
//                           list, is assigned (system assignment, no human
//                           actor), told by bell + email with the call brief.
//   runCallbackLoopTick()   every 5 minutes (src/instrumentation-node.ts):
//                           15 min before due → reminder (+ NeoDove push when
//                           the switch is on); 30 min overdue with no call →
//                           Sales Head + the ISR told.
//   noteNeodoveCallForCallback()  a NeoDove call result (inbound.ts): a
//                           connected call closes it (a call-back disposition
//                           books the next working morning); "not connected"
//                           re-arms it 2 h later, and the 3rd closes it as Not
//                           reached with a follow-up 3 working days on.
//   resolveComplaint()      a complaint closes only when someone resolves it.
//
// Everything reads lead_callbacks through to_jsonb / a column probe, so it is
// safe on a database without E-362 (the loop simply does nothing). Never
// throws: a failure here loses a reminder, never a call.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { emit } from "@/lib/notifications/emit";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";
import { assignLeadOwner, resolveAssignTarget } from "@/lib/leads/assignOwner";
import { SYSTEM_ASSIGNMENT_REMARK } from "@/lib/leads/leadAssignedBy";
import { markSalesReady } from "@/lib/leads/salesReady";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { hasCallOutcomeTables } from "@/lib/ai/storage/callOutcomeStore";
import {
    briefLines,
    KIND_LABEL,
    pickInTurn,
    type CallbackBrief,
    type CallbackKind,
} from "./callbackBrief";

export { briefLines, buildCallbackBrief, pickInTurn } from "./callbackBrief";
export type { CallbackBrief, CallbackKind } from "./callbackBrief";
import { nextWorkingMorning } from "./callCategory";


export const CALLBACK_LOOP_SETTINGS_KEY = "callback_loop";
/** Reminder (and NeoDove push) this long before the promised time. */
export const REMIND_BEFORE_MS = 15 * 60_000;
/** Overdue this long after the promised time with no call → escalate. */
export const ESCALATE_AFTER_MS = 30 * 60_000;
/** A NeoDove call that did not connect re-arms the callback this much later. */
export const NOT_CONNECTED_RETRY_MS = 2 * 60 * 60_000;
/** After this many unconnected NeoDove calls the callback closes as Not reached. */
export const MAX_NOT_CONNECTED = 3;
/** The follow-up set when a callback closes as Not reached (B-3). */
export const NOT_REACHED_FOLLOW_UP_WORKING_DAYS = 3;

export const ASSIGNED_TYPE = "lead.callback_assigned";
export const REMINDER_TYPE = "lead.callback_reminder";
export const OVERDUE_TYPE = "lead.callback_overdue";

const SALES_HEAD_ROLES = ["sales_head"];

function rows<T>(r: unknown): T[] {
    return ((r as { rows?: T[] }).rows ?? (r as T[])) || [];
}

// ── Settings ────────────────────────────────────────────────────────────────

export type CallbackLoopSettings = {
    /** ISRs who take callbacks of unowned leads, in turn. Nidhi first. */
    ownerIds: string[];
    /** Round-robin position. */
    cursor: number;
    /** Push the lead into the ISR's NeoDove campaign before the due time. Off until tested. */
    neodovePush: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
};

export async function getCallbackLoopSettings(): Promise<CallbackLoopSettings> {
    try {
        const r = rows<{ value: Record<string, unknown> | null; updated_at: string | null }>(
            await db.execute(sql`
                SELECT value, updated_at::text AS updated_at FROM app_settings
                 WHERE key = ${CALLBACK_LOOP_SETTINGS_KEY} LIMIT 1
            `),
        )[0];
        const v = r?.value ?? {};
        return {
            ownerIds: Array.isArray(v.owner_ids) ? (v.owner_ids as unknown[]).map(String) : [],
            cursor: Number.isFinite(Number(v.cursor)) ? Number(v.cursor) : 0,
            neodovePush: v.neodove_push === true,
            updatedBy: typeof v.updated_by === "string" ? v.updated_by : null,
            updatedAt: r?.updated_at ?? null,
        };
    } catch {
        return { ownerIds: [], cursor: 0, neodovePush: false, updatedBy: null, updatedAt: null };
    }
}

export async function setCallbackLoopSettings(input: {
    ownerIds: string[];
    neodovePush: boolean;
    updatedBy: string;
}): Promise<CallbackLoopSettings> {
    const prev = await getCallbackLoopSettings();
    const value = {
        owner_ids: [...new Set(input.ownerIds)],
        cursor: prev.cursor,
        neodove_push: input.neodovePush,
        updated_by: input.updatedBy,
    };
    const now = new Date();
    await db
        .insert(appSettings)
        .values({ key: CALLBACK_LOOP_SETTINGS_KEY, value, updated_at: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
    return getCallbackLoopSettings();
}

/**
 * The next ISR on the list, advancing the cursor in one UPDATE so two calls
 * finishing together do not both land on the same person. Inactive users are
 * skipped.
 */
async function nextCallbackOwner(): Promise<{ id: string; name: string | null; role: string | null } | null> {
    const settings = await getCallbackLoopSettings();
    for (let tries = 0; tries < settings.ownerIds.length; tries++) {
        const bumped = rows<{ cursor: string }>(
            await db.execute(sql`
                UPDATE app_settings
                   SET value = jsonb_set(value, '{cursor}',
                               to_jsonb(COALESCE((value->>'cursor')::int, 0) + 1))
                 WHERE key = ${CALLBACK_LOOP_SETTINGS_KEY}
                RETURNING (COALESCE((value->>'cursor')::int, 1) - 1)::text AS cursor
            `),
        )[0];
        const id = pickInTurn(settings.ownerIds, Number(bumped?.cursor ?? 0));
        if (!id) return null;
        const t = await resolveAssignTarget(id);
        if (t.ok) return t.target;
    }
    return null;
}

// ── Probe ───────────────────────────────────────────────────────────────────

let probe: { at: number; ok: boolean } | null = null;
/** E-362 applied here (the loop columns on lead_callbacks)? */
export async function hasCallbackLoopColumns(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = rows<{ n: number }>(
            await db.execute(sql`
                SELECT count(*)::int AS n FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'lead_callbacks'
                   AND column_name IN ('kind', 'brief', 'reminded_at', 'escalated_at', 'push_attempts', 'neodove_pushed_at')
            `),
        );
        probe = { at: Date.now(), ok: Number(r[0]?.n) === 6 };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

// ── Hand-off ────────────────────────────────────────────────────────────────

/**
 * Give the callback to one ISR. The lead's current owner keeps it; an unowned
 * lead goes to the next ISR on the list. Returns the ISR's id, or null when
 * nobody could be picked (the caller then falls back to telling the admins).
 */
export async function handOffToIsr(input: {
    leadId: string;
    callbackId: string;
    kind: CallbackKind;
    dueAt: Date;
    brief: CallbackBrief;
    /** Only the first hand-off of a callback notifies — a refresh is silent. */
    notify: boolean;
}): Promise<string | null> {
    try {
        if (!(await hasCallbackLoopColumns())) return null;
        const lead = rows<{
            owner_id: string | null;
            owner_name: string | null;
            owner_role: string | null;
            lead_status: string | null;
            name: string | null;
        }>(
            await db.execute(sql`
                SELECT dl.current_owner_id AS owner_id, u.name AS owner_name, u.role AS owner_role,
                       dl.lead_status, COALESCE(dl.shop_name, dl.dealer_name, dl.phone) AS name
                  FROM dealer_leads dl
                  LEFT JOIN users u ON u.id::text = dl.current_owner_id
                 WHERE dl.id = ${input.leadId}
            `),
        )[0];
        if (!lead) return null;

        let ownerId = lead.owner_id;
        let ownerRole = lead.owner_role;
        const when = input.dueAt.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "numeric",
            month: "short",
            hour: "numeric",
            minute: "2-digit",
        });
        if (!ownerId) {
            const target = await nextCallbackOwner();
            if (!target) return null;
            // Sales-ready reason BEFORE the assignment, or assigning stamps
            // "assigned by an admin" (first event wins).
            await markSalesReady(db, {
                leadId: input.leadId,
                reason: input.kind === "qualified" ? "ai_qualified" : "ai_callback",
                actorId: null,
            });
            const out = await assignLeadOwner({
                leadId: input.leadId,
                fromStatus: (lead.lead_status as LeadStatus | null) ?? null,
                target,
                actorId: null,
                actorRole: null,
                remarks: `${SYSTEM_ASSIGNMENT_REMARK} — ${KIND_LABEL[input.kind]}, due ${when}.`,
                touchpointType: "lead_assigned",
            });
            if (!out.assigned) return null;
            ownerId = target.id;
            ownerRole = target.role;
        }

        await db.execute(sql`
            UPDATE lead_callbacks
               SET assigned_user_id = ${ownerId}, kind = ${input.kind},
                   brief = ${JSON.stringify(input.brief)}::jsonb, updated_at = now()
             WHERE id = ${input.callbackId}
        `);

        if (input.notify) {
            const lines = briefLines(input.brief);
            await emit({
                type: ASSIGNED_TYPE,
                title: `${KIND_LABEL[input.kind]}: ${lead.name ?? "a dealer"} — due ${when}`,
                message: lines.join("\n"),
                leadId: input.leadId,
                stage: "AI callback",
                from: SYSTEM_PARTY,
                to: [
                    {
                        audience: { kind: "user", userId: ownerId },
                        as: { party: "admin", label: "iTarang Sales" },
                        href: leadHrefFor(ownerRole, input.leadId),
                    },
                ],
                data: { callbackId: input.callbackId, kind: input.kind, dueAt: input.dueAt.toISOString() },
                email: true,
            });
        }
        return ownerId;
    } catch (e) {
        console.warn("[callbackLoop] hand-off failed:", e instanceof Error ? e.message : e);
        return null;
    }
}

// ── NeoDove push ────────────────────────────────────────────────────────────

/** The ISR's own NeoDove campaign (crm_owner_user_id), read through to_jsonb (E-237 may be absent). */
async function ownerCampaignId(ownerId: string): Promise<string | null> {
    try {
        const r = rows<{ id: string }>(
            await db.execute(sql`
                SELECT c.id FROM neodove_campaigns c
                 WHERE to_jsonb(c) ->> 'crm_owner_user_id' = ${ownerId}
                   AND c.push_endpoint_ref IS NOT NULL
                 ORDER BY c.created_at DESC
                 LIMIT 1
            `),
        );
        return r[0]?.id ?? null;
    } catch {
        return null;
    }
}

async function pushToOwnerCampaign(cb: DueRow): Promise<void> {
    if (!cb.assigned_user_id) return;
    const campaignId = await ownerCampaignId(cb.assigned_user_id);
    if (!campaignId) {
        await emit({
            type: OVERDUE_TYPE,
            title: "Callback not sent to NeoDove — the ISR has no campaign",
            message: `${cb.name ?? cb.lead_id}: ${cb.owner_name ?? "the ISR"} has no NeoDove campaign of her own, so the callback was not pushed. It is still in her CRM Follow-ups.`,
            leadId: cb.lead_id,
            from: SYSTEM_PARTY,
            to: [{ audience: { kind: "roles", roles: SALES_HEAD_ROLES }, as: { party: "admin", label: "Sales Head" }, href: `/leads?lead=${cb.lead_id}` }],
        });
        return;
    }
    const { pushOneLead } = await import("@/lib/neodove/pushOne");
    const brief = (cb.brief ?? null) as CallbackBrief | null;
    const res = await pushOneLead({
        leadId: cb.lead_id,
        campaignId,
        // The lead has an owner by now; without force NeoDove would be told
        // "someone is already working it".
        force: true,
        extraFields: brief
            ? {
                  itarang_callback_purpose: brief.purpose,
                  itarang_callback_due: brief.promise,
                  itarang_product_lines: brief.productLines.join(", "),
                  itarang_volume: brief.volume ?? "",
                  itarang_open_questions: brief.openQuestions.join(", "),
                  itarang_second_number: brief.secondNumber ?? "",
              }
            : undefined,
    });
    if (res.ok) {
        await db.execute(sql`UPDATE lead_callbacks SET neodove_pushed_at = now() WHERE id = ${cb.id}`);
    } else {
        console.warn(`[callbackLoop] NeoDove push failed for ${cb.lead_id}: ${res.message}`);
    }
}

// ── The 5-minute tick ───────────────────────────────────────────────────────

type DueRow = {
    id: string;
    lead_id: string;
    assigned_user_id: string | null;
    due_at: string;
    kind: CallbackKind;
    brief: unknown;
    name: string | null;
    owner_name: string | null;
    owner_role: string | null;
};

const DUE_ROW_COLUMNS = sql`
    lc.id, lc.lead_id, lc.assigned_user_id, lc.due_at::text AS due_at, lc.kind, lc.brief,
    (SELECT COALESCE(dl.shop_name, dl.dealer_name, dl.phone) FROM dealer_leads dl WHERE dl.id = lc.lead_id) AS name,
    (SELECT u.name FROM users u WHERE u.id::text = lc.assigned_user_id) AS owner_name,
    (SELECT u.role FROM users u WHERE u.id::text = lc.assigned_user_id) AS owner_role`;

export async function runCallbackLoopTick(now: Date = new Date()): Promise<{
    reminded: number;
    pushed: number;
    escalated: number;
}> {
    const out = { reminded: 0, pushed: 0, escalated: 0 };
    if (!(await hasCallOutcomeTables()) || !(await hasCallbackLoopColumns())) return out;
    const settings = await getCallbackLoopSettings();
    const remindBy = new Date(now.getTime() + REMIND_BEFORE_MS).toISOString();
    const escalateBy = new Date(now.getTime() - ESCALATE_AFTER_MS).toISOString();

    // Claim, then act: the UPDATE … RETURNING is what makes a reminder go once.
    const due = rows<DueRow>(
        await db.execute(sql`
            WITH claimed AS (
                UPDATE lead_callbacks lc
                   SET reminded_at = now(), updated_at = now()
                 WHERE lc.owner_type = 'sales' AND lc.status = 'open'
                   AND lc.reminded_at IS NULL AND lc.assigned_user_id IS NOT NULL
                   AND lc.due_at <= ${remindBy}::timestamptz
                RETURNING lc.*
            )
            SELECT ${DUE_ROW_COLUMNS} FROM claimed lc
        `),
    );
    for (const cb of due) {
        out.reminded++;
        const lines = briefLines((cb.brief ?? {}) as CallbackBrief).slice(0, 4);
        await emit({
            type: REMINDER_TYPE,
            title: `${KIND_LABEL[cb.kind] ?? "Callback"} due ${new Date(cb.due_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}: ${cb.name ?? "a dealer"}`,
            message: lines.join("\n") || "A callback Priya promised is due.",
            leadId: cb.lead_id,
            stage: "AI callback",
            from: SYSTEM_PARTY,
            to: [
                {
                    audience: { kind: "user", userId: cb.assigned_user_id! },
                    as: { party: "admin", label: "iTarang Sales" },
                    href: leadHrefFor(cb.owner_role, cb.lead_id),
                },
            ],
            email: true,
        });
        if (settings.neodovePush) {
            await pushToOwnerCampaign(cb).catch((e) =>
                console.warn("[callbackLoop] push failed:", e instanceof Error ? e.message : e),
            );
            out.pushed++;
        }
    }

    // Overdue with no call since it fell due: tell the Sales Head and the ISR.
    const late = rows<DueRow>(
        await db.execute(sql`
            WITH claimed AS (
                UPDATE lead_callbacks lc
                   SET escalated_at = now(), updated_at = now()
                 WHERE lc.owner_type = 'sales' AND lc.status = 'open'
                   AND lc.escalated_at IS NULL
                   -- Only callbacks the loop handed to an ISR: callbacks opened
                   -- before D8 (no ISR) must not all escalate on the first tick.
                   AND lc.assigned_user_id IS NOT NULL
                   AND lc.due_at <= ${escalateBy}::timestamptz
                   AND NOT EXISTS (
                       SELECT 1 FROM lead_touchpoints t
                        WHERE t.dealer_lead_id = lc.lead_id
                          AND t.touchpoint_type = 'inside_sales_call'
                          AND t.performed_at >= lc.due_at - interval '15 minutes')
                RETURNING lc.*
            )
            SELECT ${DUE_ROW_COLUMNS} FROM claimed lc
        `),
    );
    for (const cb of late) {
        out.escalated++;
        const message = `${cb.name ?? cb.lead_id}: the ${(KIND_LABEL[cb.kind] ?? "callback").toLowerCase()} due ${new Date(cb.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} has no call yet${cb.owner_name ? ` (${cb.owner_name})` : ""}.`;
        const to: Parameters<typeof emit>[0]["to"] = [
            {
                audience: { kind: "roles", roles: SALES_HEAD_ROLES },
                as: { party: "admin", label: "Sales Head" },
                href: `/leads?lead=${cb.lead_id}`,
            },
        ];
        if (cb.assigned_user_id) {
            to.push({
                audience: { kind: "user", userId: cb.assigned_user_id },
                as: { party: "admin", label: "iTarang Sales" },
                href: leadHrefFor(cb.owner_role, cb.lead_id),
            });
        }
        await emit({
            type: OVERDUE_TYPE,
            title: `Overdue: ${cb.name ?? "a promised callback"}`,
            message,
            leadId: cb.lead_id,
            stage: "AI callback",
            from: SYSTEM_PARTY,
            to,
            email: true,
        });
    }
    return out;
}

// ── NeoDove results ─────────────────────────────────────────────────────────

/**
 * A NeoDove call on a lead with an open callback. Connected → done (a
 * call-back disposition books the next working morning instead). Not
 * connected → 2 h later, up to 3 tries; then Not reached, owner kept, a
 * follow-up 3 working days on. A complaint is not closed by a call — only by
 * resolveComplaint — but a connected call stops its escalation.
 */
export async function noteNeodoveCallForCallback(input: {
    leadId: string;
    connected: boolean;
    callBackAsked: boolean;
}): Promise<void> {
    try {
        if (!(await hasCallOutcomeTables()) || !(await hasCallbackLoopColumns())) return;
        const cb = rows<{ id: string; kind: string; push_attempts: number }>(
            await db.execute(sql`
                SELECT id, kind, push_attempts FROM lead_callbacks
                 WHERE lead_id = ${input.leadId} AND owner_type = 'sales' AND status IN ('open', 'dialing')
                 LIMIT 1
            `),
        )[0];
        if (!cb) return;

        if (input.connected) {
            if (cb.kind === "complaint") {
                await db.execute(sql`
                    UPDATE lead_callbacks SET escalated_at = COALESCE(escalated_at, now()), updated_at = now()
                     WHERE id = ${cb.id}
                `);
                return;
            }
            if (input.callBackAsked) {
                // Dynamic: campaignTracker imports this module (no AI redial on an open callback).
                const { defaultRetryWindow } = await import("@/lib/queue/campaignTracker");
                const due = nextWorkingMorning(new Date(), await defaultRetryWindow());
                await db.execute(sql`
                    UPDATE lead_callbacks
                       SET due_at = ${due.toISOString()}::timestamptz, reminded_at = NULL,
                           escalated_at = NULL, updated_at = now()
                     WHERE id = ${cb.id}
                `);
                await db.execute(sql`
                    UPDATE dealer_leads SET next_follow_up_at = ${due.toISOString()}::timestamptz
                     WHERE id = ${input.leadId}
                `);
                return;
            }
            await db.execute(sql`
                UPDATE lead_callbacks
                   SET status = 'done', completed_at = now(),
                       completion_note = 'ISR reached the dealer on NeoDove.', updated_at = now()
                 WHERE id = ${cb.id} AND status IN ('open', 'dialing')
            `);
            return;
        }

        const tries = Number(cb.push_attempts) + 1;
        if (tries >= MAX_NOT_CONNECTED) {
            const { loadOfficeCalendar } = await import("@/lib/calendar/holidays");
            const { workingDaysDueAt } = await import("@/lib/calendar/officeCalendar");
            const { holidays, hours } = await loadOfficeCalendar();
            const follow = workingDaysDueAt(new Date(), NOT_REACHED_FOLLOW_UP_WORKING_DAYS, holidays, hours);
            await db.execute(sql`
                UPDATE lead_callbacks
                   SET status = 'expired', push_attempts = ${tries}, completed_at = now(),
                       completion_note = ${`Not reached after ${tries} NeoDove calls.`}, updated_at = now()
                 WHERE id = ${cb.id}
            `);
            if (follow) {
                await db.execute(sql`
                    UPDATE dealer_leads SET next_follow_up_at = ${follow.toISOString()}::timestamptz
                     WHERE id = ${input.leadId}
                `);
            }
            return;
        }
        const again = new Date(Date.now() + NOT_CONNECTED_RETRY_MS);
        await db.execute(sql`
            UPDATE lead_callbacks
               SET push_attempts = ${tries}, due_at = ${again.toISOString()}::timestamptz,
                   reminded_at = NULL, escalated_at = NULL, updated_at = now()
             WHERE id = ${cb.id}
        `);
    } catch (e) {
        console.warn("[callbackLoop] NeoDove result not applied:", e instanceof Error ? e.message : e);
    }
}

/** A complaint is closed only when someone marks it resolved. */
export async function resolveComplaint(leadId: string, userId: string, note: string): Promise<boolean> {
    if (!(await hasCallOutcomeTables())) return false;
    const r = rows<{ id: string }>(
        await db.execute(sql`
            UPDATE lead_callbacks
               SET status = 'done', completed_at = now(), completed_by = ${userId},
                   completion_note = ${note || "Complaint resolved."}, updated_at = now()
             WHERE lead_id = ${leadId} AND status IN ('open', 'dialing')
               AND to_jsonb(lead_callbacks) ->> 'kind' = 'complaint'
            RETURNING id
        `),
    );
    return r.length > 0;
}

// ── No double calling ───────────────────────────────────────────────────────

/** D8 — leads among `leadIds` with an open promised callback: the AI does not dial them. */
export async function leadsWithOpenCallback(leadIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (leadIds.length === 0 || !(await hasCallOutcomeTables())) return out;
    try {
        for (let i = 0; i < leadIds.length; i += 5000) {
            const chunk = leadIds.slice(i, i + 5000);
            const r = rows<{ lead_id: string }>(
                await db.execute(sql`
                    SELECT DISTINCT lead_id FROM lead_callbacks
                     WHERE owner_type = 'sales' AND status IN ('open', 'dialing')
                       AND lead_id IN (${sql.join(
                           chunk.map((id) => sql`${id}`),
                           sql`, `,
                       )})
                `),
            );
            for (const row of r) out.add(row.lead_id);
        }
    } catch (e) {
        console.warn("[callbackLoop] open-callback check failed:", e instanceof Error ? e.message : e);
    }
    return out;
}
