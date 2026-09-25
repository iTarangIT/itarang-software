// The action executor — the ONLY code that turns a pending action into CRM
// writes (Invariant 3). Reached only from a Confirm button tap (router), never
// from text and never from the model.
//
//   1. Claim, atomically: pending → executing, only if it belongs to the tapper
//      and has not expired. Everything else (replay, expired, double tap,
//      another user's id) loses here and is classified for the reply.
//   2. Re-check the pilot flag — the user may have been removed since the preview.
//   3. ONE transaction: tag the actor for the audit triggers, lock the lead row,
//      assertOwner + assertNotStale INSIDE it (against the version the preview
//      was built on), apply every write, then mark the action confirmed with its
//      after-values. Any throw rolls all of it back.
//   4. High-impact Lost at step 1: the same checks, but instead of writing the
//      CRM it creates the step-2 confirmation and marks step 1 `escalated`.
//   5. On any failure the action ends `failed` with the reason — never left
//      `executing` (a finally-guard, and the sweep for a dead process).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assertNotStale, assertOwner, ForbiddenLeadAccessError, StaleLeadError } from "@/lib/leads/ownership";
import { writesEnabledFor } from "./config";
import { createPending } from "./actions";
import { APPLIERS } from "./appliers";
import type { AssistantUser, Preview, WriteToolName } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ActionRow = {
    id: string;
    user_id: string;
    tool: WriteToolName;
    lead_id: string;
    lead_version: string | Date | null;
    input: Record<string, unknown>;
    preview: Preview;
    status: string;
    step: number;
    expires_at: string | Date;
};

export type ExecOutcome =
    | { kind: "confirmed"; actionId: string; title: string; after: Record<string, unknown>; crmUrl: string }
    | { kind: "second_confirm"; actionId: string; preview: Preview }
    | { kind: "expired" }
    | { kind: "already_done" }
    | { kind: "already_cancelled" }
    | { kind: "in_progress" }
    | { kind: "failed_before" }
    | { kind: "awaiting_second_confirm" }
    | { kind: "not_found" }
    | { kind: "rejected"; reason: "stale" | "not_owner" | "writes_disabled" | "lead_missing" | "not_claimable" }
    | { kind: "error"; message: string };

/** Why a tap could not claim a pending action. */
type Unclaimable = Extract<
    ExecOutcome,
    { kind: "expired" | "already_done" | "already_cancelled" | "in_progress" | "failed_before" | "awaiting_second_confirm" | "not_found" }
>;

export type CancelOutcome = { kind: "cancelled" } | Unclaimable;

