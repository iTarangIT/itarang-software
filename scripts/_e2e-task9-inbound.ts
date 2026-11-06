// One-off end-to-end test of Priya KPI task 9 (inbound on the Vobiz number,
// E-376) against SANDBOX. Calls the real route handler and the real webhook
// handler with synthetic ElevenLabs payloads — no phone rings, no provider is
// called. Creates one throwaway lead; deletes everything it created.
//
//   AGENTMAIL_API_KEY= SMTP_HOST= ELEVENLABS_INIT_WEBHOOK_SECRET=e2e-secret \
//     node --import tsx --env-file=.env.local scripts/_e2e-task9-inbound.ts
import { sql, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { dealerLeads, dialerCampaignLeads } from "../src/lib/db/schema";
import { POST as initRoute } from "../src/app/api/elevenlabs/inbound-init/route";
import { handleElevenLabsWebhook } from "../src/lib/ai/elevenlabs/webhookHandler";
import { sweepMissedInbound } from "../src/lib/ai-dialer/inbound";

if (process.env.ELEVENLABS_INIT_WEBHOOK_SECRET !== "e2e-secret") throw new Error("refusing: set ELEVENLABS_INIT_WEBHOOK_SECRET=e2e-secret");
if (process.env.AGENTMAIL_API_KEY || process.env.SMTP_HOST) throw new Error("refusing: email is configured");
const host = new URL(process.env.DATABASE_URL!).host;
if (!host.startsWith("database-1.")) throw new Error(`refusing: not sandbox (${host.split(".")[0]})`);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};
const rowsOf = <T,>(r: unknown) => (Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []));
const tag = `e2et9${Date.now().toString(36)}`;
const leadId = `${tag}_lead`;
const tenDigits = `98${String(Date.now()).slice(-8)}`;
const phone = `+91${tenDigits}`;
const unknownPhone = `+9197${String(Date.now()).slice(-8)}`;
const conv1 = `conv_${tag}_answered`;
const conv2 = `conv_${tag}_missed`;

