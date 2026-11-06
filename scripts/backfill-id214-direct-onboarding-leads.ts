// ID 214 step 6 — one-time clean-up (decided 2 Nov, Kartik): every APPROVED
// dealer onboarding that sits on no lead gets one — a 'Direct onboarding'
// lead, Converted, dated at the original approval — so every onboarding is
// on exactly one lead. Owner: the account's owner, else the salesperson on
// the form, else the Sales Head. Credit: the salesperson on the form, else
// nobody (a self-onboarded dealer).
//
// A Direct onboarding lead is not a "new lead" (Leads in leaves it out), has
// no time limits and is never dialled (metricDefinitions.notDirectOnboarding).
// It DOES count as a Converted dealer on its approval day — the conversion
// really happened then.
//
// Dry run by default: lists the onboardings it would give a lead and why any
// is skipped (every form number already on a lead). --apply writes a JSON
// record of what it created (reports/) — the lead ids an undo needs. On the
// live database --apply also needs --confirm-live (after Kartik's go-ahead).
// Re-running is a no-op. Needs E-377 only for the match columns (written
// when present).
//
//   node --import tsx --env-file=.env.local scripts/backfill-id214-direct-onboarding-leads.ts
//   node --import tsx --env-file=.env.production scripts/backfill-id214-direct-onboarding-leads.ts --apply --confirm-live

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { recordLeadCreated, stampLeadSource } from "@/lib/leads/leadSource";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { candidatePhones } from "@/lib/onboarding/linkToLead";
import { hasLeadMatchColumns } from "@/lib/onboarding/leadMatch";
import { ONBOARDING_WON_NOTE } from "@/lib/reports/metricDefinitions";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const apply = flag("apply");

type App = {
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
    approved_at: string;
    account_owner_id: string | null;
};

