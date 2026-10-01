/**
 * Verifier for tracker ID 81 — source on every lead: "Lead created" and
 * Re-inquiry on every entry path, the acquisition campaign layer, and the
 * Re-inquiry notification. 01 Oct 2026.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id81-source.ts
 *
 * Runs the REAL writers (list import, scraper promotion, rep create, NeoDove
 * inbound, the campaign register) inside ONE transaction that is ALWAYS rolled
 * back — nothing is left behind, including the notifications they raise. For
 * the length of the run every `db.*` call in the process is routed into that
 * transaction, which is what lets the unmodified writers be exercised.
 *
 * E-319 is applied INSIDE the transaction, so the script gives the same answer
 * before and after the migration is applied for real. Sandbox only: it refuses
 * any host but database-1. Exit code 1 if anything FAILs.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { importListRows } from "../src/lib/ai-dialer/listImport";
import { promoteLeadsToDealerLeads } from "../src/lib/scraper/storage/leadStore";
import { createInsideSalesLead, DuplicatePhoneError } from "../src/lib/inside-sales/createLead";
import { handleNeodoveEvent } from "../src/lib/neodove/inbound";
import type { NeodoveInboundEvent } from "../src/lib/neodove/types";
import {
    recordLeadsCreatedBulk,
    recordReinquiries,
    stampLeadSourceBulk,
} from "../src/lib/leads/leadSource";
import {
    CampaignError,
    campaignForUploadBatch,
    createCampaign,
    listCampaigns,
    resolveLeadCampaign,
    updateCampaign,
} from "../src/lib/leads/acquisitionCampaigns";

const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
if (!host.startsWith("database-1.")) {
    console.error(`Refusing to run against ${host.split(".")[0]} — sandbox (database-1) only.`);
    process.exit(1);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = "PASS" | "FAIL";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];
class Rollback extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}
const eq = (got: unknown, want: unknown, what: string) =>
    assert(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

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
        results.push({ id, outcome: "FAIL", note: e instanceof Error ? e.message : String(e) });
    }
}

type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];

const source = async (leadId: string) =>
    (
        await rows<{ door: string | null; origin: string | null; campaign: string | null }>(sql`
            SELECT source_door AS door, source_origin AS origin, acquisition_campaign_id::text AS campaign
              FROM dealer_leads WHERE id = ${leadId}`)
    )[0];
const lines = async (leadId: string, type: string) =>
    (
        await rows<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM lead_touchpoints
             WHERE dealer_lead_id = ${leadId} AND touchpoint_type = ${type}`)
    )[0].n;
const bells = async (leadId: string | null) =>
    await rows<{ user_id: string; title: string }>(sql`
        SELECT user_id::text AS user_id, title FROM notifications
         WHERE type = 'lead.reinquiry' AND created_at >= NOW() - INTERVAL '10 minutes'
           AND ${leadId === null ? sql`lead_id IS NULL` : sql`lead_id = ${leadId}`}`);

/** A 10-digit mobile nobody in dealer_leads has. */
async function freshPhone(): Promise<string> {
    for (;;) {
        const p = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
        const hit = await rows(sql`
            SELECT 1 FROM dealer_leads WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${p} LIMIT 1`);
        if (hit.length === 0) return p;
    }
}

async function seedLead(p: { phone: string; name: string | null; city?: string | null; ownerId?: string | null; status?: string }) {
    const id = `DL-V81-${Math.random().toString(36).slice(2, 10)}`;
    await tx.execute(sql`
        INSERT INTO dealer_leads (id, phone, dealer_name, city, location, language, current_status, source,
                                  lead_status, current_owner_id, total_attempts, is_active, created_at, updated_at)
        VALUES (${id}, ${p.phone}, ${p.name}, ${p.city ?? null}, ${p.city ?? null}, 'hindi', 'new', 'manual_upload_lead',
                ${p.status ?? "Assigned_Not_Contacted"}, ${p.ownerId ?? null}, 0, TRUE, NOW(), NOW())`);
    return id;
}