const init = (secret: string | null, caller: string, callSid: string) =>
    initRoute(
        new Request("http://localhost/api/elevenlabs/inbound-init", {
            method: "POST",
            headers: { "content-type": "application/json", ...(secret ? { "x-itarang-secret": secret } : {}) },
            body: JSON.stringify({ caller_id: caller, agent_id: "agent_x", called_number: "+918035315136", call_sid: callSid }),
        }),
    );
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    await db.insert(dealerLeads).values({
        id: leadId,
        dealer_name: "E2E T9 Ramesh",
        shop_name: "E2E T9 Batteries",
        phone,
        city: "Testpur",
        state: "Test",
    });
    // Priya spoke to him yesterday; nothing booked.
    await db.execute(sql`
        INSERT INTO ai_dial_dispositions (dial_key, lead_id, phone_key, direction, l1, l2, l3, rule_no, rules_version, dialled_at)
        VALUES (${`conv_${tag}_prior`}, ${leadId}, ${tenDigits}, 'outbound', 'Connected', 'Cold', 'Need Some Time', '20', 'e2e', now() - interval '1 day')
    `);
    const queuedBefore = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM dialer_campaign_leads WHERE lead_id = ${leadId}`))[0].n;

    console.log("1. the init webhook");
    const saved = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    check("no secret on the server → 503 (fails closed)", (await init("x", phone, "s0")).status === 503);
    process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = saved;
    check("wrong secret → 401", (await init("nope", phone, "s0")).status === 401);
    check("no secret header → 401", (await init(null, phone, "s0")).status === 401);
    const r = await init("e2e-secret", `0${tenDigits}`, `${tag}_sid1`);
    const body = (await r.json()) as { type: string; dynamic_variables: Record<string, string> };
    check("known caller (dialled as 0XXXXXXXXXX) → 200 with context", r.status === 200 && body.type === "conversation_initiation_client_data", String(r.status));
    check("branch do_it_now (spoke to Priya, nothing booked)", body.dynamic_variables?.inbound_branch === "do_it_now", JSON.stringify(body.dynamic_variables));
    check("shop name and last outcome, no owner_name", body.dynamic_variables?.shop_name === "E2E T9 Batteries" && body.dynamic_variables?.last_outcome === "Need Some Time" && body.dynamic_variables?.owner_name === "", JSON.stringify(body.dynamic_variables));
    const u = await init("e2e-secret", unknownPhone, `${tag}_sid_unknown`);
    check("unknown caller → branch unknown", ((await u.json()) as any).dynamic_variables?.inbound_branch === "unknown");
    await wait(500);
    const logged = rowsOf<{ lead_id: string | null; branch: string }>(
        await db.execute(sql`SELECT lead_id, branch FROM inbound_calls WHERE call_sid = ${`${tag}_sid1`}`),
    );
    check("the init is logged on inbound_calls with the lead", logged[0]?.lead_id === leadId && logged[0]?.branch === "do_it_now", JSON.stringify(logged));

    console.log("2. an answered inbound where he agrees a time");
    await handleElevenLabsWebhook({
        type: "post_call_transcription",
        data: {
            conversation_id: conv1,
            agent_id: "agent_x",
            status: "done",
            transcript: [
                { role: "agent", message: "नमस्ते, iTarang से Priya — आपने call किया था?" },
                { role: "user", message: "हाँ, rate जानना था, कल शाम 5 बजे call कर लेना" },
                { role: "agent", message: "ठीक है, Nidhi जी कल शाम 5 बजे call करेंगी।" },
            ],
            metadata: { phone_call: { direction: "inbound", external_number: phone, call_sid: `${tag}_sid1` }, call_duration_secs: 42, termination_reason: "end_call tool was called." },
            analysis: {
                transcript_summary: "Dealer wants the rate; callback tomorrow 5 pm.",
                data_collection_results: {
                    answered_by: { value: "owner" },
                    call_result: { value: "callback_booked" },
                    callback_agreed: { value: true },
                    callback_time: { value: "कल शाम 5 बजे (tomorrow 5 pm)" },
                },
            },
        },
    } as any);
    const ic = rowsOf<Record<string, any>>(await db.execute(sql`SELECT * FROM inbound_calls WHERE call_sid = ${`${tag}_sid1`}`))[0];
    check("inbound row handled, answered, conversation attached", ic?.handled_at != null && ic?.answered === true && ic?.conversation_id === conv1, JSON.stringify(ic));
    const cb = rowsOf<Record<string, any>>(await db.execute(sql`SELECT * FROM lead_callbacks WHERE lead_id = ${leadId} AND status = 'open'`))[0];
    const dueIst = cb ? new Date(new Date(cb.due_at).getTime() + 330 * 60_000) : null;
    check("an open callback for tomorrow 17:00 IST, time set", !!cb && dueIst?.getUTCHours() === 17 && cb.time_not_set === false, JSON.stringify({ due: cb?.due_at, tns: cb?.time_not_set }));
    check("the callback has a person (owner set at once)", !!cb?.assigned_user_id, String(cb?.assigned_user_id));
    check("the inbound is noted on the callback", Array.isArray(cb?.brief?.inbound) && cb.brief.inbound.length === 1, JSON.stringify(cb?.brief?.inbound));
    const log = rowsOf<{ call_status: string }>(await db.execute(sql`SELECT call_status FROM ai_call_logs WHERE call_id = ${conv1}`))[0];
    check("the call is in the lead's call log as inbound", log?.call_status === "inbound", JSON.stringify(log));
    const disp = rowsOf<{ direction: string; l3: string }>(await db.execute(sql`SELECT direction, l3 FROM ai_dial_dispositions WHERE dial_key = ${conv1}`))[0];
    check("a v3 disposition, direction inbound", disp?.direction === "inbound" && disp?.l3 === "Information Collected", JSON.stringify(disp));
    const tp = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM lead_touchpoints WHERE dealer_lead_id = ${leadId} AND external_event_id = ${conv1}`))[0].n;
    check("a touchpoint on the lead", tp === 1, String(tp));
    const queuedAfter = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM dialer_campaign_leads WHERE lead_id = ${leadId}`))[0].n;
    check("no campaign row touched", queuedAfter === queuedBefore, `${queuedBefore} → ${queuedAfter}`);
    await handleElevenLabsWebhook({ type: "post_call_transcription", data: { conversation_id: conv1, status: "done", metadata: { phone_call: { direction: "inbound", external_number: phone, call_sid: `${tag}_sid1` } } } } as any);
    const cbs = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM lead_callbacks WHERE lead_id = ${leadId}`))[0].n;
    check("a re-delivered webhook changes nothing", cbs === 1, String(cbs));

    console.log("3. he rings again and nobody answers");
    await init("e2e-secret", phone, `${tag}_sid2`);
    await wait(500);
    // Age the init past the 3-minute mark, then run the sweep.
    await db.execute(sql`UPDATE inbound_calls SET created_at = now() - interval '4 minutes' WHERE call_sid = ${`${tag}_sid2`}`);
    const sweepAt = Date.now();
    const swept = await sweepMissedInbound();
    const miss = rowsOf<Record<string, any>>(await db.execute(sql`SELECT * FROM inbound_calls WHERE call_sid = ${`${tag}_sid2`}`))[0];
    check("the sweep found the unanswered call", swept >= 1 && miss?.answered === false && miss?.return_due_at != null, JSON.stringify({ swept, a: miss?.answered, r: miss?.return_due_at }));
    const cb2 = rowsOf<Record<string, any>>(await db.execute(sql`SELECT * FROM lead_callbacks WHERE lead_id = ${leadId} AND status = 'open'`));
    const mins = cb2[0] ? (new Date(cb2[0].due_at).getTime() - Date.now()) / 60_000 : -1;
    check("it lands on the SAME callback task, due within 10 minutes", cb2.length === 1 && cb2[0].id === cb.id && mins > 0 && mins <= 10.5, JSON.stringify({ n: cb2.length, mins }));
    // Re-armed: cleared by the sweep. A live callback-loop tick on the sandbox
    // server may already have re-sent the reminder (due in 10 min is inside
    // the 15-min reminder window) — that stamp is after the sweep.
    const remindedAt = cb2[0]?.reminded_at ? new Date(cb2[0].reminded_at).getTime() : null;
    check(
        "the reminder and escalation are re-armed",
        (remindedAt == null || remindedAt >= sweepAt - 1000) && cb2[0]?.escalated_at == null,
        JSON.stringify({ r: cb2[0]?.reminded_at, e: cb2[0]?.escalated_at }),
    );
    check("both inbounds are on the callback", cb2[0]?.brief?.inbound?.length === 2, JSON.stringify(cb2[0]?.brief?.inbound?.length));
    void conv2;
}

