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
import { dealerLeads } from "@/lib/db/schema";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import type { BusinessType } from "@/lib/leads/businessType";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class DuplicatePhoneError extends Error {
    constructor() {
        super("A lead with this phone number already exists.");
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
    // The partner login also keeps what it creates — same lift as the ASM so
    // the lead lands in /partner/leads "My Open" — but it is not an ASM, so
    // asm_id stays null.
    return { selfAssigns: isAsm || role === "partner", isAsm };
}

async function phoneExists(exec: Tx | typeof db, phone: string): Promise<boolean> {
    const existing = await exec
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(sql`${dealerLeads.phone} = ${phone}`)
        .limit(1);
    return existing.length > 0;
}

/** The id of the lead that already has this phone, if any. */
export async function findLeadIdByPhone(phone: string): Promise<string | null> {
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

    // Phone is UNIQUE on dealer_leads — reject duplicates with a clear error.
    if (await phoneExists(exec, input.phone)) throw new DuplicatePhoneError();

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
