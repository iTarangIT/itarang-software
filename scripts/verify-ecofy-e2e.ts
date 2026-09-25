// Ecofy × CRM end-to-end probe / driver (E-307).
//
//   node --import tsx --env-file=.env.local scripts/verify-ecofy-e2e.ts
//       → read-only: every open CRM lead vs Ecofy (stage, version, assignee,
//         last outbound calls and their errors, pending local activities).
//
//   node --import tsx --env-file=.env.local scripts/verify-ecofy-e2e.ts --drive --lead <ecofy_leads.id>
//       → S1 → S4 through the REAL helpers the UI uses (pushAssignmentToEcofy,
//         runEcofyAction): assign signal, call, EPC/site visit booked + completed,
//         advance, manual assessment, confirm, send for eligibility. Stops there:
//         Ecofy Admin must record ELIGIBLE in Ecofy › Eligibility queue.
//   … --continue --lead <id> [--epc <epcPartnerId>]
//       → quote request, EPC quote PDF (generated), compose offer, send OTP (S5).
//         Prints where the OTP landed (dev SMS file on the Ecofy host).
//   … --verify-otp <6 digits> --lead <id>
//       → verify → File locked (S6).
//
// Writes only in --drive / --continue / --verify-otp, only against the Ecofy
// SANDBOX host, and only on the one lead you name. Uses the CRM's own helpers,
// so a green run here means the buttons work too.

import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { ecofyLeads, ecofySyncEvents } from "@/lib/db/schema";
import { ECOFY_OUTBOUND_ACTOR } from "@/lib/ecofy/access";
import { pushAssignmentToEcofy } from "@/lib/ecofy/assignment";
import { getEcofyConfig } from "@/lib/ecofy/config";
import { readLeadData, readLookup, refreshLeadFromEcofy, runEcofyAction, uploadQuote } from "@/lib/ecofy/service";
import type { EcofyActionInput } from "@/lib/ecofy/actionSchemas";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const arg = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
};

let failures = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
    failures += 1;
    console.log(`  ✗ ${m}`);
};
const info = (m: string) => console.log(`  · ${m}`);

type LeadRow = typeof ecofyLeads.$inferSelect;

async function loadLead(id: string): Promise<LeadRow> {
    const [row] = await db.select().from(ecofyLeads).where(eq(ecofyLeads.id, id)).limit(1);
    if (!row) throw new Error(`No ecofy_leads row ${id}`);
    return row;
}

async function caseView(lead: LeadRow): Promise<{ stage: string | null; subStatus: string | null; version: number }> {
    const k = (await readLeadData(lead.ecofy_case_id, "case")) as { stage?: string; subStatus?: string; version?: number };
    return { stage: k.stage ?? null, subStatus: k.subStatus ?? null, version: k.version ?? 0 };
}

async function expectStage(lead: LeadRow, want: string, after: string) {
    await refreshLeadFromEcofy(lead);
    const k = await caseView(lead);
    k.stage === want ? ok(`${after}: Ecofy stage ${k.stage} (v${k.version})`) : bad(`${after}: Ecofy stage ${k.stage}, expected ${want}`);
    return k;
}

