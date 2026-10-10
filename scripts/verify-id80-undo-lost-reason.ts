/**
 * Tracker IDs 80 / 134 / 136 — what replaced "Correct status" (9 Oct 2026):
 * Change Lost reason and Undo Mark Won, checked against the database in
 * DATABASE_URL.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id80-undo-lost-reason.ts
 *
 * Uses the REAL writers (changeLostReason, undoWonInTx, the onboarding
 * creator Mark Won calls). Leaves nothing behind: every write happens inside a
 * transaction that is always rolled back. Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { changeLostReason } from "@/lib/leads/changeLostReason";
import { LostReasonChangeError, planLostReasonChange } from "@/lib/leads/changeLostReasonRules";
import { checkWonUndo, getWonUndoState, undoWonInTx } from "@/lib/leads/wonUndo";
import { createOnboardingApplicationForConvertedLead } from "@/lib/onboarding/fromConvertedLead";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = Record<string, string | null>;
class Rollback extends Error {}

let failed = 0;
const say = (outcome: "PASS" | "FAIL" | "SKIP", label: string, detail = "") => {
    if (outcome === "FAIL") failed += 1;
    console.log(`${outcome}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const check = (ok: boolean, label: string, detail = "") => say(ok ? "PASS" : "FAIL", label, detail);

async function rolledBack(actorId: string, fn: (tx: Tx) => Promise<void>) {
    try {
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId}, true)`);
            await fn(tx);
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) throw e;
    }
}

const one = async (ex: Pick<typeof db, "execute">, q: ReturnType<typeof sql>) =>
    ((await ex.execute(q)) as unknown as Row[])[0];

const leadState = (ex: Pick<typeof db, "execute">, id: string) =>
    one(
        ex,
        sql`SELECT lead_status, lost_reason, current_owner_id, closing_owner_id, closed_at::text AS closed_at,
                   last_worked_at::text AS last_worked_at, dealer_onboarding_application_id::text AS app_id,
                   to_jsonb(dealer_leads) ->> 'won_at' AS won_at
              FROM dealer_leads WHERE id = ${id}`,
    );

function refused(label: string, fn: () => unknown) {
    try {
        fn();
        say("FAIL", label, "was accepted");
    } catch (e) {
        check(e instanceof LostReasonChangeError, label, e instanceof Error ? e.message : "");
    }
}

async function main() {
    console.log("database:", new URL(process.env.DATABASE_URL!).host.split(".")[0], "\n");
    const actor = await one(db, sql`SELECT id::text AS id FROM users WHERE role IN ('sales_head', 'admin') AND is_active ORDER BY role DESC LIMIT 1`);
    if (!actor?.id) {
        say("SKIP", "no active Sales Head or admin user to act as");
        return;
    }
    const actorId = actor.id;

    // ── Change Lost reason (ID 136) ─────────────────────────────────────────
    const base = { leadStatus: "Lost", currentReason: "price_high", currentCompetitor: null };
    refused("a lead that is not Lost is refused", () =>
        planLostReasonChange({ ...base, leadStatus: "Under_Discussion", to: "not_interested", note: "wrong reason" }),
    );
    refused("the same reason is refused", () => planLostReasonChange({ ...base, to: "price_high", note: "wrong reason" }));
    refused("no note is refused", () => planLostReasonChange({ ...base, to: "not_interested", note: " " }));
    refused("Lost to competition without a competitor is refused", () =>
        planLostReasonChange({ ...base, to: "lost_to_competition", note: "they bought Okaya" }),
    );
    refused("onboarding drop-out is the drop-out review's alone", () =>
        planLostReasonChange({ ...base, to: "onboarding_dropout", note: "wrong reason" }),
    );

    const lost = await one(db, sql`
        SELECT id FROM dealer_leads
         WHERE lead_status = 'Lost' AND is_active IS NOT FALSE
           AND lost_reason IS DISTINCT FROM 'not_interested'
         ORDER BY updated_at DESC LIMIT 1`);
    if (!lost?.id) {
        say("SKIP", "no Lost lead to change a reason on");
    } else {
        const leadId = lost.id;
        await rolledBack(actorId, async (tx) => {
            const before = await leadState(tx, leadId);
            await changeLostReason(
                { leadId, actor: { id: actorId, role: "sales_head" }, to: "not_interested", note: "verify script: wrong reason picked" },
                { tx },
            );
            const after = await leadState(tx, leadId);
            check(after.lost_reason === "not_interested", "the new reason is on the lead (Lost-by-reason reads it)", `${before.lost_reason} → ${after.lost_reason}`);
            check(after.lead_status === "Lost", "the lead stays Lost");
            check(after.closed_at === before.closed_at, "closed date unchanged", String(after.closed_at));
            check(after.closing_owner_id === before.closing_owner_id, "closing owner unchanged");
            check(after.last_worked_at === before.last_worked_at, "not work: the idle clock did not move");
            const h = await one(tx, sql`
                SELECT from_status, to_status, from_lost_reason, to_lost_reason, reason_notes
                  FROM dealer_lead_status_history WHERE dealer_lead_id = ${leadId}
                 ORDER BY changed_at DESC, created_at DESC LIMIT 1`);
            check(
                h?.from_status === "Lost" && h?.to_status === "Lost" &&
                    h?.from_lost_reason === before.lost_reason && h?.to_lost_reason === "not_interested",
                "history row records old → new reason",
                `${h?.from_lost_reason} → ${h?.to_lost_reason} · ${h?.reason_notes}`,
            );
        });
    }

    // ── Undo Mark Won (ID 134) ──────────────────────────────────────────────
    check(!checkWonUndo({ leadStatus: "Converted", wonFrom: "Under_Discussion", application: null }).ok, "a Converted lead cannot be undone");
    check(
        !checkWonUndo({ leadStatus: "Won", wonFrom: "Under_Discussion", application: { status: "submitted", submittedAt: "2026-10-01", documents: 3 } }).ok,
        "a Won whose dealer submitted onboarding cannot be undone (drop-out review instead)",
    );
    check(
        !checkWonUndo({ leadStatus: "Won", wonFrom: "Under_Discussion", application: { status: "draft", submittedAt: null, documents: 1 } }).ok,
        "a Won whose dealer uploaded a document cannot be undone",
    );
    const v = checkWonUndo({ leadStatus: "Won", wonFrom: "Commercials_Finalised", application: { status: "draft", submittedAt: null, documents: 0 } });
    check(v.ok && v.restoreStatus === "Commercials_Finalised", "an untouched draft: back to the exact stage before Won");

    const e333 = await one(db, sql`SELECT to_regclass('lead_won_undo_requests')::text AS t`);
    if (!e333?.t) {
        say("SKIP", "E-333 not applied on this database — the undo write path needs it");
    } else {
        const won = await one(db, sql`
            SELECT dl.id FROM dealer_leads dl
              JOIN dealer_onboarding_applications oa ON oa.id = dl.dealer_onboarding_application_id
             WHERE dl.lead_status = 'Won' AND dl.is_active IS NOT FALSE
               AND oa.onboarding_status = 'draft' AND oa.submitted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM dealer_onboarding_documents d WHERE d.application_id = oa.id)
             ORDER BY dl.updated_at DESC LIMIT 1`);
        if (!won?.id) {
            say("SKIP", "no Won lead with an untouched draft application");
        } else {
            const leadId = won.id;
            const state = await getWonUndoState(leadId);
            check(state.available && state.verdict.ok, "the lead page offers the undo", state.verdict.ok ? `back to ${state.verdict.restoreStatus}` : state.verdict.reason);
            await rolledBack(actorId, async (tx) => {
                const before = await leadState(tx, leadId);
                const { restoreStatus, appId } = await undoWonInTx(tx, leadId, actorId, "verify script: mis-click");
                const after = await leadState(tx, leadId);
                check(after.lead_status === restoreStatus, "the lead is back at its earlier stage", `${before.lead_status} → ${after.lead_status}`);
                check(after.current_owner_id === before.current_owner_id, "same owner");
                check(after.won_at === null && after.closing_owner_id === null, "Won date and closing owner removed");
                check(after.app_id === null, "the lead no longer points at the application");
                const app = await one(tx, sql`
                    SELECT onboarding_status, to_jsonb(a) ->> 'withdrawn_reason' AS why
                      FROM dealer_onboarding_applications a WHERE id = ${appId}::uuid`);
                check(app?.onboarding_status === "withdrawn" && app?.why === "Marked Won by mistake", "the empty application is withdrawn", `${app?.onboarding_status} · ${app?.why}`);
                const counted = await one(tx, sql`
                    SELECT COUNT(*)::text AS n FROM dealer_lead_status_history h
                     WHERE h.dealer_lead_id = ${leadId} AND h.to_status = 'Won'
                       AND (to_jsonb(h) ->> 'won_undone_at') IS NULL`);
                check(counted?.n === "0", "the Won no longer counts (every Mark Won row is marked undone)", `${counted?.n} counted`);
                const note = await one(tx, sql`
                    SELECT reason_notes FROM dealer_lead_status_history
                     WHERE dealer_lead_id = ${leadId} AND from_status = 'Won'
                     ORDER BY changed_at DESC, created_at DESC LIMIT 1`);
                check(Boolean(note?.reason_notes?.startsWith("Won undone: marked by mistake")), "history says 'Won undone: marked by mistake'", String(note?.reason_notes));

                // Marked Won again later: the same application is the live draft again.
                const again = await createOnboardingApplicationForConvertedLead(leadId, tx);
                const reopened = await one(tx, sql`SELECT onboarding_status FROM dealer_onboarding_applications WHERE id = ${again.applicationId}::uuid`);
                check(again.applicationId === appId && reopened?.onboarding_status === "draft", "a second Mark Won reopens the same draft", String(reopened?.onboarding_status));
            });
        }
    }

    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
}

main()
    .catch((e) => {
        console.error(e);
        failed += 1;
    })
    .finally(() => process.exit(failed ? 1 : 0));
