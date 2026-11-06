/**
 * Tracker ID 214 (decided 2 Nov, Kartik) — every dealer onboarding sits on
 * exactly one lead. Database side; the rules are ./leadMatchRules.ts.
 *
 *   attachOnboardingToLead(appId)  on submit (portal and WhatsApp): find the
 *       lead by the ladder or create a 'Direct onboarding' one, link it, move
 *       it to Won (timeline line, bell to the owner) and record the owner and
 *       who gets the credit. A "possible" match (similar name, or more than one
 *       lead on a number) is left for Admin; nothing is created then.
 *   loadLeadMatchPanel(appId)      what Dealer Validation shows.
 *   applyLeadMatchAction(...)      Admin's Confirm / Change lead / Not the same
 *       dealer / Change credit owner / Find again.
 *   onOnboardingRejected(appId)    the linked lead → Lost 'Onboarding rejected'.
 *   leadMatchApprovalBlock(appId)  approval waits for Admin's Confirm.
 *
 * Needs E-372 (columns on dealer_onboarding_applications, raw SQL, not in
 * schema.ts). Without it everything here is a no-op and onboarding works as
 * before (phone link only). Never throws from the submit / reject hooks: an
 * onboarding must not fail because the lead could not be handled.
 */
import { nanoid } from "nanoid";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { recordLeadCreated, stampLeadSource } from "@/lib/leads/leadSource";
import { GSTIN_KEY, gstinKeyIsMatchable } from "@/lib/leads/gstinMatch";
import { notifyUser } from "@/lib/notifications/notify";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import { ONBOARDING_WON_NOTE } from "@/lib/reports/metricDefinitions";
import { candidatePhones } from "./linkToLead";
import {
    MATCH_METHOD_LABEL,
    decideLeadMatch,
    ownerAndCredit,
    similarNames,
    type Ladder,
    type MatchLead,
    type MatchMethod,
} from "./leadMatchRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let probe: Promise<boolean> | null = null;
/** E-372 applied here? Cached per process. */
export function hasLeadMatchColumns(): Promise<boolean> {
    probe ??= (async () => {
        try {
            const r = rowsOf<{ ok: boolean }>(
                await db.execute(sql`
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'dealer_onboarding_applications' AND column_name = 'lead_credit_user_id'
                    ) AS ok
                `),
            );
            return !!r[0]?.ok;
        } catch {
            return false;
        }
    })();
    return probe;
}

type AppRow = {
    id: string;
    company_name: string | null;
    gst_number: string | null;
    owner_phone: string | null;
    wa_phone: string | null;
    contact_phone: string | null;
    owner_email: string | null;
    contact_email: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    salesperson_user_id: string | null;
    onboarding_status: string | null;
    originating_dealer_lead_id: string | null;
    back_ref_lead_id: string | null;
    lead_match_method: string | null;
    lead_match_confirmed_at: string | null;
    lead_match_confirmed_by: string | null;
    lead_credit_user_id: string | null;
    lead_match_candidates: MatchLead[] | null;
};

async function loadApp(exec: Exec, appId: string): Promise<AppRow | null> {
    const r = rowsOf<AppRow>(
        await exec.execute(sql`
            SELECT app.id, app.company_name, app.gst_number, app.owner_phone, app.wa_phone, app.contact_phone,
                   app.owner_email, app.contact_email, app.city, app.state, app.pincode,
                   app.salesperson_user_id::text AS salesperson_user_id, app.onboarding_status,
                   app.originating_dealer_lead_id,
                   (SELECT dl.id FROM dealer_leads dl WHERE dl.dealer_onboarding_application_id = app.id
                     ORDER BY dl.created_at ASC LIMIT 1) AS back_ref_lead_id,
                   app.lead_match_method, app.lead_match_confirmed_at::text AS lead_match_confirmed_at,
                   app.lead_match_confirmed_by, app.lead_credit_user_id, app.lead_match_candidates
              FROM dealer_onboarding_applications app
             WHERE app.id = ${appId}
        `),
    );
    return r[0] ?? null;
}

