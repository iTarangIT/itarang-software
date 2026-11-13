/**
 * E-379 — owner mobile / alternate numbers an AI call learned (AI dialer list
 * item 6). Raw SQL, not in schema.ts, behind a to_regclass probe: without the
 * table nothing is stored and the dialer skips a switchboard / landline lead
 * as before. Validation is in contactCapture.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { observedNumbers } from "./phoneTypeStore";
import { classifyPhone, isDialablePhoneType } from "./numberHygiene";
import { contactsFromSignals, pickDialableContact, type ContactKind } from "./contactCapture";

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasContactsTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.dealer_lead_contacts') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

export type LeadContact = {
    id: string;
    kind: ContactKind;
    phone: string;
    name: string | null;
    status: string;
    sourceCallId: string | null;
    capturedAt: Date;
};

/** Store what one call learned. Never throws; returns how many rows were written. */
export async function saveCallContacts(input: {
    leadId: string;
    callId: string | null;
    signals: { owner_name?: string; owner_mobile?: string; alternate_number?: string } | null | undefined;
    leadPhone: string | null;
    dialledPhone: string | null;
}): Promise<number> {
    const contacts = contactsFromSignals(input.signals, { leadPhone: input.leadPhone, dialledPhone: input.dialledPhone });
    if (contacts.length === 0 || !(await hasContactsTable())) return 0;
    let n = 0;
    for (const c of contacts) {
        try {
            // A number heard again is refreshed (and re-activated: he said it
            // again); a rep's "wrong" mark only stays if the call adds nothing new.
            await db.execute(sql`
                INSERT INTO dealer_lead_contacts (lead_id, kind, phone, name, source_call_id)
                VALUES (${input.leadId}, ${c.kind}, ${c.phone}, ${c.name}, ${input.callId})
                ON CONFLICT (lead_id, phone) DO UPDATE
                   SET kind = CASE WHEN EXCLUDED.kind = 'owner_mobile' THEN 'owner_mobile' ELSE dealer_lead_contacts.kind END,
                       name = COALESCE(EXCLUDED.name, dealer_lead_contacts.name),
                       source_call_id = EXCLUDED.source_call_id,
                       status = 'active',
                       updated_at = now()
            `);
            n++;
        } catch (err) {
            console.warn("[contactStore] save failed:", err instanceof Error ? err.message : err);
        }
    }
    return n;
}

