// One-off end-to-end check of D8 (the callback loop) + D10 against SANDBOX.
//
//   AGENTMAIL_API_KEY= SMTP_HOST= node --import tsx --env-file=.env.local scripts/_e2e-d8-callback-loop.ts
//
// No phone is dialled: a finished AI call is fed through preparePostCall /
// applyPostCall (what both finalizers call), the 5-minute tick is run with a
// shifted clock, and NeoDove results go through noteNeodoveCallForCallback.
// Email is blanked so nobody is mailed. The callback_loop setting is saved and
// restored; every row it writes is deleted at the end.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads } from "../src/lib/db/schema";
import { EMPTY_SIGNALS } from "../src/lib/ai/scoring/signals";
import { computeBand } from "../src/lib/ai/scoring/computeBand";
import { applyPostCall, preparePostCall } from "../src/lib/ai-dialer/postCallOutcome";
import {
    getCallbackLoopSettings,
    noteNeodoveCallForCallback,
    resolveComplaint,
    runCallbackLoopTick,
    setCallbackLoopSettings,
} from "../src/lib/ai-dialer/callbackLoop";
import { createCampaign } from "../src/lib/queue/campaignTracker";
import { fetchAssignedByForLeads } from "../src/lib/leads/leadAssignedBy";

if (process.env.AGENTMAIL_API_KEY || process.env.SMTP_HOST) throw new Error("refusing: email is configured");
const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};
const q = async <T>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];

const tag = `e2ed8${Date.now().toString(36)}`;
const uniq = String(Date.now()).slice(-5);
const LEADS = {
    cb: { id: `${tag}_cb`, phone: `+91910${uniq}01`, shop_name: "E2E D8 Lead-acid Battery House", city: "Patna" },
    complaint: { id: `${tag}_cmp`, phone: `+91910${uniq}02`, shop_name: "E2E D8 Complaint", city: "Patna" },
    qualified: { id: `${tag}_q`, phone: `+91910${uniq}03`, shop_name: "E2E D8 Qualified", city: "Patna" },
};
const campaigns: string[] = [];
let savedSetting: unknown = undefined;

function analysisFor(over: Partial<typeof EMPTY_SIGNALS>) {
    const signals = { ...EMPTY_SIGNALS, ...over };
    const band = computeBand(signals);
    return {
        band: band.band,
        call_status: band.call_status,
        info_signals_count: band.info_signals_count,
        callback_time: null,
        intent_score: band.lead_score,
        signals,
    };
}

async function finishCall(leadId: string, over: Partial<typeof EMPTY_SIGNALS>, transcript: string) {
    const analysis = analysisFor(over);
    const callEnd = { status: "completed" as const, outcome: null };
    const plan = await preparePostCall({ callEnd, analysis: analysis as never, transcript, leadId });
    await applyPostCall({
        provider: "elevenlabs",
        callId: `${tag}_${leadId}_${Math.random().toString(36).slice(2, 6)}`,
        leadId,
        plan,
        callEnd,
        band: analysis.band,
        intentScore: analysis.intent_score,
        summary: "E2E test call.",
        transcript,
        campaign: null,
    });
    return { plan, band: analysis.band };
}

const callbackOf = async (leadId: string) =>
    (
        await q<{
            id: string;
            status: string;
            kind: string;
            due_at: string;
            assigned_user_id: string | null;
            brief: Record<string, unknown> | null;
            reminded_at: string | null;
            escalated_at: string | null;
            push_attempts: number;
        }>(sql`
            SELECT id, status, kind, due_at::text AS due_at, assigned_user_id, brief, reminded_at::text AS reminded_at,
                   escalated_at::text AS escalated_at, push_attempts
              FROM lead_callbacks WHERE lead_id = ${leadId} ORDER BY created_at DESC LIMIT 1`)
    )[0];