/** dealer_leads rows matching `where`, with who already holds each. */
async function matchLeads(exec: Exec, where: SQL): Promise<MatchLead[]> {
    return rowsOf<MatchLead>(
        await exec.execute(sql`
            SELECT dl.id, dl.lead_status, dl.current_owner_id, dl.created_at::text AS created_at,
                   dl.dealer_name, dl.city,
                   h.id AS held_by_app,
                   COALESCE(h.onboarding_status = 'approved' OR h.approved_at IS NOT NULL, false) AS held_by_approved
              FROM dealer_leads dl
              LEFT JOIN LATERAL (
                  SELECT o.id, o.onboarding_status, o.approved_at
                    FROM dealer_onboarding_applications o
                   WHERE (o.originating_dealer_lead_id = dl.id OR o.id = dl.dealer_onboarding_application_id)
                     AND o.onboarding_status <> 'withdrawn'
                   ORDER BY (o.approved_at IS NOT NULL) DESC, o.created_at DESC
                   LIMIT 1
              ) h ON true
             WHERE ${where}
             ORDER BY dl.created_at ASC
             LIMIT 25
        `),
    );
}

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

async function buildLadder(exec: Exec, app: AppRow): Promise<Ladder> {
    const gst = (app.gst_number ?? "").replace(/\s+/g, "").toUpperCase();
    const key = GSTIN_KEY(sql`dl.gstin`);
    const gstin = gst.length === 15
        ? await matchLeads(exec, sql`${key} = ${gst} AND ${gstinKeyIsMatchable(key)}`)
        : [];
    const phones = [...new Set(candidatePhones(app).map((c) => last10(c.phone)).filter((p) => p.length === 10))];
    const phone = phones.length
        ? await matchLeads(
              exec,
              sql`right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10) IN (${sql.join(phones.map((p) => sql`${p}`), sql`, `)})`,
          )
        : [];
    const emails = [...new Set([app.owner_email, app.contact_email].map((e) => (e ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))];
    const email = emails.length
        ? await matchLeads(exec, sql`lower(trim(COALESCE(dl.contact_email, ''))) IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`)
        : [];
    const city = (app.city ?? "").trim().toLowerCase();
    const pin = (app.pincode ?? "").replace(/\D/g, "");
    let namePlace: MatchLead[] = [];
    if (app.company_name && (city || pin.length === 6)) {
        const near = await matchLeads(
            exec,
            sql`(${city ? sql`lower(trim(COALESCE(dl.city, ''))) = ${city}` : sql`false`}
                 OR ${pin.length === 6 ? sql`regexp_replace(COALESCE(dl.pincode, ''), '[^0-9]', '', 'g') = ${pin}` : sql`false`})
                AND dl.dealer_name IS NOT NULL`,
        );
        namePlace = near.filter((l) => similarNames(l.dealer_name, app.company_name));
    }
    return { gstin, phone, email, namePlace };
}

async function salesHeadId(exec: Exec): Promise<string | null> {
    const r = rowsOf<{ id: string }>(
        await exec.execute(sql`
            SELECT id::text AS id FROM users
             WHERE role = 'sales_head' AND is_active IS DISTINCT FROM false
             ORDER BY created_at ASC LIMIT 1
        `),
    );
    return r[0]?.id ?? null;
}

/** A form phone no lead has yet (dealer_leads.phone is UNIQUE), or null. */
async function freePhone(exec: Exec, app: AppRow): Promise<string | null> {
    for (const c of candidatePhones(app)) {
        const p = last10(c.phone);
        const taken = rowsOf<{ id: string }>(
            await exec.execute(sql`
                SELECT id FROM dealer_leads
                 WHERE right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ${p} LIMIT 1
            `),
        );
        if (taken.length === 0) return p;
    }
    return null;
}

/** A Direct onboarding lead for this application (ID 214 step 1, last rung). */
async function createDirectLead(tx: Tx, app: AppRow, ownerId: string | null): Promise<string | null> {
    const phone = await freePhone(tx, app);
    if (!phone) return null;
    const id = `DL-${Date.now()}-${nanoid(8)}`;
    const now = new Date();
    await tx.insert(dealerLeads).values({
        id,
        dealer_name: app.company_name ?? "Dealer",
        phone,
        shop_name: app.company_name ?? null,
        city: app.city ?? null,
        state: app.state ?? null,
        location: app.city ?? null,
        language: "hindi",
        lead_status: ownerId ? "Assigned_Not_Contacted" : "New_Unassigned",
        current_status: "new",
        source: "direct_onboarding",
        originator_id: ownerId,
        current_owner_id: ownerId,
        assigned_at: ownerId ? now : null,
        is_active: true,
        total_attempts: 0,
        final_intent_score: 0,
        follow_up_history: [],
        created_at: now,
        updated_at: now,
    });
    await tx.execute(sql`
        UPDATE dealer_leads
           SET gstin = COALESCE(gstin, ${app.gst_number}), contact_email = COALESCE(contact_email, ${app.owner_email ?? app.contact_email}),
               pincode = COALESCE(pincode, ${app.pincode})
         WHERE id = ${id}
    `);
    await stampLeadSource(tx, id, { door: "direct_onboarding" });
    await recordLeadCreated(tx, { leadId: id, actorId: null, door: "direct_onboarding", ownerId });
    // Deliberately NOT sales-ready: a direct onboarding is no "new lead", has
    // no first-call time limits and is never dialled (ID 214 report rules).
    return id;
}

async function leadRow(exec: Exec, leadId: string) {
    const r = rowsOf<{ lead_status: string | null; current_owner_id: string | null; dealer_name: string | null }>(
        await exec.execute(sql`SELECT lead_status, current_owner_id, dealer_name FROM dealer_leads WHERE id = ${leadId} FOR UPDATE`),
    );
    return r[0] ?? null;
}

/**
 * Link `leadId` to the application, move it to Won with a timeline line and
 * set owner / credit. Inside `tx`.
 */
async function linkAndWin(
    tx: Tx,
    app: AppRow,
    leadId: string,
    method: MatchMethod,
    opts: { creditOverride?: string | null; actorId?: string | null },
): Promise<{ ownerId: string | null; creditUserId: string | null }> {
    const lead = await leadRow(tx, leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    const decided = ownerAndCredit({
        leadOwnerId: lead.current_owner_id,
        salespersonId: app.salesperson_user_id,
        salesHeadId: lead.current_owner_id || app.salesperson_user_id ? null : await salesHeadId(tx),
    });
    const creditUserId = opts.creditOverride !== undefined ? opts.creditOverride : decided.creditUserId;

    // Another application left holding it by "Marked Won by mistake" lets go (ID 169).
    await tx.execute(sql`
        UPDATE dealer_onboarding_applications o
           SET originating_dealer_lead_id = NULL, updated_at = now()
         WHERE o.originating_dealer_lead_id = ${leadId} AND o.id <> ${app.id}
           AND o.onboarding_status = 'withdrawn'
    `);
    await tx.execute(sql`
        UPDATE dealer_onboarding_applications app
           SET originating_dealer_lead_id = ${leadId}, updated_at = now()
         WHERE app.id = ${app.id}
           AND NOT EXISTS (SELECT 1 FROM dealer_onboarding_applications o
                            WHERE o.originating_dealer_lead_id = ${leadId} AND o.id <> ${app.id})
    `);
    await tx.execute(sql`
        UPDATE dealer_leads
           SET dealer_onboarding_application_id = ${app.id},
               current_owner_id = COALESCE(current_owner_id, ${decided.ownerId}),
               assigned_at = COALESCE(assigned_at, CASE WHEN ${decided.ownerId}::text IS NULL THEN NULL ELSE now() END),
               updated_at = now()
         WHERE id = ${leadId}
    `);

    const why = `${ONBOARDING_WON_NOTE} (${MATCH_METHOD_LABEL[method]}).`;
    const from = lead.lead_status as LeadStatus | null;
    if (from !== "Won" && from !== "Converted") {
        await writeTouchpoint(
            {
                dealerLeadId: leadId,
                touchpointType: "onboarding_linked",
                // Always the system: this Won is not a rep's "Marked Won"
                // (metricDefinitions notOnboardingWon reads changed_by + note).
                performedBy: null,
                remarks: why,
                syncMethod: "system",
                statusChange: {
                    from,
                    to: "Won",
                    event: "onboarding_submitted",
                    closingRole: "system",
                    reasonNotes: why,
                    ...(from === "Lost" ? { toLostReason: null } : {}),
                },
            },
            { tx },
        );
    } else {
        await writeTouchpoint(
            { dealerLeadId: leadId, touchpointType: "onboarding_linked", performedBy: opts.actorId ?? null, remarks: why, syncMethod: "system" },
            { tx },
        );
    }
    // Credit as decided — explicitly, so a self-onboarded dealer credits nobody
    // (writeTouchpoint would otherwise credit the current owner).
    await tx.execute(sql`UPDATE dealer_leads SET closing_owner_id = ${creditUserId} WHERE id = ${leadId}`);
    await tx.execute(sql`
        UPDATE dealer_onboarding_applications
           SET lead_match_method = ${method}, lead_match_at = now(), lead_credit_user_id = ${creditUserId},
               lead_match_candidates = NULL,
               lead_match_confirmed_at = NULL, lead_match_confirmed_by = NULL
         WHERE id = ${app.id}
    `);
    return { ownerId: lead.current_owner_id ?? decided.ownerId, creditUserId };
}

export type AttachResult =
    | { done: false; reason: "no_columns" | "not_found" | "error" }
    | { done: true; outcome: "linked" | "created" | "possible" | "unchanged"; leadId: string | null; method: MatchMethod | null };

/** On submit (portal and WhatsApp). Never throws. */
export async function attachOnboardingToLead(appId: string, opts: { actorId?: string | null } = {}): Promise<AttachResult> {
    try {
        if (!(await hasLeadMatchColumns())) return { done: false, reason: "no_columns" };
        const result = await db.transaction(async (tx) => {
            const app = await loadApp(tx, appId);
            if (!app) return { done: false as const, reason: "not_found" as const };
            const linked = app.originating_dealer_lead_id ?? app.back_ref_lead_id;
            if (linked) {
                // Re-submit (e.g. after a rejection): the same lead, back to Won.
                const r = await linkAndWin(tx, app, linked, (app.lead_match_method as MatchMethod) ?? "phone", {
                    creditOverride: app.lead_match_method ? app.lead_credit_user_id : undefined,
                    actorId: opts.actorId,
                });
                return { done: true as const, outcome: "linked" as const, leadId: linked, method: (app.lead_match_method as MatchMethod) ?? "phone", owner: r.ownerId };
            }
            const d = decideLeadMatch(await buildLadder(tx, app), app.id);
            if (d.kind === "possible") {
                await tx.execute(sql`
                    UPDATE dealer_onboarding_applications
                       SET lead_match_candidates = ${JSON.stringify(d.candidates)}::jsonb, lead_match_at = now()
                     WHERE id = ${app.id}
                `);
                return { done: true as const, outcome: "possible" as const, leadId: null, method: null, owner: null };
            }
            if (d.kind === "link") {
                const r = await linkAndWin(tx, app, d.lead.id, d.method, { actorId: opts.actorId });
                return { done: true as const, outcome: "linked" as const, leadId: d.lead.id, method: d.method, owner: r.ownerId };
            }
            // create, or another shop of an existing account (new lead with credit).
            const { ownerId } = ownerAndCredit({
                leadOwnerId: null,
                salespersonId: app.salesperson_user_id,
                salesHeadId: app.salesperson_user_id ? null : await salesHeadId(tx),
            });
            const leadId = await createDirectLead(tx, app, ownerId);
            if (!leadId) {
                // Every form number is already on a lead: Admin must choose.
                const candidates = d.kind === "new_shop" ? [d.of] : [];
                await tx.execute(sql`
                    UPDATE dealer_onboarding_applications
                       SET lead_match_candidates = ${JSON.stringify(candidates)}::jsonb, lead_match_at = now()
                     WHERE id = ${app.id}
                `);
                return { done: true as const, outcome: "possible" as const, leadId: null, method: null, owner: null };
            }
            const r = await linkAndWin(tx, app, leadId, "created", { actorId: opts.actorId });
            return { done: true as const, outcome: "created" as const, leadId, method: "created" as const, owner: r.ownerId };
        });
        if (result.done && result.leadId && result.owner) {
            await notifyUser(result.owner, {
                type: "lead.onboarding_submitted",
                title: "Dealer onboarding submitted on your lead",
                message:
                    result.outcome === "created"
                        ? "A dealer onboarded directly; a lead was created for you (Direct onboarding) and set to Won. Admin confirms it at Dealer Validation."
                        : "The dealer submitted their onboarding; the lead is now Won. Admin confirms it at Dealer Validation.",
                leadId: result.leadId,
                data: { href: `/leads/${result.leadId}` },
            }).catch(() => undefined);
        }
        if (!result.done) return result;
        return { done: true, outcome: result.outcome, leadId: result.leadId, method: result.method };
    } catch (err) {
        console.error("[leadMatch] attach failed", appId, err);
        return { done: false, reason: "error" };
    }
}

/** Approval waits for Admin's Confirm (ID 214). null = may approve. */
export async function leadMatchApprovalBlock(appId: string): Promise<string | null> {
    if (!(await hasLeadMatchColumns())) return null;
    const app = await loadApp(db, appId);
    if (!app) return null;
    if (!(app.originating_dealer_lead_id ?? app.back_ref_lead_id)) {
        return "This onboarding is not on a lead yet. In Dealer Validation > Lead, pick the lead or press 'Not the same dealer' to create one, then Confirm.";
    }
    if (!app.lead_match_confirmed_at) {
        return "Confirm the lead, its owner and who gets the credit in Dealer Validation > Lead before approving.";
    }
    return null;
}

export type LeadMatchPanel = {
    enabled: boolean;
    lead: { id: string; name: string | null; status: string | null; owner_id: string | null; owner_name: string | null } | null;
    method: MatchMethod | null;
    method_label: string | null;
    credit: { id: string | null; name: string | null };
    confirmed_at: string | null;
    confirmed_by_name: string | null;
    candidates: Array<{ id: string; name: string | null; city: string | null; status: string | null }>;
    people: Array<{ id: string; name: string; role: string }>;
};

export async function loadLeadMatchPanel(appId: string): Promise<LeadMatchPanel> {
    const off: LeadMatchPanel = {
        enabled: false,
        lead: null,
        method: null,
        method_label: null,
        credit: { id: null, name: null },
        confirmed_at: null,
        confirmed_by_name: null,
        candidates: [],
        people: [],
    };
    if (!(await hasLeadMatchColumns())) return off;
    const app = await loadApp(db, appId);
    if (!app) return off;
    const leadId = app.originating_dealer_lead_id ?? app.back_ref_lead_id;
    const lead = leadId
        ? rowsOf<{ id: string; name: string | null; status: string | null; owner_id: string | null; owner_name: string | null }>(
              await db.execute(sql`
                  SELECT dl.id, COALESCE(dl.shop_name, dl.dealer_name) AS name, dl.lead_status AS status,
                         dl.current_owner_id AS owner_id, u.name AS owner_name
                    FROM dealer_leads dl LEFT JOIN users u ON u.id::text = dl.current_owner_id
                   WHERE dl.id = ${leadId}
              `),
          )[0] ?? null
        : null;
    const names = rowsOf<{ id: string; name: string }>(
        await db.execute(sql`
            SELECT id::text AS id, COALESCE(name, email) AS name FROM users
             WHERE id::text IN (${app.lead_credit_user_id ?? ""}, ${app.lead_match_confirmed_by ?? ""})
        `),
    );
    const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? null) : null);
    const people = rowsOf<{ id: string; name: string; role: string }>(
        await db.execute(sql`
            SELECT id::text AS id, COALESCE(name, email) AS name, role FROM users
             WHERE role IN ('inside_sales_rep', 'asm', 'sales_head', 'sales_manager', 'sales_executive', 'business_head', 'partner')
               AND is_active IS DISTINCT FROM false
             ORDER BY name ASC
        `),
    );
    const method = (app.lead_match_method as MatchMethod | null) ?? null;
    return {
        enabled: true,
        lead,
        method,
        method_label: method ? MATCH_METHOD_LABEL[method] : null,
        credit: { id: app.lead_credit_user_id, name: nameOf(app.lead_credit_user_id) },
        confirmed_at: app.lead_match_confirmed_at,
        confirmed_by_name: nameOf(app.lead_match_confirmed_by),
        candidates: (app.lead_match_candidates ?? []).map((c) => ({
            id: c.id,
            name: c.dealer_name ?? null,
            city: c.city ?? null,
            status: c.lead_status,
        })),
        people,
    };
}