async function cleanup() {
    const t = (q: ReturnType<typeof sql>) => db.execute(q).catch((e) => console.warn("cleanup:", e.message));
    await t(sql`DELETE FROM notifications WHERE data->>'callbackId' IN (SELECT id FROM lead_callbacks WHERE lead_id = ${leadId})`);
    await t(sql`DELETE FROM notifications WHERE lead_id = ${leadId}`);
    await t(sql`DELETE FROM notifications WHERE data->>'phone' = ${unknownPhone}`);
    await t(sql`DELETE FROM inbound_calls WHERE call_sid LIKE ${tag + "%"} OR lead_id = ${leadId}`);
    await t(sql`DELETE FROM lead_callbacks WHERE lead_id = ${leadId}`);
    await t(sql`DELETE FROM lead_route_log WHERE lead_id = ${leadId}`);
    await t(sql`DELETE FROM ai_dial_dispositions WHERE lead_id = ${leadId} OR dial_key LIKE ${"%" + tag + "%"}`);
    await t(sql`DELETE FROM dialer_number_stats WHERE phone_key = ${tenDigits}`);
    await t(sql`DELETE FROM ai_call_logs WHERE call_id LIKE ${"%" + tag + "%"}`);
    await t(sql`DELETE FROM lead_touchpoints WHERE dealer_lead_id = ${leadId}`);
    await t(sql`DELETE FROM dealer_lead_phone_type WHERE lead_id = ${leadId}`);
    await db.delete(dialerCampaignLeads).where(eq(dialerCampaignLeads.lead_id, leadId)).catch(() => {});
    await db.delete(dealerLeads).where(eq(dealerLeads.id, leadId)).catch((e) => console.warn("lead not deleted:", e.message));
    console.log("\ncleaned up test lead, callbacks, inbound rows, logs");
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