/** A rejection the executor maps to a reply; the action is marked failed with it. */
export class ActionRejected extends Error {
    constructor(readonly reason: Extract<ExecOutcome, { kind: "rejected" }>["reason"]) {
        super(`rejected: ${reason}`);
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a tap could not claim the action — read-only, after the claim failed. */
async function classifyUnclaimable(actionId: string, userId: string): Promise<Unclaimable> {
    const rows = await db.execute<{ status: string; user_id: string; expired: boolean }>(sql`
        SELECT status, user_id::text AS user_id, (expires_at <= now()) AS expired
          FROM assistant_actions WHERE id = ${actionId}::uuid
    `);
    const r = rows[0];
    // Another user's action id is answered exactly like a missing one.
    if (!r || r.user_id !== userId) return { kind: "not_found" };
    if (r.status === "pending" && r.expired) {
        await db.execute(sql`
            UPDATE assistant_actions SET status = 'expired', updated_at = now()
             WHERE id = ${actionId}::uuid AND status = 'pending'
        `);
        return { kind: "expired" };
    }
    switch (r.status) {
        case "expired":
            return { kind: "expired" };
        case "confirmed":
            return { kind: "already_done" };
        case "cancelled":
            return { kind: "already_cancelled" };
        case "executing":
            return { kind: "in_progress" };
        case "escalated":
            return { kind: "awaiting_second_confirm" };
        default:
            return { kind: "failed_before" };
    }
}

async function markFailed(actionId: string, error: string): Promise<void> {
    await db.execute(sql`
        UPDATE assistant_actions SET status = 'failed', error = ${error.slice(0, 1000)}, updated_at = now()
         WHERE id = ${actionId}::uuid AND status = 'executing'
    `);
}

/** Lead fields captured before/after a write, for the audit row. */
async function leadSnapshot(tx: Tx, leadId: string): Promise<Record<string, unknown>> {
    const rows = await tx.execute<Record<string, unknown>>(sql`
        SELECT lead_status, lost_reason, interest_level, next_follow_up_at, current_owner_id, asm_id,
               last_worked_at, updated_at
          FROM dealer_leads WHERE id = ${leadId}
    `);
    return rows[0] ?? {};
}

export async function executeAction(
    actionId: string,
    user: AssistantUser,
    opts: { messageId: string | null },
): Promise<ExecOutcome> {
    if (!UUID_RE.test(actionId)) return { kind: "not_found" };

    // 1. Claim.
    const claimed = await db.execute<ActionRow>(sql`
        UPDATE assistant_actions SET status = 'executing', updated_at = now()
         WHERE id = ${actionId}::uuid AND user_id = ${user.id}::uuid
           AND status = 'pending' AND expires_at > now()
        RETURNING id, user_id::text AS user_id, tool, lead_id, lead_version, input, preview, status, step, expires_at
    `);
    const action = claimed[0];
    if (!action) return classifyUnclaimable(actionId, user.id);

    let settled = false;
    try {
        // 2. Pilot flag, again.
        if (!writesEnabledFor(user.id)) throw new ActionRejected("writes_disabled");

        const applier = APPLIERS[action.tool];
        if (!applier) throw new Error(`no executor for tool ${action.tool}`);
        const plan = applier.schema.parse(action.input);
        const needsSecond = action.step === 1 && applier.needsSecondConfirm(plan);

        // 3. One transaction.
        const outcome = await db.transaction(async (tx): Promise<ExecOutcome> => {
            await tx.execute(sql`SELECT set_config('app.actor_id', ${user.id}, true)`);
            const locked = await tx.execute<{ id: string }>(sql`
                SELECT id FROM dealer_leads WHERE id = ${action.lead_id} FOR UPDATE
            `);
            if (locked.length === 0) throw new ActionRejected("lead_missing");

            if (applier.ownership === "owner") {
                await assertOwner(action.lead_id, user.id, { tx });
            } else {
                const ok = await applier.assertClaimable(tx, action.lead_id, user);
                if (!ok) throw new ActionRejected("not_claimable");
            }
            if (action.lead_version) {
                await assertNotStale(action.lead_id, new Date(action.lead_version), { tx });
            }

            // 4. High-impact: a second confirmation instead of the write.
            if (needsSecond) {
                const preview: Preview = {
                    ...action.preview,
                    warning: applier.secondConfirmWarning(plan),
                    needs_second_confirm: false,
                };
                const next = await createPending(
                    {
                        userId: user.id,
                        tool: action.tool,
                        leadId: action.lead_id,
                        leadVersion: action.lead_version ? new Date(action.lead_version) : null,
                        plan: plan as Record<string, unknown>,
                        preview,
                        before: await leadSnapshot(tx, action.lead_id),
                        sourceMessageId: opts.messageId,
                        step: 2,
                        parentActionId: action.id,
                    },
                    { tx },
                );
                await tx.execute(sql`
                    UPDATE assistant_actions
                       SET status = 'escalated', executed_at = now(), updated_at = now(),
                           after = ${JSON.stringify({ second_confirm_action_id: next.id })}::jsonb
                     WHERE id = ${action.id}::uuid AND status = 'executing'
                `);
                return { kind: "second_confirm", actionId: next.id, preview };
            }

            const written = await applier.apply({ tx, user, step: action.step as 1 | 2 }, plan);
            const after = { ...(await leadSnapshot(tx, action.lead_id)), ...written };
            const done = await tx.execute<{ id: string }>(sql`
                UPDATE assistant_actions
                   SET status = 'confirmed', executed_at = now(), updated_at = now(),
                       after = ${JSON.stringify(after)}::jsonb
                 WHERE id = ${action.id}::uuid AND status = 'executing'
                RETURNING id
            `);
            // The sweep took it (the process stalled past 5 minutes): roll back.
            if (done.length === 0) throw new Error("action was no longer executing");
            return {
                kind: "confirmed",
                actionId: action.id,
                title: action.preview.title,
                after,
                crmUrl: action.preview.crm_url,
            };
        });
        settled = true;
        return outcome;
    } catch (err) {
        const reason =
            err instanceof ActionRejected
                ? err.reason
                : err instanceof StaleLeadError
                  ? "stale"
                  : err instanceof ForbiddenLeadAccessError
                    ? "not_owner"
                    : null;
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(action.id, reason ? `rejected: ${reason}` : message);
        settled = true;
        return reason ? { kind: "rejected", reason } : { kind: "error", message };
    } finally {
        // Never leave an action `executing` — even if markFailed itself threw.
        if (!settled) await markFailed(action.id, "executor aborted").catch(() => {});
    }
}

/** Cancel tap: pending → cancelled, for the owner only. */
export async function cancelAction(actionId: string, user: AssistantUser): Promise<CancelOutcome> {
    if (!UUID_RE.test(actionId)) return { kind: "not_found" };
    const rows = await db.execute<{ id: string }>(sql`
        UPDATE assistant_actions SET status = 'cancelled', updated_at = now()
         WHERE id = ${actionId}::uuid AND user_id = ${user.id}::uuid AND status = 'pending'
        RETURNING id
    `);
    if (rows.length > 0) return { kind: "cancelled" };
    return classifyUnclaimable(actionId, user.id);
}

/**
 * The sweep (run every minute in-process): expire stale previews, and fail any
 * action stuck in `executing` for 5 minutes — the process died mid-write, its
 * transaction rolled back, so nothing was written.
 */
export async function sweepActions(): Promise<{ expired: number; failed: number }> {
    const expired = await db.execute<{ id: string }>(sql`
        UPDATE assistant_actions SET status = 'expired', updated_at = now()
         WHERE status = 'pending' AND expires_at <= now()
        RETURNING id
    `);
    const failed = await db.execute<{ id: string }>(sql`
        UPDATE assistant_actions
           SET status = 'failed', error = 'stuck in executing (process restart?); nothing was written', updated_at = now()
         WHERE status = 'executing' AND updated_at < now() - interval '5 minutes'
        RETURNING id
    `);
    return { expired: expired.length, failed: failed.length };
}