export type LeadMatchAction =
    | { action: "confirm" }
    | { action: "change_lead"; leadId: string }
    | { action: "not_same_dealer" }
    | { action: "change_credit"; userId: string | null }
    | { action: "find_again" };

export class LeadMatchError extends Error {
    constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
        super(message);
    }
}

/** Undo our system Won on a lead that turned out not to be this dealer. */
async function releaseLead(tx: Tx, app: AppRow, leadId: string, actorId: string, why: string) {
    const lead = await leadRow(tx, leadId);
    await tx.execute(sql`
        UPDATE dealer_onboarding_applications SET originating_dealer_lead_id = NULL, updated_at = now()
         WHERE id = ${app.id} AND originating_dealer_lead_id = ${leadId}
    `);
    await tx.execute(sql`
        UPDATE dealer_leads SET dealer_onboarding_application_id = NULL, updated_at = now()
         WHERE id = ${leadId} AND dealer_onboarding_application_id = ${app.id}
    `);
    if (lead?.lead_status === "Won") {
        await writeTouchpoint(
            {
                dealerLeadId: leadId,
                touchpointType: "onboarding_linked",
                performedBy: actorId,
                remarks: why,
                syncMethod: "manual",
                statusChange: { from: "Won", to: "Under_Discussion", event: "correction", reasonNotes: why },
            },
            { tx },
        );
    }
}