export async function contactsForLead(leadId: string): Promise<LeadContact[]> {
    if (!leadId || !(await hasContactsTable())) return [];
    try {
        return rowsOf<{
            id: string;
            kind: ContactKind;
            phone: string;
            name: string | null;
            status: string;
            source_call_id: string | null;
            captured_at: string | Date;
        }>(
            await db.execute(sql`
                SELECT id, kind, phone, name, status, source_call_id, captured_at
                  FROM dealer_lead_contacts WHERE lead_id = ${leadId}
                 ORDER BY (kind = 'owner_mobile') DESC, captured_at DESC
            `),
        ).map((r) => ({
            id: r.id,
            kind: r.kind,
            phone: r.phone,
            name: r.name,
            status: r.status,
            sourceCallId: r.source_call_id,
            capturedAt: new Date(r.captured_at),
        }));
    } catch (err) {
        console.warn("[contactStore] read failed:", err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * The number to dial instead of a lead's main number, or null: an active owner
 * mobile (else alternate) that is a mobile and that no call has marked as a
 * switchboard / dead number. `exclude` = numbers already taken in this campaign.
 */
export async function dialableContactFor(
    leadId: string,
    exclude: ReadonlySet<string> = new Set(),
): Promise<{ kind: ContactKind; phone: string } | null> {
    const contacts = (await contactsForLead(leadId)).filter((c) => isDialablePhoneType(classifyPhone(c.phone)));
    if (contacts.length === 0) return null;
    const marked = await observedNumbers(contacts.map((c) => c.phone));
    return pickDialableContact(contacts, new Set([...marked.keys(), ...exclude]));
}

/** Batch form for enrolment: lead id → the number to dial instead. */
export async function dialableContactsFor(leadIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (leadIds.length === 0 || !(await hasContactsTable())) return out;
    try {
        const rows = rowsOf<{ lead_id: string; kind: ContactKind; phone: string; status: string; captured_at: string | Date }>(
            await db.execute(sql`
                SELECT lead_id, kind, phone, status, captured_at FROM dealer_lead_contacts
                 WHERE status = 'active'
                   AND lead_id IN (${sql.join(leadIds.map((id) => sql`${id}`), sql`, `)})
            `),
        ).filter((r) => isDialablePhoneType(classifyPhone(r.phone)));
        const marked = await observedNumbers(rows.map((r) => r.phone));
        const byLead = new Map<string, typeof rows>();
        for (const r of rows) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r]);
        for (const [leadId, list] of byLead) {
            const pick = pickDialableContact(
                list.map((r) => ({ kind: r.kind, phone: r.phone, status: r.status, capturedAt: new Date(r.captured_at) })),
                new Set(marked.keys()),
            );
            if (pick) out.set(leadId, pick.phone);
        }
    } catch (err) {
        console.warn("[contactStore] batch read failed:", err instanceof Error ? err.message : err);
    }
    return out;
}

/** A rep marks a captured number wrong (or active again). */
export async function setContactStatus(leadId: string, contactId: string, status: "active" | "wrong"): Promise<boolean> {
    if (!(await hasContactsTable())) return false;
    const r = rowsOf<{ id: string }>(
        await db.execute(sql`
            UPDATE dealer_lead_contacts SET status = ${status}, updated_at = now()
             WHERE id = ${contactId} AND lead_id = ${leadId}
            RETURNING id
        `),
    );
    return r.length > 0;
}

/** A campaign dial was placed to a captured contact: remember the call, so its result lands on the contact. */
export async function noteContactDialled(leadId: string, phone: string, callId: string): Promise<void> {
    if (!(await hasContactsTable())) return;
    try {
        await db.execute(sql`
            UPDATE dealer_lead_contacts SET last_call_id = ${callId}, updated_at = now()
             WHERE lead_id = ${leadId} AND phone = right(regexp_replace(${phone}, '[^0-9]', '', 'g'), 10)
        `);
    } catch (err) {
        console.warn("[contactStore] dial not noted:", err instanceof Error ? err.message : err);
    }
}

/**
 * The result of a dial TO a captured contact. An IVR / dead number retires
 * the contact (status 'wrong'); anything else leaves it. Returns true when the
 * call was such a dial — the caller then must NOT mark or clear the lead's
 * main number, which this call never rang.
 */
export async function applyResultToContact(
    callId: string | null | undefined,
    mark: "switchboard" | "dead_number" | null,
): Promise<boolean> {
    if (!callId || !(await hasContactsTable())) return false;
    try {
        const r = rowsOf<{ id: string }>(
            await db.execute(sql`
                UPDATE dealer_lead_contacts
                   SET status = CASE WHEN ${mark}::text IS NULL THEN status ELSE 'wrong' END,
                       updated_at = now()
                 WHERE last_call_id = ${callId}
                RETURNING id
            `),
        );
        return r.length > 0;
    } catch (err) {
        console.warn("[contactStore] result not applied:", err instanceof Error ? err.message : err);
        return false;
    }
}

/** Leads that list this number as an active owner / alternate contact — the inbound lookup. */
export async function leadIdsForContactPhone(phoneKey10: string): Promise<string[]> {
    if (!phoneKey10 || !(await hasContactsTable())) return [];
    try {
        return rowsOf<{ lead_id: string }>(
            await db.execute(sql`
                SELECT lead_id FROM dealer_lead_contacts
                 WHERE phone = ${phoneKey10} AND status = 'active'
                 ORDER BY (kind = 'owner_mobile') DESC, updated_at DESC
            `),
        ).map((r) => r.lead_id);
    } catch {
        return [];
    }
}
