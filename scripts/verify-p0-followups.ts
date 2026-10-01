/**
 * Verifier for the follow-up fixes of 01 Oct 2026 (evening) on tracker IDs
 * 57, 58, 60, 61, 78, 79 and 118 — the gaps the end-to-end pass over the
 * 19 P0 IDs found after the 30 Sep review items were closed.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-p0-followups.ts
 *
 * Runs the REAL writers and loaders inside ONE transaction that is ALWAYS
 * rolled back — nothing is left behind. For the length of the run every `db.*`
 * call in the process is routed into that transaction, which is what lets the
 * unmodified code be exercised on leads the script seeds for itself.
 *
 * Nothing here sends a notification, an email or a WhatsApp message: the quote
 * answer is checked through claimDealerAnswer (the write alone), not through
 * recordDealerDecision.
 *
 * Sandbox only: it refuses any host but database-1. Exit code 1 if anything FAILs.
 */
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { claimDealerAnswer, loadQuotationForDealer, staleQuoteReason } from "../src/lib/leads/quoteDecision";
import { CommercialInputError, createLeadCommercial } from "../src/lib/leads/createCommercial";
import { loadLatestQuote } from "../src/lib/assistant/tools/quotes";
import { logLeadTouchpoint } from "../src/lib/inside-sales/logTouchpoint";
import { CompetitorRequiredError, checkMarkLost, markLeadLost } from "../src/lib/leads/markLost";
import { logDataDownload } from "../src/lib/exports/downloadLog";
import { recordWhatsappContact } from "../src/lib/leads/whatsappContact";

const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
if (!host.startsWith("database-1.")) {
    console.error(`Refusing to run against ${host.split(".")[0]} — sandbox (database-1) only.`);
    process.exit(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = "PASS" | "FAIL" | "SKIP";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];
class Rollback extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

let tx!: Tx;
async function check(id: string, fn: () => Promise<string>) {
    // A savepoint per check: a failed statement must not abort the checks after it.
    try {
        let note = "";
        await tx.transaction(async () => {
            note = await fn();
        });
        results.push({ id, outcome: "PASS", note });
    } catch (e) {
        const cause = e instanceof Error && e.cause instanceof Error ? ` — ${e.cause.message}` : "";
        const msg = (e instanceof Error ? e.message : String(e)) + cause;
        results.push({ id, outcome: msg.startsWith("SKIP") ? "SKIP" : "FAIL", note: msg });
    }
}

type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];

async function seedLead(status = "Under_Discussion", ownerId: string | null = null): Promise<string> {
    const id = `DL-VFU-${Math.random().toString(36).slice(2, 10)}`;
    const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    await tx.execute(sql`
        INSERT INTO dealer_leads (id, phone, dealer_name, city, location, language, current_status, source,
                                  lead_status, current_owner_id, total_attempts, is_active, created_at, updated_at)
        VALUES (${id}, ${phone}, 'Verify Followups', 'Pune', 'Pune', 'hindi', 'new', 'manual_upload_lead',
                ${status}, ${ownerId}, 0, TRUE, NOW(), NOW())`);
    return id;
}

async function seedQuote(
    leadId: string,
    versionNo: number,
    over: { approval?: string; withdrawn?: boolean; dealerDecision?: string | null; price?: number; eventType?: string } = {},
): Promise<string> {
    const price = over.price ?? 50000;
    const [r] = await rows<{ commercial_id: string }>(sql`
        INSERT INTO dealer_lead_commercials
            (dealer_lead_id, version_no, is_current, event_type, price_quoted, final_price, created_by,
             approval_status, quote_number, quote_pdf_url, dealer_decision, withdrawn_at)
        VALUES (${leadId}, ${versionNo}, FALSE, ${over.eventType ?? (versionNo === 1 ? "quote_issue" : "quote_revision")},
                ${price}, ${price}, 'verify-p0-followups',
                ${over.approval ?? "approved"}, ${`VFU-${leadId.slice(-8)}-${versionNo}`}, 'https://example.invalid/q.pdf',
                ${over.dealerDecision ?? null}, ${over.withdrawn ? sql`NOW()` : sql`NULL`})
        RETURNING commercial_id::text AS commercial_id`);
    return r.commercial_id;
}

const answer = (commercialId: string) =>
    claimDealerAnswer({ commercialId, decision: "approved", via: "link", actor: "token", note: null });

async function anyUserId(role?: string): Promise<string> {
    const [u] = await rows<{ id: string }>(sql`
        SELECT id::text AS id FROM users
         WHERE is_active IS NOT FALSE ${role ? sql`AND role = ${role}` : sql``}
         ORDER BY created_at ASC LIMIT 1`);
    assert(u, `SKIP: no ${role ?? "active"} user on this database`);
    return u.id;
}