export async function applyLeadMatchAction(appId: string, actorId: string, a: LeadMatchAction): Promise<void> {
    if (!(await hasLeadMatchColumns())) throw new LeadMatchError("The lead check is not set up on this server yet (E-372).", 409);
    if (a.action === "find_again") {
        const r = await attachOnboardingToLead(appId, { actorId });
        if (!r.done) throw new LeadMatchError("Could not look for the lead; try again.", 409);
        return;
    }
    await db.transaction(async (tx) => {
        const app = await loadApp(tx, appId);
        if (!app) throw new LeadMatchError("Onboarding not found.", 404);
        if (app.onboarding_status === "approved") throw new LeadMatchError("This onboarding is already approved.", 409);
        const current = app.originating_dealer_lead_id ?? app.back_ref_lead_id;
        switch (a.action) {
            case "confirm":
                if (!current) throw new LeadMatchError("Pick the lead first (or 'Not the same dealer' to create one).");
                await tx.execute(sql`
                    UPDATE dealer_onboarding_applications
                       SET lead_match_confirmed_at = now(), lead_match_confirmed_by = ${actorId}
                     WHERE id = ${app.id}
                `);
                return;
            case "change_lead": {
                const target = rowsOf<{ id: string; holder: string | null }>(
                    await tx.execute(sql`
                        SELECT dl.id,
                               (SELECT o.id FROM dealer_onboarding_applications o
                                 WHERE o.originating_dealer_lead_id = dl.id AND o.id <> ${app.id}
                                   AND o.onboarding_status <> 'withdrawn' LIMIT 1) AS holder
                          FROM dealer_leads dl WHERE dl.id = ${a.leadId}
                    `),
                )[0];
                if (!target) throw new LeadMatchError("No lead with that id.", 404);
                if (target.holder) throw new LeadMatchError("That lead is already on another onboarding.", 409);
                if (current && current !== a.leadId) {
                    await releaseLead(tx, app, current, actorId, "Not this dealer's lead (Admin changed the lead at Dealer Validation).");
                }
                await linkAndWin(tx, { ...app, originating_dealer_lead_id: null }, a.leadId, "admin", { actorId });
                return;
            }
            case "not_same_dealer": {
                if (current) {
                    await releaseLead(tx, app, current, actorId, "Not the same dealer (Admin, Dealer Validation).");
                }
                const { ownerId } = ownerAndCredit({
                    leadOwnerId: null,
                    salespersonId: app.salesperson_user_id,
                    salesHeadId: app.salesperson_user_id ? null : await salesHeadId(tx),
                });
                const leadId = await createDirectLead(tx, app, ownerId);
                if (!leadId) {
                    throw new LeadMatchError("Every number on the form is already on a lead. Use Change lead and pick it instead.", 409);
                }
                await linkAndWin(tx, { ...app, originating_dealer_lead_id: null }, leadId, "created", { actorId });
                return;
            }
            case "change_credit":
                if (!current) throw new LeadMatchError("Pick the lead first.");
                await tx.execute(sql`UPDATE dealer_leads SET closing_owner_id = ${a.userId} WHERE id = ${current}`);
                await tx.execute(sql`
                    UPDATE dealer_onboarding_applications
                       SET lead_credit_user_id = ${a.userId}, lead_match_confirmed_at = NULL, lead_match_confirmed_by = NULL
                     WHERE id = ${app.id}
                `);
                return;
        }
    });
}

