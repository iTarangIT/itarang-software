// Manual lead entry for the Inside Sales workspace. Extracted from
// POST /api/inside-sales/lead/create so the screen and the WhatsApp Assistant
// create leads exactly the same way.
//
// Inserts a dealer_leads row. Inside Sales / admin: New_Unassigned with no
// owner, so it lands in the "Unassigned (Claim)" queue. ASM / partner: owned by
// the creator immediately (ASM also becomes the field asm_id). Mirrors the
// column conventions of /api/dealer-leads (id = DL-<ts>-<nanoid>, phone UNIQUE).

import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { keepsCreatedLead } from "@/lib/inside-sales/types";
import { dealerLeads } from "@/lib/db/schema";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import type { BusinessType } from "@/lib/leads/businessType";
import { loadExistingByPhone, normalizePhone } from "@/lib/leads/dedupe";
import { createdByHandReason, markSalesReady } from "@/lib/leads/salesReady";
import {
    recordLeadCreated,
    recordReinquiry,
    stampLeadSource,
    type LeadDoor,
    type LeadOrigin,
} from "@/lib/leads/leadSource";
import { resolveLeadCampaign } from "@/lib/leads/acquisitionCampaigns";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class DuplicatePhoneError extends Error {
    /** The lead that already has this number (a Re-inquiry is logged on it). */
    readonly existingLeadId: string | null;
    constructor(existingLeadId: string | null = null) {
        super("A lead with this phone number already exists.");
        this.existingLeadId = existingLeadId;
    }
}

export type CreateLeadInput = {
    actor: { id: string; role: string };
    dealerName: string;
    /** Exactly 10 digits. */
    phone: string;
    shopName?: string | null;
    city?: string | null;
    state?: string | null;
    interestLevel?: "hot" | "warm" | "cold" | null;
    language?: string | null;
    businessType?: BusinessType | "" | null;
    /** ID 81: how the lead entered (automatic per path). Defaults to rep_create. */
    door?: LeadDoor;
    /** ID 81: where the dealer came from (fixed list). */
    origin?: LeadOrigin | null;
    /** ID 81: acquisition campaign — required for Trade event / Digital ad. */
    campaignId?: string | null;
};

export type CreateLeadResult = {
    id: string;
    /** undefined when no business type was given. */
    businessTypeSaved: boolean | undefined;
    /** Run AFTER the transaction commits (E-179 lead registry). */
    afterCommit: () => Promise<void>;
};

/** Does the creator own the new lead, and is it their field ASM lead? */
export function creationOwnership(role: string): { selfAssigns: boolean; isAsm: boolean } {
    const isAsm = role === "asm";
    // ASM, partner and inside-sales rep keep what they create
    // (KEEPS_CREATED_LEAD_ROLES) — it lands in their "My Open" with an
    // ownership hop. Only an ASM's lead is a field lead, so asm_id is set for
    // the ASM alone. Anyone else (admin) creates into the unassigned pool.
    return { selfAssigns: keepsCreatedLead(role), isAsm };
}

async function phoneExists(exec: Tx | typeof db, phone: string): Promise<boolean> {
    const existing = await exec
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(sql`${dealerLeads.phone} = ${phone}`)
        .limit(1);
    return existing.length > 0;
}

/**
 * The id of the lead that already has this phone, if any — the SHARED check
 * (last 10 digits, dedupe.ts), so a dealer stored as +91XXXXXXXXXX is found
 * from a bare 10-digit number too. Falls back to the exact text for a number
 * the shared normaliser does not accept.
 */
export async function findLeadIdByPhone(phone: string): Promise<string | null> {
    const normalised = normalizePhone(phone);
    if (normalised) {
        const hit = (await loadExistingByPhone([normalised])).get(normalised);
        if (hit) return hit.id;
    }
    const rows = await db
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(sql`${dealerLeads.phone} = ${phone}`)
        .limit(1);
    return rows[0]?.id ?? null;
}