const last10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    const live = /database-2/i.test(host);
    console.log(`DB host: ${host}${live ? "  (LIVE)" : ""}  · ${apply ? "APPLY" : "dry run"}`);
    if (apply && live && !flag("confirm-live")) {
        throw new Error("this is the live database: add --confirm-live to --apply (after Kartik's go-ahead)");
    }
    const matchCols = await hasLeadMatchColumns();

    const apps = (await db.execute(sql`
        SELECT app.id, app.company_name, app.gst_number, app.owner_phone, app.wa_phone, app.contact_phone,
               app.owner_email, app.contact_email, app.city, app.state, app.pincode,
               app.salesperson_user_id::text AS salesperson_user_id, app.approved_at::text AS approved_at,
               (SELECT ao.owner_id::text FROM account_ownership ao
                 WHERE ao.account_id = app.dealer_code ORDER BY ao.created_at DESC LIMIT 1) AS account_owner_id
          FROM dealer_onboarding_applications app
         WHERE app.onboarding_status = 'approved' AND app.approved_at IS NOT NULL
           AND app.originating_dealer_lead_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM dealer_leads dl WHERE dl.dealer_onboarding_application_id = app.id)
         ORDER BY app.approved_at
    `).catch(async () =>
        // account_ownership missing on this database: no account owner.
        db.execute(sql`
            SELECT app.id, app.company_name, app.gst_number, app.owner_phone, app.wa_phone, app.contact_phone,
                   app.owner_email, app.contact_email, app.city, app.state, app.pincode,
                   app.salesperson_user_id::text AS salesperson_user_id, app.approved_at::text AS approved_at,
                   NULL::text AS account_owner_id
              FROM dealer_onboarding_applications app
             WHERE app.onboarding_status = 'approved' AND app.approved_at IS NOT NULL
               AND app.originating_dealer_lead_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM dealer_leads dl WHERE dl.dealer_onboarding_application_id = app.id)
             ORDER BY app.approved_at
        `),
    )) as unknown as App[];

    const [head] = (await db.execute(sql`
        SELECT id::text AS id FROM users WHERE role = 'sales_head' AND is_active IS DISTINCT FROM false ORDER BY created_at LIMIT 1
    `)) as unknown as Array<{ id: string }>;

    const plan: Array<{ app: App; phone: string | null; owner: string | null; credit: string | null }> = [];
    for (const app of apps) {
        let phone: string | null = null;
        for (const c of candidatePhones(app)) {
            const p = last10(c.phone);
            const taken = (await db.execute(sql`
                SELECT 1 FROM dealer_leads WHERE right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ${p} LIMIT 1
            `)) as unknown as unknown[];
            if (taken.length === 0) {
                phone = p;
                break;
            }
        }
        plan.push({
            app,
            phone,
            owner: app.account_owner_id ?? app.salesperson_user_id ?? head?.id ?? null,
            credit: app.salesperson_user_id,
        });
    }
    const doable = plan.filter((p) => p.phone);
    console.log(`\napproved onboardings on no lead: ${apps.length}; a lead can be created for ${doable.length}`);
    for (const p of plan) {
        console.log(
            `  ${p.app.approved_at.slice(0, 10)}  ${(p.app.company_name ?? p.app.id).slice(0, 40).padEnd(40)}  ${p.phone ? "create" : "SKIP: every form number is already on a lead (link it at Dealer Validation)"}${p.credit ? "" : " · no credit (self-onboarded)"}`,
        );
    }
    if (!apply) {
        console.log("\nDry run: nothing written. Post the counts in the tracker row; add --apply to create.");
        process.exit(0);
    }

    const created: Array<{ app_id: string; lead_id: string; approved_at: string; owner: string | null; credit: string | null }> = [];
    for (const p of doable) {
        const at = new Date(p.app.approved_at);
        const leadId = `DL-${at.getTime()}-${nanoid(8)}`;
        await db.transaction(async (tx) => {
            await tx.insert(dealerLeads).values({
                id: leadId,
                dealer_name: p.app.company_name ?? "Dealer",
                phone: p.phone!,
                shop_name: p.app.company_name ?? null,
                city: p.app.city ?? null,
                state: p.app.state ?? null,
                location: p.app.city ?? null,
                language: "hindi",
                lead_status: p.owner ? "Assigned_Not_Contacted" : "New_Unassigned",
                current_status: "new",
                source: "direct_onboarding",
                originator_id: p.owner,
                current_owner_id: p.owner,
                assigned_at: p.owner ? at : null,
                is_active: true,
                total_attempts: 0,
                final_intent_score: 0,
                follow_up_history: [],
                dealer_onboarding_application_id: p.app.id,
                created_at: at,
                updated_at: new Date(),
            });
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET gstin = COALESCE(gstin, ${p.app.gst_number}),
                       contact_email = COALESCE(contact_email, ${p.app.owner_email ?? p.app.contact_email}),
                       pincode = COALESCE(pincode, ${p.app.pincode})
                 WHERE id = ${leadId}
            `);
            await stampLeadSource(tx, leadId, { door: "direct_onboarding" });
            await recordLeadCreated(tx, { leadId, actorId: null, door: "direct_onboarding", ownerId: p.owner });
            await writeTouchpoint(
                {
                    dealerLeadId: leadId,
                    touchpointType: "onboarding_linked",
                    performedBy: null,
                    performedAt: at,
                    remarks: `${ONBOARDING_WON_NOTE} (clean-up 6 Nov: approved with no lead; dated at the approval).`,
                    syncMethod: "system",
                    statusChange: {
                        from: p.owner ? "Assigned_Not_Contacted" : "New_Unassigned",
                        to: "Converted",
                        event: "onboarding_approved",
                        closingRole: "system",
                        reasonNotes: `${ONBOARDING_WON_NOTE} — onboarding approved with no lead (ID 214 clean-up).`,
                    },
                },
                { tx },
            );
            await tx.execute(sql`UPDATE dealer_leads SET closing_owner_id = ${p.credit} WHERE id = ${leadId}`);
            await tx.execute(sql`
                UPDATE dealer_onboarding_applications SET originating_dealer_lead_id = ${leadId}
                 WHERE id = ${p.app.id} AND originating_dealer_lead_id IS NULL
            `);
            if (matchCols) {
                await tx.execute(sql`
                    UPDATE dealer_onboarding_applications
                       SET lead_match_method = 'created', lead_match_at = now(), lead_credit_user_id = ${p.credit},
                           lead_match_confirmed_at = now(), lead_match_confirmed_by = 'system'
                     WHERE id = ${p.app.id}
                `);
            }
        });
        created.push({ app_id: p.app.id, lead_id: leadId, approved_at: p.app.approved_at, owner: p.owner, credit: p.credit });
    }
    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `id214-direct-onboarding-leads-${host.split(".")[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ host, taken_at: new Date().toISOString(), created }, null, 1));
    console.log(`\ncreated ${created.length} Direct onboarding leads → ${file}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