async function run() {
    // ── setup ───────────────────────────────────────────────────────────────
    await tx.execute(sql.raw(readFileSync("drizzle/E-319_acquisition_campaign_links.sql", "utf8")));

    const people = await rows<{ id: string; role: string }>(sql`
        SELECT id::text AS id, lower(role) AS role FROM users
         WHERE is_active = TRUE AND lower(role) IN ('inside_sales_rep', 'asm', 'sales_head') ORDER BY created_at`);
    const rep = people.find((u) => u.role === "inside_sales_rep");
    const owner = people.find((u) => u.role === "asm") ?? people.find((u) => u.id !== rep?.id && u.role === "inside_sales_rep");
    const salesHeads = people.filter((u) => u.role === "sales_head");
    assert(rep && owner, "need an active inside_sales_rep and a second ISR / ASM on this database");

    // ── the campaign register ───────────────────────────────────────────────
    let expo = "";
    await check("campaign.create", async () => {
        const made = await createCampaign({ name: "V81 Auto Expo", origin: "trade_event", createdBy: rep.id });
        expo = made.id;
        let dup = "";
        try {
            await createCampaign({ name: "  v81 auto   EXPO ", origin: "trade_event" });
        } catch (e) {
            dup = e instanceof CampaignError ? `${e.status}` : String(e);
        }
        eq(dup, "409", "a second campaign with the same name (case / spacing aside)");
        const picker = await listCampaigns({ origin: "trade_event", activeOnly: true, manualOnly: true });
        assert(picker.some((c) => c.id === expo), "the new campaign is offered for its origin");
        const other = await listCampaigns({ origin: "digital_ad", activeOnly: true, manualOnly: true });
        assert(!other.some((c) => c.id === expo), "…and not for another origin");
        return "created; duplicate name refused 409; offered under its own origin only";
    });

    await check("campaign.required", async () => {
        const refused = async (input: { origin: string; campaignId: string | null }) => {
            try {
                await resolveLeadCampaign(db, input);
                return "accepted";
            } catch (e) {
                return e instanceof CampaignError ? `refused ${e.status}` : String(e);
            }
        };
        eq(await refused({ origin: "trade_event", campaignId: null }), "refused 400", "Trade event, no campaign");
        eq(await refused({ origin: "digital_ad", campaignId: "" }), "refused 400", "Digital ad, no campaign");
        eq(await refused({ origin: "field_walk_in", campaignId: null }), "accepted", "Field walk-in, no campaign");
        eq(await refused({ origin: "trade_event", campaignId: expo }), "accepted", "Trade event with its campaign");
        eq(await refused({ origin: "trade_event", campaignId: "not-a-uuid" }), "refused 400", "a campaign id that is not one");
        eq(
            await refused({ origin: "trade_event", campaignId: "00000000-0000-4000-8000-000000000000" }),
            "refused 400",
            "a campaign that does not exist",
        );
        await updateCampaign(expo, { isActive: false });
        eq(await refused({ origin: "trade_event", campaignId: expo }), "refused 400", "a closed campaign");
        const picker = await listCampaigns({ origin: "trade_event", activeOnly: true, manualOnly: true });
        assert(!picker.some((c) => c.id === expo), "a closed campaign leaves the picker");
        await updateCampaign(expo, { isActive: true });
        return "Trade event / Digital ad refused without one; missing, malformed and closed campaigns refused";
    });

    // ── rep create ──────────────────────────────────────────────────────────
    let repLead = "";
    const repPhone = await freshPhone();
    await check("rep_create.campaign", async () => {
        let refused = "";
        try {
            await createInsideSalesLead({
                actor: rep, dealerName: "V81 Refused", phone: repPhone, city: "Pune", origin: "trade_event",
            });
        } catch (e) {
            refused = e instanceof CampaignError ? "refused" : String(e);
        }
        eq(refused, "refused", "Trade event lead with no campaign");
        eq((await rows(sql`SELECT 1 FROM dealer_leads WHERE phone = ${repPhone}`)).length, 0, "leads made by the refused create");

        const made = await createInsideSalesLead({
            actor: rep, dealerName: "V81 Rep Lead", phone: repPhone, city: "Pune", origin: "trade_event", campaignId: expo,
        });
        repLead = made.id;
        const s = await source(repLead);
        eq(s.door, "rep_create", "Entered via");
        eq(s.origin, "trade_event", "Found via");
        eq(s.campaign, expo, "Campaign");
        eq(await lines(repLead, "lead_created"), 1, '"Lead created" lines');
        return "refused without a campaign; with one → rep_create / trade_event / campaign + Lead created";
    });

    await check("rep_create.reinquiry_notifies", async () => {
        // The lead is given to someone else, then the rep tries to add the dealer again (+91 form).
        await tx.execute(sql`UPDATE dealer_leads SET current_owner_id = ${owner.id} WHERE id = ${repLead}`);
        let dup = "";
        try {
            await createInsideSalesLead({
                actor: rep, dealerName: "V81 Again", phone: repPhone, city: "Pune", origin: "field_walk_in",
            });
        } catch (e) {
            dup = e instanceof DuplicatePhoneError ? (e.existingLeadId ?? "") : String(e);
        }
        eq(dup, repLead, "the duplicate is refused and names the existing lead");
        eq(await lines(repLead, "lead_reinquiry"), 1, "Re-inquiry lines");
        const told = await bells(repLead);
        assert(told.some((b) => b.user_id === owner.id), "the owner is notified");
        for (const sh of salesHeads) assert(told.some((b) => b.user_id === sh.id), "every Sales Head is notified");
        assert(!told.some((b) => b.user_id === rep.id), "the rep who triggered it is not notified");
        const s = await source(repLead);
        eq(s.origin, "trade_event", "Found via after a re-inquiry with a different origin (locked)");
        return `no second lead; Re-inquiry logged; owner + ${salesHeads.length} Sales Head(s) notified; source unchanged`;
    });

    // ── bulk helpers (admin upload commit, /leads Import) ───────────────────
    await check("bulk.created_and_reinquiry", async () => {
        const a = await seedLead({ phone: await freshPhone(), name: "V81 Bulk A" });
        const b = await seedLead({ phone: await freshPhone(), name: "V81 Bulk B" });
        const known = await seedLead({ phone: await freshPhone(), name: "V81 Known", ownerId: owner.id });

        const [batch] = await rows<{ batch_id: string }>(sql`
            INSERT INTO upload_batches (uploaded_by, file_name, total_rows, status)
            VALUES (${rep.id}, 'v81.csv', 3, 'processed') RETURNING batch_id::text AS batch_id`);
        const campaignId = await campaignForUploadBatch({
            batchId: batch.batch_id, fileName: "v81.csv", label: null, origin: "purchased_list", uploadedBy: rep.id,
        });
        assert(campaignId, "the batch gets a campaign of its own");
        const linked = await rows<{ c: string | null }>(sql`
            SELECT acquisition_campaign_id::text AS c FROM upload_batches WHERE batch_id = ${batch.batch_id}::uuid`);
        eq(linked[0].c, campaignId, "upload_batches.acquisition_campaign_id");

        await stampLeadSourceBulk([a, b], { door: "bulk_upload", origin: "purchased_list", campaignId });
        eq(await recordLeadsCreatedBulk([a, b], { door: "bulk_upload", actorId: rep.id }), 2, "Lead created lines written");
        eq(await recordLeadsCreatedBulk([a, b], { door: "bulk_upload", actorId: rep.id }), 0, "…written again on a re-run");
        const s = await source(a);
        eq(s.door, "bulk_upload", "Entered via");
        eq(s.origin, "purchased_list", "Found via");
        eq(s.campaign, campaignId, "Campaign");

        eq(await recordReinquiries([{ id: known, note: "V81 Known" }, { id: known }], { door: "bulk_upload", actorId: rep.id }), 1, "Re-inquiries (one lead named twice)");
        eq(await recordReinquiries([{ id: known }], { door: "bulk_upload", actorId: rep.id }), 0, "…a second upload inside the window");
        eq(await recordReinquiries([{ id: known }], { door: "scraper", actorId: null }), 1, "…the same dealer through another door");
        eq(await lines(known, "lead_reinquiry"), 2, "Re-inquiry lines on the known lead");
        const told = await bells(known);
        assert(told.some((b) => b.user_id === owner.id), "the owner gets the summary");
        return "campaign per batch; Lead created once per lead; Re-inquiry once per door per window; owner told";
    });

    // ── AI-dialer list import ───────────────────────────────────────────────
    await check("ai_list.import", async () => {
        const knownPhone = await freshPhone();
        const blankPhone = await freshPhone();
        const newPhone = await freshPhone();
        // Stored BARE, with a name a rep corrected; the sheet has it +91 with a stale name.
        const known = await seedLead({ phone: knownPhone, name: "Corrected Name", city: "Nashik" });
        const blank = await seedLead({ phone: blankPhone, name: null, city: null });

        const res = await importListRows(
            [
                { phone: `+91${knownPhone}`, name: "Stale Sheet Name", city: "Mumbai" },
                { phone: blankPhone, name: "Filled From Sheet", city: "Pune" },
                { phone: newPhone, name: "V81 List New", city: "Pune" },
            ],
            { listName: "V81 List", origin: null, actorId: rep.id },
        );
        eq(res.imported, 1, "new leads");
        eq(res.reused, 2, "reused leads");
        eq(res.updated, 1, "leads that had a blank filled");
        eq(res.queueIds.length, 3, "queue length");
        eq(res.queueIds[0], known, "the bare-stored lead is matched from its +91 form");

        const k = (await rows<{ dealer_name: string; city: string; state: string | null }>(sql`SELECT dealer_name, city, state FROM dealer_leads WHERE id = ${known}`))[0];
        eq(k.dealer_name, "Corrected Name", "an existing name after the import");
        eq(k.city, "Nashik", "an existing city after the import");
        eq(k.state, null, "the state of a lead in another city than the sheet's");
        const bl = (await rows<{ dealer_name: string; city: string }>(sql`SELECT dealer_name, city FROM dealer_leads WHERE id = ${blank}`))[0];
        eq(bl.dealer_name, "Filled From Sheet", "a blank name after the import");
        eq(
            (await rows(sql`SELECT 1 FROM dealer_leads WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${knownPhone}`)).length,
            1,
            "leads holding the known number",
        );

        const created = res.queueIds[2];
        const s = await source(created);
        eq(s.door, "ai_dialer", "Entered via");
        eq(s.origin, "purchased_list", "Found via (the calling-list default)");
        assert(s.campaign, "the list's campaign is on the new lead");
        const camp = (await rows<{ name: string; kind: string }>(sql`SELECT name, kind FROM acquisition_campaigns WHERE id = ${s.campaign}::uuid`))[0];
        eq(camp.name, "List · V81 List", "campaign name");
        eq(camp.kind, "dialer_list", "campaign kind");
        eq(await lines(created, "lead_created"), 1, '"Lead created" lines');
        eq(await lines(known, "lead_reinquiry"), 1, "Re-inquiry lines on the known lead");

        const again = await importListRows([{ phone: knownPhone, name: "x" }], { listName: "V81 List", actorId: rep.id });
        eq(again.imported, 0, "new leads on a re-upload");
        eq(await lines(known, "lead_reinquiry"), 1, "Re-inquiry lines after the same list again");
        return "shared check matches +91 vs bare; blanks filled, nothing overwritten; source + campaign + events";
    });

    // ── scraper promotion ───────────────────────────────────────────────────
    await check("scraper.promote", async () => {
        const runId = `SCRAPE-V81-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO scraper_runs (id, triggered_by, status, search_queries)
            VALUES (${runId}, ${rep.id}::uuid, 'completed', ${JSON.stringify("v81 battery dealers in pune")}::jsonb)`);
        const knownPhone = await freshPhone();
        const known = await seedLead({ phone: `+91${knownPhone}`, name: "V81 Scraped Before" });
        const newPhone = await freshPhone();

        const res = await promoteLeadsToDealerLeads(
            [
                { name: "V81 Scraped New", phone: newPhone, city: "Pune", state: "Maharashtra" },
                { name: "V81 Scraped Before", phone: knownPhone, city: "Pune", state: "Maharashtra" },
            ],
            { runId },
        );
        eq(res.promoted, 1, "promoted");
        eq(res.skippedDuplicate, 1, "known dealers skipped");
        const made = (await rows<{ id: string }>(sql`SELECT id FROM dealer_leads WHERE phone = ${newPhone}`))[0];
        const s = await source(made.id);
        eq(s.door, "scraper", "Entered via");
        eq(s.origin, "scraped_listing", "Found via");
        const run = (await rows<{ c: string | null }>(sql`SELECT acquisition_campaign_id::text AS c FROM scraper_runs WHERE id = ${runId}`))[0];
        assert(run.c, "the run is linked to a campaign");
        eq(s.campaign, run.c, "the run's campaign on the lead");
        eq(await lines(made.id, "lead_created"), 1, '"Lead created" lines');
        eq(await lines(known, "lead_reinquiry"), 1, "Re-inquiry lines on the known dealer");
        return "run → campaign → lead; Lead created; Re-inquiry on the dealer stored as +91";
    });

    // ── NeoDove inbound ─────────────────────────────────────────────────────
    const event = (over: Partial<NeodoveInboundEvent>): NeodoveInboundEvent => ({
        eventType: "lead_created",
        externalEventId: `v81-${Math.random().toString(36).slice(2)}`,
        mobile: null, neodoveLeadId: null, itarangLeadId: null, campaignName: null, campaignId: null,
        callConnected: null, disposition: null, dispositionCode: null, stage: null, tag: null, agentName: null,
        callDurationSec: null, recordingUrl: null, remarks: null, occurredAt: new Date(), name: "V81 NeoDove",
        email: null, city: null, raw: {},
        ...over,
    });

    await check("neodove.lead_created", async () => {
        const phone = `+91${await freshPhone()}`;
        const first = await handleNeodoveEvent(event({ mobile: phone }));
        eq(first.action, "lead_created", "action");
        const id = first.dealerLeadId!;
        const s = await source(id);
        eq(s.door, "neodove", "Entered via");
        eq(s.origin, "purchased_list", "Found via (pre-filled)");
        eq(await lines(id, "lead_created"), 1, '"Lead created" lines');

        // NeoDove creates the same dealer again, on its own → Re-inquiry.
        const second = await handleNeodoveEvent(event({ mobile: phone }));
        eq(second.dealerLeadId, id, "the second event resolves to the same lead");
        eq(await lines(id, "lead_reinquiry"), 1, "Re-inquiry lines");

        // The echo of our own push carries our id back → NOT a re-inquiry.
        await handleNeodoveEvent(event({ mobile: phone, itarangLeadId: id }));
        eq(await lines(id, "lead_reinquiry"), 1, "Re-inquiry lines after an echo of our push");
        return "born with neodove / purchased_list + Lead created; a second create is a Re-inquiry; our own echo is not";
    });

    await check("neodove.disposition_creates", async () => {
        const phone = `+91${await freshPhone()}`;
        const out = await handleNeodoveEvent(
            event({ eventType: "call_connected", mobile: phone, callConnected: true, disposition: "Interested" }),
        );
        eq(out.action, "lead_created", "action");
        const s = await source(out.dealerLeadId!);
        eq(s.door, "neodove", "Entered via");
        eq(s.origin, "purchased_list", "Found via");
        eq(await lines(out.dealerLeadId!, "lead_created"), 1, '"Lead created" lines');
        eq(await lines(out.dealerLeadId!, "lead_reinquiry"), 0, "Re-inquiry lines (a call is not a re-inquiry)");
        return "a lead born on a disposition gets its source and Lead created";
    });

    await check("trigger.neodove_origin", async () => {
        const id = `DL-V81-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, source, current_status, total_attempts)
            VALUES (${id}, ${`+91${await freshPhone()}`}, 'neodove', 'new', 0)`);
        const s = await source(id);
        eq(s.door, "neodove", "door from the insert trigger");
        eq(s.origin, "purchased_list", "origin from the insert trigger");
        const rep2 = `DL-V81-${Math.random().toString(36).slice(2, 10)}`;
        await tx.execute(sql`
            INSERT INTO dealer_leads (id, phone, source, current_status, total_attempts)
            VALUES (${rep2}, ${await freshPhone()}, 'manual_upload_lead', 'new', 0)`);
        eq((await source(rep2)).origin, null, "origin on a row whose path stamps its own");
        return "E-319 trigger pre-fills the NeoDove origin and nothing else";
    });
}

// Every db.* call in the process goes into the one transaction while it is open.
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

    console.table(results);
    const failed = results.filter((r) => r.outcome === "FAIL");
    console.log(failed.length ? `${failed.length} FAILED` : `all ${results.length} checks passed — rolled back, nothing was changed`);
    process.exit(failed.length ? 1 : 0);
}

void main();