const bells = async (leadId: string, type: string) =>
    (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE lead_id = ${leadId} AND type = ${type}`))[0].n;

async function main() {
    const isr = (
        await q<{ id: string; name: string }>(sql`
            SELECT id::text AS id, name FROM users WHERE role = 'inside_sales_rep' AND is_active IS NOT FALSE ORDER BY name LIMIT 1`)
    )[0];
    if (!isr) throw new Error("no active inside_sales_rep on sandbox");
    console.log(`ISR for the test: ${isr.name}`);

    savedSetting = (await q<{ value: unknown }>(sql`SELECT value FROM app_settings WHERE key = 'callback_loop'`))[0]?.value;
    await setCallbackLoopSettings({ ownerIds: [isr.id], neodovePush: false, updatedBy: isr.id });

    await db.insert(dealerLeads).values(Object.values(LEADS).map((l) => ({ ...l, dealer_name: l.shop_name })));

    // ── 1. A lead-acid e-rickshaw dealer agrees "kal shaam" (D10 + D8). ──
    const t1 = [
        "agent: नमस्ते sir, Priya iTarang से। क्या आप lithium battery dealer हैं?",
        "user: नहीं, e-rickshaw की lead-acid बेचते हैं। rate क्या है? EMI मिलेगा?",
        "agent: हमारे sales manager आपको call करें?",
        "user: हाँ, कल शाम को कर लेना।",
    ].join("\n");
    const r1 = await finishCall(
        LEADS.cb.id,
        {
            lithium_dealer: "no",
            relevant_dealer: "yes",
            product_lines: ["three_wheeler"],
            callback_agreed: "yes",
            callback_when: "kal shaam",
            evidence: { ...EMPTY_SIGNALS.evidence, volume_shared: "" },
        },
        t1,
    );
    check("D10: lead-acid in our lines is Warm", r1.band === "Warm", String(r1.band));
    const lead1 = (
        await q<{ owner: string | null; reason: string | null; status: string | null; follow: string | null }>(sql`
            SELECT current_owner_id AS owner, sales_ready_reason AS reason, lead_status AS status,
                   next_follow_up_at::text AS follow FROM dealer_leads WHERE id = ${LEADS.cb.id}`)
    )[0];
    const cb1 = await callbackOf(LEADS.cb.id);
    check("assigned to the ISR at once", lead1.owner === isr.id, String(lead1.owner));
    check("sales-ready reason is the AI callback", lead1.reason === "ai_callback", String(lead1.reason));
    check("lead lifted into the ISR's queue", lead1.status === "Assigned_Not_Contacted", String(lead1.status));
    check("callback assigned + brief saved", cb1?.assigned_user_id === isr.id && !!cb1?.brief, JSON.stringify(cb1?.brief)?.slice(0, 80));
    const dueIst = new Date(new Date(cb1.due_at).getTime() + 330 * 60_000).toISOString().slice(11, 16);
    check("'kal shaam' is due at 17:00", dueIst === "17:00", dueIst);
    check("next_follow_up_at = the promised time", new Date(lead1.follow!).getTime() === new Date(cb1.due_at).getTime());
    check("ISR got the assignment bell", (await bells(LEADS.cb.id, "lead.callback_assigned")) === 1);
    const sentBy = (await fetchAssignedByForLeads([LEADS.cb.id]))[LEADS.cb.id];
    check("'sent by' reads AI call", sentBy?.name === "AI call", JSON.stringify(sentBy));
    const brief = cb1.brief as { openQuestions?: string[]; productLines?: string[] };
    check("brief: lines + open questions", brief.productLines?.[0] === "E-rickshaw / e-auto" && (brief.openQuestions ?? []).includes("Price"), JSON.stringify(brief));

    // ── 2. The tick: reminder 15 min before, escalation 30 min after. ──
    const due = new Date(cb1.due_at).getTime();
    const early = await runCallbackLoopTick(new Date(due - 20 * 60_000));
    check("no reminder 20 min before", (await callbackOf(LEADS.cb.id)).reminded_at === null, JSON.stringify(early));
    await runCallbackLoopTick(new Date(due - 10 * 60_000));
    check("reminder sent 10 min before (push switch off)", (await bells(LEADS.cb.id, "lead.callback_reminder")) === 1);
    await runCallbackLoopTick(new Date(due - 5 * 60_000));
    check("…and only once", (await bells(LEADS.cb.id, "lead.callback_reminder")) === 1);
    await runCallbackLoopTick(new Date(due + 31 * 60_000));
    check("escalated 31 min overdue", !!(await callbackOf(LEADS.cb.id)).escalated_at && (await bells(LEADS.cb.id, "lead.callback_overdue")) >= 1);

    // ── 3. NeoDove: not connected ×3 → Not reached, owner kept, follow-up. ──
    await noteNeodoveCallForCallback({ leadId: LEADS.cb.id, connected: false, callBackAsked: false });
    let c = await callbackOf(LEADS.cb.id);
    check("1st unconnected: re-armed 2 h later", c.status === "open" && c.push_attempts === 1 && c.reminded_at === null && Math.abs(new Date(c.due_at).getTime() - (Date.now() + 2 * 3600_000)) < 120_000);
    await noteNeodoveCallForCallback({ leadId: LEADS.cb.id, connected: false, callBackAsked: false });
    await noteNeodoveCallForCallback({ leadId: LEADS.cb.id, connected: false, callBackAsked: false });
    c = await callbackOf(LEADS.cb.id);
    const after = (await q<{ owner: string | null; follow: string | null }>(sql`
        SELECT current_owner_id AS owner, next_follow_up_at::text AS follow FROM dealer_leads WHERE id = ${LEADS.cb.id}`))[0];
    check("3rd: closed as Not reached", c.status === "expired" && c.push_attempts === 3, `${c.status}/${c.push_attempts}`);
    check("owner kept, follow-up days out", after.owner === isr.id && new Date(after.follow!).getTime() > Date.now() + 2 * 86400_000);

    // ── 4. A new callback; a connected NeoDove call closes it. ──
    await finishCall(LEADS.cb.id, { lithium_dealer: "no", relevant_dealer: "yes", callback_agreed: "yes", callback_when: "kal" }, t1);
    check("new callback opens, same owner", (await callbackOf(LEADS.cb.id)).status === "open");
    await noteNeodoveCallForCallback({ leadId: LEADS.cb.id, connected: true, callBackAsked: false });
    check("connected NeoDove call closes it", (await callbackOf(LEADS.cb.id)).status === "done");

    // ── 5. A complaint: labelled, not closed by a call, resolved by hand. ──
    await finishCall(
        LEADS.complaint.id,
        { callback_topic: "complaint" },
        "agent: नमस्ते sir\nuser: आपकी battery दो महीने में ख़राब हो गई, कोई देखने नहीं आया।",
    );
    let cc = await callbackOf(LEADS.complaint.id);
    check("complaint → kind complaint, assigned", cc?.kind === "complaint" && cc.assigned_user_id === isr.id, JSON.stringify(cc));
    check("complaint brief: do not pitch", String((cc.brief as { purpose?: string })?.purpose).startsWith("Do not pitch"));
    await noteNeodoveCallForCallback({ leadId: LEADS.complaint.id, connected: true, callBackAsked: false });
    cc = await callbackOf(LEADS.complaint.id);
    check("a connected call does not close a complaint", cc.status === "open");
    const c1 = await createCampaign({ queueIds: [LEADS.complaint.id, LEADS.qualified.id], provider: "elevenlabs", status: "draft", name: `E2E D8 ${tag}` });
    if (c1.campaignId) campaigns.push(c1.campaignId);
    check("AI does not enrol a lead with an open complaint", c1.skippedAtEnrol.open_callback === 1, JSON.stringify(c1.skippedAtEnrol));
    check("resolve closes the complaint", await resolveComplaint(LEADS.complaint.id, isr.id, "Fixed by service."));

    // ── 6. Qualified with no callback → assigned, next working morning. ──
    await finishCall(LEADS.qualified.id, { lithium_dealer: "yes", relevant_dealer: "yes", product_lines: ["two_wheeler"] }, "agent: lithium?\nuser: जी हाँ।");
    const cq = await callbackOf(LEADS.qualified.id);
    const qIst = cq ? new Date(new Date(cq.due_at).getTime() + 330 * 60_000).toISOString().slice(11, 16) : "";
    check("Qualified, no callback → kind qualified at 11:00", cq?.kind === "qualified" && qIst === "11:00", `${cq?.kind} ${qIst}`);
    const lq = (await q<{ reason: string | null; owner: string | null }>(sql`
        SELECT sales_ready_reason AS reason, current_owner_id AS owner FROM dealer_leads WHERE id = ${LEADS.qualified.id}`))[0];
    check("…sales-ready as AI-qualified, owned", lq.reason === "ai_qualified" && lq.owner === isr.id, JSON.stringify(lq));
}

async function cleanup() {
    const ids = Object.values(LEADS).map((l) => l.id);
    const del = async (s: ReturnType<typeof sql>) => db.execute(s).catch((e) => console.error("cleanup:", e.message));
    for (const id of campaigns) {
        await del(sql`DELETE FROM dialer_campaign_leads WHERE campaign_id = ${id}`);
        await del(sql`DELETE FROM dialer_campaigns WHERE id = ${id}`);
    }
    const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    await del(sql`DELETE FROM notifications WHERE lead_id IN (${list})`);
    await del(sql`DELETE FROM lead_callbacks WHERE lead_id IN (${list})`);
    await del(sql`DELETE FROM ai_call_outcomes WHERE lead_id IN (${list})`);
    await del(sql`DELETE FROM dealer_lead_status_history WHERE dealer_lead_id IN (${list})`);
    await del(sql`DELETE FROM lead_touchpoints WHERE dealer_lead_id IN (${list})`);
    await del(sql`DELETE FROM lead_clocks WHERE dealer_lead_id IN (${list})`);
    await db.delete(dealerLeads).where(inArray(dealerLeads.id, ids)).catch((e) => console.error("cleanup lead:", e.message));
    if (savedSetting === undefined) await del(sql`DELETE FROM app_settings WHERE key = 'callback_loop'`);
    else await del(sql`UPDATE app_settings SET value = ${JSON.stringify(savedSetting)}::jsonb WHERE key = 'callback_loop'`);
    const left = (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM dealer_leads WHERE id IN (${list})`))[0].n;
    console.log(`\ncleaned up (test leads left: ${left}; callback_loop setting ${savedSetting === undefined ? "removed" : "restored"})`);
    void eq;
    void getCallbackLoopSettings;
}

main()
    .catch((e) => {
        failed++;
        console.error("threw:", e);
    })
    .finally(async () => {
        await cleanup().catch((e) => console.error("cleanup failed:", e));
        console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`}`);
        process.exit(failed === 0 ? 0 : 1);
    });