async function run() {
    // ── ID 60 ───────────────────────────────────────────────────────────────
    await check("ID 60 — the answer is refused IN THE WRITE when a newer approved version exists", async () => {
        const lead = await seedLead();
        const v1 = await seedQuote(lead, 1);
        const v2 = await seedQuote(lead, 2);
        assert((await answer(v1)) === false, "a yes on v1 was written although v2 is approved and live");
        assert((await answer(v2)) === true, "the current version v2 could not be answered");
        assert((await answer(v2)) === false, "v2 was answered twice");
        return "v1 refused by the UPDATE itself; v2 answered once";
    });

    await check("ID 60 — a revision still at the CEO, rejected or withdrawn does not block the live version", async () => {
        const notes: string[] = [];
        for (const newer of [{ approval: "pending" }, { approval: "rejected" }, { approval: "approved", withdrawn: true }]) {
            const lead = await seedLead();
            const v1 = await seedQuote(lead, 1);
            await seedQuote(lead, 2, newer);
            assert((await answer(v1)) === true, `v1 refused under a ${newer.withdrawn ? "withdrawn" : newer.approval} v2`);
            notes.push(newer.withdrawn ? "withdrawn" : newer.approval);
        }
        return `v1 answered under a v2 that is: ${notes.join(", ")}`;
    });

    await check("ID 60 — a withdrawn or unapproved version is never answered", async () => {
        const lead = await seedLead();
        const withdrawn = await seedQuote(lead, 1, { withdrawn: true });
        const pending = await seedQuote(lead, 2, { approval: "pending" });
        assert((await answer(withdrawn)) === false, "a withdrawn quote was answered");
        assert((await answer(pending)) === false, "a quote still at the CEO was answered");
        return "withdrawn and pending both refused";
    });

    await check("ID 60 — a withdrawn link still names the lead's live quote", async () => {
        const lead = await seedLead();
        const v1 = await seedQuote(lead, 1, { withdrawn: true });
        const v2 = await seedQuote(lead, 2);
        const row = await loadQuotationForDealer(v1);
        assert(row, "v1 not loaded");
        assert(staleQuoteReason(row) === "withdrawn", `expected withdrawn, got ${staleQuoteReason(row)}`);
        assert(row.latest_commercial_id === v2, "the withdrawn version does not point at the live v2");
        return "v1 withdrawn → page is handed v2";
    });

    await check("ID 60 / 78 — the Assistant picks the version by what it is doing", async () => {
        const lead = await seedLead();
        await seedQuote(lead, 1);
        await seedQuote(lead, 2, { approval: "pending" });
        await seedQuote(lead, 3, { approval: "rejected" });
        const [any, inPlay, live] = await Promise.all([
            loadLatestQuote(lead),
            loadLatestQuote(lead, "in_play"),
            loadLatestQuote(lead, "live"),
        ]);
        assert(any?.version_no === 3, `status reads v${any?.version_no}, expected v3`);
        assert(inPlay?.version_no === 2, `withdraw picks v${inPlay?.version_no}, expected v2`);
        assert(live?.version_no === 1, `send picks v${live?.version_no}, expected v1`);
        return "status → v3 (rejected), withdraw → v2 (at the CEO), send → v1 (approved)";
    });

    // ── ID 61 ───────────────────────────────────────────────────────────────
    await check("ID 61 — final terms with no dealer-approved quote are refused, not saved priceless", async () => {
        const lead = await seedLead("Commercials_Explained");
        await seedQuote(lead, 1);
        const actor = { id: await anyUserId(), name: "verify" };
        let refused = "";
        try {
            await createLeadCommercial({ leadId: lead, actor, body: { event_type: "final_terms", credit_terms: "30 days" } });
        } catch (e) {
            assert(e instanceof CommercialInputError, `unexpected error: ${e instanceof Error ? e.message : e}`);
            assert(e.status === 409, `expected 409, got ${e.status}`);
            refused = e.message;
        }
        assert(refused, "final terms were saved with no dealer-approved quote");
        const [n] = await rows<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM dealer_lead_commercials WHERE dealer_lead_id = ${lead} AND event_type = 'final_terms'`);
        assert(n.n === 0, "a final_terms row was written");
        return `refused 409: ${refused.slice(0, 60)}…`;
    });

    await check("ID 61 — final terms copy the dealer-approved quote's price, whatever the caller sends", async () => {
        const lead = await seedLead("Commercials_Finalised");
        await seedQuote(lead, 1, { price: 52000, dealerDecision: "approved" });
        const actor = { id: await anyUserId(), name: "verify" };
        const out = await createLeadCommercial({
            leadId: lead,
            actor,
            body: { event_type: "final_terms", final_price: 1, price_quoted: 1, credit_terms: "30 days" },
        });
        const [r] = await rows<{ final_price: string | null }>(sql`
            SELECT final_price::text AS final_price FROM dealer_lead_commercials WHERE commercial_id = ${out.commercialId}::uuid`);
        assert(Number(r.final_price) === 52000, `final price ${r.final_price}, expected 52000`);
        return "caller sent ₹1; the row carries ₹52,000 from the approved quote";
    });

    await check("ID 61 — a terms update never copies a rejected revision's price", async () => {
        const lead = await seedLead("Commercials_Explained");
        await seedQuote(lead, 1, { price: 50000 });
        await seedQuote(lead, 2, { price: 40000, approval: "rejected" });
        const actor = { id: await anyUserId(), name: "verify" };
        const out = await createLeadCommercial({ leadId: lead, actor, body: { event_type: "terms_update", delivery_terms: "7 days" } });
        const [r] = await rows<{ final_price: string | null }>(sql`
            SELECT final_price::text AS final_price FROM dealer_lead_commercials WHERE commercial_id = ${out.commercialId}::uuid`);
        assert(Number(r.final_price) === 50000, `terms row carries ${r.final_price}, expected v1's 50000`);
        return "terms row carries v1's ₹50,000, not the rejected v2's ₹40,000";
    });

    // ── ID 79 / 80 ──────────────────────────────────────────────────────────
    await check("ID 79 — a WhatsApp note logged through the touchpoint API is never engaged and moves nothing", async () => {
        const owner = await anyUserId();
        const lead = await seedLead("Assigned_Not_Contacted", owner);
        const res = await logLeadTouchpoint({
            leadId: lead,
            actorId: owner,
            body: {
                touchpoint_type: "whatsapp",
                remarks: "spoke on WhatsApp",
                is_engaged: true,
                status_change: { to: "Under_Discussion" },
            },
        });
        const [t] = await rows<{ is_engaged: boolean | null }>(sql`
            SELECT is_engaged FROM lead_touchpoints WHERE touchpoint_id = ${res.touchpointId}::uuid`);
        const [l] = await rows<{ lead_status: string }>(sql`SELECT lead_status FROM dealer_leads WHERE id = ${lead}`);
        assert(t.is_engaged !== true, "the entry was stored as engaged with no screenshot");
        assert(l.lead_status === "Assigned_Not_Contacted", `status moved to ${l.lead_status}`);
        return "saved as a note: not engaged, status unchanged";
    });

    await check("ID 79 — a counted WhatsApp contact carries its follow-up and reads the status under the row lock", async () => {
        const owner = await anyUserId();
        const lead = await seedLead("Assigned_Not_Contacted", owner);
        const when = new Date(Date.now() + 2 * 24 * 3600 * 1000);
        const res = await recordWhatsappContact(tx, {
            leadId: lead,
            actorId: owner,
            remarks: "dealer asked for the price list",
            dealerReplied: true,
            screenshot: { url: "https://example.invalid/shot.png", sha256: `vfu-${Math.random().toString(36).slice(2)}` },
            nextActionAt: when,
        });
        assert(res.countedAsContact && res.statusTo === "Under_Discussion", "a fresh screenshot + reply did not count");
        const [t] = await rows<{ next_action: string | null; has_at: boolean }>(sql`
            SELECT next_action, next_action_at IS NOT NULL AS has_at FROM lead_touchpoints
             WHERE touchpoint_id = ${res.touchpointId}::uuid`);
        assert(t.next_action === "follow_up" && t.has_at, "the follow-up was not recorded on the entry");
        // A second entry on the lead already at Under discussion is saved, not refused.
        const again = await recordWhatsappContact(tx, {
            leadId: lead,
            actorId: owner,
            remarks: "follow-up chat",
            dealerReplied: true,
            screenshot: { url: "https://example.invalid/shot2.png", sha256: `vfu-${Math.random().toString(36).slice(2)}` },
        });
        assert(again.countedAsContact && again.statusTo === null, "the second chat tried to move a lead already Under discussion");
        return "counted, follow-up stored; a second chat on the same lead is saved with no status move";
    });

    // ── ID 57 ───────────────────────────────────────────────────────────────
    await check("ID 57 — bulk Mark Lost runs the single-lead rules and side effects", async () => {
        let refused = false;
        try {
            checkMarkLost({ reason: "lost_to_competition", notes: "bulk", confirmedHighImpact: true, competitorName: " " });
        } catch (e) {
            refused = e instanceof CompetitorRequiredError;
        }
        assert(refused, "'Lost to competition' with no competitor was accepted");

        const actor = { id: await anyUserId(), role: "sales_head" };
        const lead = await seedLead("Under_Discussion");
        // What the bulk route now calls for each open lead.
        await markLeadLost({
            leadId: lead,
            actor,
            reason: "business_closed",
            notes: "Bulk mark lost (verify)",
            confirmedHighImpact: true,
            closingRole: "admin",
        });
        const [l] = await rows<{ lead_status: string; lost_reason: string | null; ai_recall_status: string | null; closing_role: string | null }>(sql`
            SELECT lead_status, lost_reason, ai_recall_status, closing_role FROM dealer_leads WHERE id = ${lead}`);
        assert(l.lead_status === "Lost" && l.lost_reason === "business_closed", `lead is ${l.lead_status} / ${l.lost_reason}`);
        assert(l.ai_recall_status === "excluded", "a closed business was not excluded from the AI dialer");
        assert(l.closing_role === "admin", `closing role ${l.closing_role}, expected admin`);
        return "competitor required; a closed business is Lost, excluded from the AI dialer, closed by 'admin'";
    });

    // ── ID 58 ───────────────────────────────────────────────────────────────
    await check("ID 58 — a download writes its log row", async () => {
        const user = await anyUserId();
        const before = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM data_download_log WHERE dataset = 'verify_p0_followups'`);
        await logDataDownload({ userId: user, role: "partner", dataset: "verify_p0_followups", rowCount: 3, ownOnly: true, filters: { selected: 5, exported: 3 } });
        const after = await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM data_download_log WHERE dataset = 'verify_p0_followups'`);
        assert(after[0].n === before[0].n + 1, "no data_download_log row was written (E-312 applied?)");
        return "one row: user, dataset, 3 rows, own_only";
    });

    // ── ID 118 ──────────────────────────────────────────────────────────────
    await check("ID 118 — a forged DigiLocker POST plants nothing", async () => {
        const [txn] = await rows<{ id: string; status: string | null; verification_id: string | null }>(sql`
            SELECT id, status, verification_id::text AS verification_id FROM digilocker_transactions
             ORDER BY created_at DESC LIMIT 1`);
        if (!txn) throw new Error("SKIP: no DigiLocker transaction on this database");
        const { POST } = await import("../src/app/api/kyc/digilocker/callback/[transactionId]/route");
        const forged = new NextRequest(`http://localhost/api/kyc/digilocker/callback/${txn.id}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ documents: [{ type: "aadhaar", data: { name: "Forged Name", uid: "999999999999" } }] }),
        });
        const res = await POST(forged, { params: Promise.resolve({ transactionId: txn.id }) });
        assert(res.status === 200, `expected 200, got ${res.status}`);
        const [after] = await rows<{ status: string | null; forged: boolean }>(sql`
            SELECT status, COALESCE(aadhaar_extracted_data::text, '') LIKE '%Forged Name%' AS forged
              FROM digilocker_transactions WHERE id = ${txn.id}`);
        assert(after.status === txn.status, `transaction moved ${txn.status} → ${after.status}`);
        assert(!after.forged, "the forged Aadhaar details were stored");
        const unknown = await POST(
            new NextRequest("http://localhost/api/kyc/digilocker/callback/NO-SUCH", { method: "POST", body: "{}" }),
            { params: Promise.resolve({ transactionId: "ZZ-VERIFY-NO-SUCH" }) },
        );
        assert(unknown.status === 400, `an unknown transaction answered ${unknown.status}`);
        return `transaction stays '${txn.status}'; nothing from the body is stored`;
    });
}

async function main() {
    const real = { execute: db.execute, transaction: db.transaction, select: db.select, insert: db.insert, update: db.update, delete: db.delete, query: db.query };
    try {
        await db.transaction(async (t) => {
            tx = t;
            Object.assign(db, {
                execute: t.execute.bind(t),
                transaction: t.transaction.bind(t),
                select: t.select.bind(t),
                insert: t.insert.bind(t),
                update: t.update.bind(t),
                delete: t.delete.bind(t),
                query: t.query,
            });
            try {
                await run();
            } finally {
                Object.assign(db, real);
            }
            throw new Rollback();
        });
    } catch (e) {
        if (!(e instanceof Rollback)) {
            console.error("verifier crashed:", e);
            process.exit(1);
        }
    }

    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id} — ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    const skipped = results.filter((r) => r.outcome === "SKIP").length;
    console.log(`\n${results.length - failed - skipped} ok / ${failed} failed / ${skipped} skipped — rolled back, nothing was changed`);
    process.exit(failed ? 1 : 0);
}

void main();