/** Rejected onboarding → its lead Lost 'Onboarding rejected' (ID 214 step 4). Never throws. */
export async function onOnboardingRejected(appId: string, actorId: string, reason: string | null): Promise<void> {
    try {
        if (!(await hasLeadMatchColumns())) return;
        await db.transaction(async (tx) => {
            const app = await loadApp(tx, appId);
            const leadId = app?.originating_dealer_lead_id ?? app?.back_ref_lead_id;
            if (!app || !leadId) return;
            const lead = await leadRow(tx, leadId);
            if (!lead || lead.lead_status === "Lost" || lead.lead_status === "Converted") return;
            const why = `Onboarding rejected${reason ? `: ${reason}` : ""}.`;
            await writeTouchpoint(
                {
                    dealerLeadId: leadId,
                    touchpointType: "onboarding_linked",
                    performedBy: actorId,
                    remarks: why,
                    syncMethod: "manual",
                    statusChange: {
                        from: lead.lead_status as LeadStatus | null,
                        to: "Lost",
                        event: "mark_lost",
                        adminOverride: true,
                        toLostReason: "onboarding_rejected",
                        reasonNotes: why,
                        closingRole: "admin",
                    },
                },
                { tx },
            );
        });
    } catch (err) {
        console.error("[leadMatch] reject hook failed", appId, err);
    }
}