export async function createInsideSalesLead(
    input: CreateLeadInput,
    opts?: { tx?: Tx },
): Promise<CreateLeadResult> {
    const exec = opts?.tx ?? db;

    // ID 81: the SHARED duplicate check (last 10 digits, dedupe.ts) — the same
    // one uploads and NeoDove use — so +91 / spaced numbers match too. A known
    // dealer is a Re-inquiry on the existing lead, never a second copy.
    const door: LeadDoor = input.door ?? "rep_create";
    const normalised = normalizePhone(input.phone);
    const existing = normalised ? (await loadExistingByPhone([normalised])).get(normalised) : undefined;
    if (existing) {
        await recordReinquiry({ leadId: existing.id, door, actorId: input.actor.id, note: input.dealerName });
        throw new DuplicatePhoneError(existing.id);
    }
    if (await phoneExists(exec, input.phone)) throw new DuplicatePhoneError();

    // ID 81: a Trade event / Digital ad lead needs its campaign, and a campaign
    // that is given must exist and be open (CampaignError, 400). After the
    // duplicate check — no questions about a dealer we already have.
    const campaignId = await resolveLeadCampaign(exec, { origin: input.origin, campaignId: input.campaignId });

    const id = `DL-${Date.now()}-${nanoid(8)}`;
    const now = new Date();
    const { selfAssigns, isAsm } = creationOwnership(input.actor.role);

    try {
        await exec.insert(dealerLeads).values({
            id,
            dealer_name: input.dealerName,
            phone: input.phone,
            shop_name: input.shopName || null,
            city: input.city || null,
            state: input.state || null,
            location: input.city || null,
            language: input.language || "hindi",
            interest_level: input.interestLevel || null,
            lead_status: selfAssigns ? "Assigned_Not_Contacted" : "New_Unassigned",
            current_status: "new",
            source: "manual_upload_lead",
            originator_id: input.actor.id,
            current_owner_id: selfAssigns ? input.actor.id : null,
            asm_id: isAsm ? input.actor.id : null,
            assigned_at: selfAssigns ? now : null,
            is_active: true,
            total_attempts: 0,
            final_intent_score: 0,
            follow_up_history: [],
            created_at: now,
            updated_at: now,
        });
    } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "23505" || e.message?.includes("unique")) throw new DuplicatePhoneError();
        throw err;
    }

    // E-296 — not on the Drizzle object (see schema.ts), so a raw UPDATE after
    // the insert. Allowed to fail: the lead exists either way. Inside a caller's
    // transaction a failed statement would abort it, so there it runs under a
    // savepoint.
    let businessTypeSaved: boolean | undefined;
    if (input.businessType) {
        const setType = (x: Tx | typeof db) =>
            x.execute(sql`UPDATE dealer_leads SET business_type = ${input.businessType} WHERE id = ${id}`);
        try {
            if (opts?.tx) await opts.tx.transaction(async (sp) => void (await setType(sp)));
            else await setType(db);
            businessTypeSaved = true;
        } catch (e) {
            businessTypeSaved = false;
            console.warn("[inside-sales/createLead] business_type not saved (E-296 applied?):", e);
        }
    }

    // ID 81 / 83: source stamp, and "Lead created" with the ownership hop when
    // the creator keeps the lead.
    await stampLeadSource(exec, id, { door, origin: input.origin ?? null, campaignId });
    await recordLeadCreated(exec, {
        leadId: id,
        actorId: input.actor.id,
        door,
        ownerId: selfAssigns ? input.actor.id : null,
    });

    // ID 82: a lead a rep created is sales-ready from creation.
    await markSalesReady(exec, { leadId: id, reason: createdByHandReason(input.origin), actorId: input.actor.id });

    // E-179 central registry — dealer prospect captured by Inside Sales / ASM.
    const afterCommit = () =>
        recordLeadCapture({
            leadType: "dealer",
            name: input.dealerName,
            phone: input.phone,
            sourceChannel: "web",
            sourceTable: "dealer_leads",
            sourceId: id,
        });

    return { id, businessTypeSaved, afterCommit };
}