async function act(lead: LeadRow, input: EcofyActionInput, label: string): Promise<unknown> {
    try {
        const r = await runEcofyAction(lead, input, ECOFY_OUTBOUND_ACTOR);
        ok(label);
        return r;
    } catch (err) {
        bad(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

async function report() {
    console.log("CRM ↔ Ecofy state");
    const leads = await db
        .select()
        .from(ecofyLeads)
        .where(sql`${ecofyLeads.stage} IS NULL OR ${ecofyLeads.stage} NOT IN ('CLOSED')`)
        .orderBy(desc(ecofyLeads.updated_at))
        .limit(20);
    if (!leads.length) info("no open Ecofy leads in the CRM");
    for (const l of leads) {
        let remote = "unreachable";
        try {
            const k = await caseView(l);
            remote = `${k.stage}${k.subStatus ? `/${k.subStatus}` : ""} v${k.version}`;
        } catch (err) {
            remote = `ERROR ${err instanceof Error ? err.message : String(err)}`;
        }
        console.log(`- ${l.id}  ${l.case_no ?? "?"}  ${l.customer_name ?? ""}`);
        info(`CRM: stage ${l.stage} v${l.version} ${l.temperature ?? ""}  assignee ${l.assigned_to_user_id ?? "—"}   Ecofy: ${remote}`);
        const events = await db
            .select({
                type: ecofySyncEvents.event_type,
                status: ecofySyncEvents.http_status,
                error: ecofySyncEvents.error,
                at: ecofySyncEvents.updated_at,
            })
            .from(ecofySyncEvents)
            .where(and(eq(ecofySyncEvents.direction, "outbound"), eq(ecofySyncEvents.ecofy_case_id, l.ecofy_case_id)))
            .orderBy(desc(ecofySyncEvents.updated_at))
            .limit(5);
        for (const e of events) info(`  ${e.at?.toISOString() ?? ""}  ${e.type}  → ${e.status ?? "—"} ${e.error ?? ""}`);
        const pending = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM ecofy_lead_activities WHERE ecofy_lead_id = ${l.id}::uuid AND sync_status = 'pending'
        `);
        if (pending[0]?.n) info(`  ${pending[0].n} local activit(y/ies) waiting for Ecofy`);
    }
    const bad401 = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ecofy_sync_events
        WHERE direction = 'outbound' AND http_status IN (401, 403) AND updated_at > now() - interval '1 hour'
    `);
    bad401[0].n === 0
        ? ok("no act-as refusals (401/403) from Ecofy in the last hour")
        : bad(`${bad401[0].n} act-as refusal(s) in the last hour — integration user still not ACTIVE iTarang Admin in Ecofy?`);
}

function assertSandbox() {
    const { apiBase } = getEcofyConfig();
    if (!apiBase || !/sandbox-ecofy\.itarang\.com/.test(apiBase)) {
        throw new Error(`Refusing to drive: ECOFY_API_BASE is ${apiBase ?? "unset"}, not the sandbox`);
    }
}

async function firstEpcPartnerId(): Promise<string> {
    const explicit = arg("--epc");
    if (explicit) return explicit;
    const partners = (await readLookup("epc-partners")) as { items?: Array<{ id: string; name?: string }> } | Array<{ id: string; name?: string }>;
    const list = Array.isArray(partners) ? partners : (partners.items ?? []);
    if (!list.length) throw new Error("No EPC partner in Ecofy — add one in Ecofy › Settings & masters, or pass --epc <id>");
    info(`EPC partner: ${list[0].name ?? list[0].id}`);
    return list[0].id;
}

function isoIn(minutes: number) {
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function drive(lead: LeadRow) {
    assertSandbox();
    console.log(`Drive S1 → S4 on ${lead.case_no ?? lead.id}`);
    let k = await caseView(lead);
    info(`Ecofy stage now ${k.stage} v${k.version}`);

    if (k.stage === "S1") {
        const pushed = await pushAssignmentToEcofy(lead, "e2e probe");
        pushed.ok ? ok("lead.assigned accepted") : bad(`lead.assigned refused: ${pushed.reason}`);
        k = await expectStage(lead, "S2", "after lead.assigned");
    }
    if (k.stage !== "S2") {
        info(`stage is ${k.stage}; S2 steps skipped`);
    } else {
        await act(lead, { action: "log_activity", type: "CALL", callOutcome: "CONNECTED", note: "e2e: customer reached" }, "call logged");
        const epc = await firstEpcPartnerId();
        const appt = (await act(
            lead,
            { action: "book_appointment", meetingType: "EPC_VISIT", scheduledAt: isoIn(-60), bookingRemarks: "e2e visit", epcPartnerId: epc },
            "EPC visit booked",
        )) as { id?: string };
        if (!appt?.id) throw new Error("appointment id missing in Ecofy reply");
        await act(
            lead,
            { action: "update_appointment", appointmentId: appt.id, op: "COMPLETE", actualAt: isoIn(-30), meetingRemarks: "e2e: site seen", epcFeedback: "roof ok" },
            "EPC visit completed",
        );
        k = await caseView(lead);
        await act(lead, { action: "advance", version: k.version }, "advance S2 → S3");
        k = await expectStage(lead, "S3", "after advance");
    }
    if (k.stage === "S3") {
        const a = (await act(
            lead,
            { action: "save_assessment", method: "MANUAL", batteryKwh: 5, inverterKva: 5, solarKwp: 3, sourceNote: "e2e manual sizing" },
            "manual assessment saved",
        )) as { id?: string };
        if (!a?.id) throw new Error("assessment id missing in Ecofy reply");
        k = await caseView(lead);
        await act(lead, { action: "confirm_assessment", version: k.version, assessmentId: a.id }, "assessment confirmed");
        k = await expectStage(lead, "S4", "after confirm");
    }
    if (k.stage === "S4") {
        await act(lead, { action: "request_eligibility" }, "sent for eligibility");
        console.log("\nNEXT (Ecofy Admin, sandbox-ecofy): Eligibility queue › this case › ELIGIBLE with a max amount.");
        console.log(`Then: node --import tsx --env-file=.env.local scripts/verify-ecofy-e2e.ts --continue --lead ${lead.id}`);
    }
}

function tinyPdf(text: string): Buffer {
    // Minimal valid single-page PDF; enough for Ecofy's PDF check and a human to open.
    const content = `BT /F1 14 Tf 40 750 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
}

async function cont(lead: LeadRow) {
    assertSandbox();
    console.log(`Continue S4 → S5 on ${lead.case_no ?? lead.id}`);
    let k = await caseView(lead);
    if (k.stage !== "S4") {
        bad(`stage is ${k.stage}, expected S4`);
        return;
    }
    const assessments = (await readLeadData(lead.ecofy_case_id, "assessments")) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
    const aList = Array.isArray(assessments) ? assessments : (assessments.items ?? []);
    const assessmentId = aList[0]?.id;
    if (!assessmentId) throw new Error("no assessment on the case");
    const epc = await firstEpcPartnerId();
    await act(lead, { action: "quote_request", epcPartnerId: epc, channel: "EMAIL" }, "quote request logged");
    const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    try {
        await uploadQuote(
            lead,
            { bytes: tinyPdf(`EPC quote e2e ${lead.case_no ?? ""}`), fileName: "e2e-quote.pdf", mimeType: "application/pdf", typeCode: "EPC_QUOTE" },
            { assessmentId, epcPartnerId: epc, systemDesc: "3 kWp solar + 5 kWh battery", batteryKwh: 5, inverterKva: 5, solarKwp: 3, equipmentInr: 210000, installationInr: 15000, gstInr: 27000, validUntil, notes: "e2e" },
            ECOFY_OUTBOUND_ACTOR,
            randomUUID(),
        );
        ok("EPC quote uploaded");
    } catch (err) {
        bad(`quote upload: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    const quotes = (await readLeadData(lead.ecofy_case_id, "quotes")) as { items?: Array<{ id: string; status?: string }> } | Array<{ id: string; status?: string }>;
    const qList = Array.isArray(quotes) ? quotes : (quotes.items ?? []);
    const active = qList.find((q) => q.status === "ACTIVE") ?? qList[0];
    if (!active) throw new Error("no quote on the case after upload");
    // Offer (OpenAPI `Offer`): id, version, status, limitCheck WITHIN|ABOVE|UNKNOWN — never an amount.
    const offer = (await act(lead, { action: "compose_offer", quoteId: active.id, idempotencyKey: randomUUID() }, "offer composed")) as {
        id?: string;
        limitCheck?: "WITHIN" | "ABOVE" | "UNKNOWN";
    };
    if (!offer?.id) throw new Error("offer id missing in Ecofy reply");
    info(`limit check: ${offer.limitCheck ?? "(not reported)"} (the CRM never sees the amount)`);
    k = await caseView(lead);
    // OpenAPI `OtpChallenge`: challengeId, expiresAt, resendAfterSeconds, maskedMobile.
    const otp = (await act(lead, { action: "send_otp", version: k.version, offerId: offer.id, idempotencyKey: randomUUID() }, "OTP sent")) as {
        challengeId?: string;
        maskedMobile?: string;
    };
    await expectStage(lead, "S5", "after send_otp");
    console.log(`\nNEXT: on the Ecofy host, as deploy:  cat /srv/ecofy/shared/data/sms/$(ls -t /srv/ecofy/shared/data/sms | head -1)   (sent to ${otp?.maskedMobile ?? "?"})`);
    console.log(`Then: node --import tsx --env-file=.env.local scripts/verify-ecofy-e2e.ts --verify-otp <code> --challenge ${otp?.challengeId ?? "<challengeId>"} --lead ${lead.id}`);
}

async function verifyOtp(lead: LeadRow, code: string) {
    assertSandbox();
    // The challenge id is only returned by send_otp (printed by --continue); Ecofy stores the code hashed.
    const challengeId = arg("--challenge");
    if (!challengeId) throw new Error("--challenge <challengeId from the --continue run> is required");
    if (!/^\d{6}$/.test(code)) throw new Error("--verify-otp needs the 6-digit code from the dev SMS file");
    await act(lead, { action: "verify_otp", challengeId, code }, "OTP verified");
    await expectStage(lead, "S6", "after verify (File locked)");
    console.log("\nNEXT (Ecofy Admin): Financing queue › Sanction → S7; then installation from the CRM; then down payment + disbursement → S8.");
}

async function main() {
    const leadId = arg("--lead");
    if (flag("--drive") || flag("--continue") || flag("--verify-otp")) {
        if (!leadId) throw new Error("--lead <ecofy_leads.id> is required");
        const lead = await loadLead(leadId);
        if (flag("--drive")) await drive(lead);
        else if (flag("--continue")) await cont(lead);
        else await verifyOtp(lead, arg("--verify-otp") ?? "");
    } else {
        await report();
    }
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
