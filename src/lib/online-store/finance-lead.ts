// Online store "Buy on finance" enquiry → CRM customer lead (Store R-15).
//
// WHO OWNS THE LEAD. Decision D-12: the iTarang house dealer — the same
// account WhatsApp self-onboarding customers land on (resolveHouseDealer,
// WHATSAPP_HOUSE_DEALER_EMAIL, default dealer@itarang.com). From there Admin /
// the Sales Head call the customer and push the file to an onboarded dealer
// near the pincode, exactly as for any other house file (ID 33): it shows on
// the house scope of the customer-leads list and in the house login's leads.
//
// The lead mirrors what createCustomerLead (src/lib/whatsapp/customer-lead.ts)
// writes for a WhatsApp customer, with lead_source / source_channel
// 'online_store' so reports can tell the store's leads apart.
//
// IDEMPOTENT ON storeRef. The store retries any non-2xx. The ledger row
// (E-366, UNIQUE store_ref) is claimed first, inside the same transaction as
// the lead: a concurrent retry blocks on the unique index until the first
// commits, then claims nothing and is answered with the first lead's id.

import { eq } from "drizzle-orm";

import { generateId } from "@/lib/api-utils";
import { db } from "@/lib/db/index";
import { leads, onlineStoreFinanceLeads, personalDetails } from "@/lib/db/schema";
import { nextReference } from "@/lib/leads/draftService";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import { resolveHouseDealer } from "@/lib/whatsapp/customer-lead";
import { recordLeadFlowEvent } from "@/lib/whatsapp/lead-events";

import { financeLeadRemarks, type FinanceLeadInput } from "./intake";

/** leads.lead_source and leads.source_channel for every store lead. */
export const ONLINE_STORE_SOURCE = "online_store";

export class HouseDealerMissingError extends Error {
    constructor() {
        super("The iTarang house dealer is not set up on this environment");
        this.name = "HouseDealerMissingError";
    }
}

export interface FinanceLeadResult {
    leadId: string;
    duplicate: boolean;
    /** Set on a new lead only — what the notification needs. */
    dealerName?: string;
}

async function existingLeadId(storeRef: string): Promise<string | null> {
    const [row] = await db
        .select({ leadId: onlineStoreFinanceLeads.lead_id })
        .from(onlineStoreFinanceLeads)
        .where(eq(onlineStoreFinanceLeads.store_ref, storeRef))
        .limit(1);
    return row?.leadId ?? null;
}

export async function createOnlineStoreFinanceLead(
    input: FinanceLeadInput,
    payload: unknown,
): Promise<FinanceLeadResult> {
    // Fast path for the common retry: no house lookup, no id minted.
    const seen = await existingLeadId(input.storeRef);
    if (seen) return { leadId: seen, duplicate: true };

    const house = await resolveHouseDealer();
    if (!house) throw new HouseDealerMissingError();
    if (!house.financeEnabled) {
        // Still recorded as a finance enquiry — that is what the customer asked
        // for — but the file cannot reach Step 4 on the house until it is
        // pushed to a finance-enabled dealer. Say so in the log.
        console.warn(
            `[OnlineStore] house dealer ${house.dealerCode} is not finance-enabled — ` +
                "the store's finance lead must be pushed to a finance dealer.",
        );
    }

    const leadId = await generateId("LEAD", leads);
    const referenceId = await nextReference();
    const mobile = `+91${input.mobile}`;

    const created = await db.transaction(async (tx) => {
        const claimed = await tx
            .insert(onlineStoreFinanceLeads)
            .values({
                store_ref: input.storeRef,
                lead_id: leadId,
                page: input.page,
                product_sku: input.productSku,
                product_title: input.productTitle,
                product_url: input.productUrl,
                price_paise: input.pricePaise,
                pincode: input.pincode,
                payload: (payload ?? {}) as Record<string, unknown>,
            })
            .onConflictDoNothing({ target: onlineStoreFinanceLeads.store_ref })
            .returning({ id: onlineStoreFinanceLeads.id });
        // A retry that raced us here: nothing written, answer with its lead.
        if (claimed.length === 0) return false;

        await tx.insert(leads).values({
            id: leadId,
            reference_id: referenceId,
            dealer_id: house.dealerCode,
            owner_name: input.name,
            // Kept in lockstep like every other writer: the web Step-1 form
            // reads phone, the lists read owner_contact / mobile.
            owner_contact: mobile,
            mobile,
            phone: mobile,
            lead_source: ONLINE_STORE_SOURCE,
            source_channel: ONLINE_STORE_SOURCE,
            payment_method: "finance",
            // Explicit null, not the column default ('cold'): nobody has
            // spoken to the customer yet, so the caller sets the interest.
            interest_level: null,
            lead_status: "new",
            status: "ACTIVE",
            asset_model: input.productTitle,
            remarks: financeLeadRemarks(input),
            uploader_id: house.uploaderId,
            state: "Unknown",
            city: "Unknown",
        });

        await tx.insert(personalDetails).values({
            id: crypto.randomUUID(),
            lead_id: leadId,
        });
        return true;
    });

    if (!created) {
        const raced = await existingLeadId(input.storeRef);
        if (raced) return { leadId: raced, duplicate: true };
        throw new Error(`online_store_finance_leads claim lost for ${input.storeRef} but no row found`);
    }

    // Both best-effort and never throw: reporting and history, not the lead.
    await recordLeadCapture({
        leadType: "customer",
        name: input.name,
        phone: mobile,
        sourceChannel: ONLINE_STORE_SOURCE,
        sourceTable: "leads",
        sourceId: leadId,
    });
    await recordLeadFlowEvent({
        leadId,
        dealerCode: house.dealerCode,
        actorKind: "system",
        actorLabel: "Online store",
        action: "created",
        note: `Buy on finance enquiry from the online store (${input.page})`,
    });

    return { leadId, duplicate: false, dealerName: house.dealerName };
}
