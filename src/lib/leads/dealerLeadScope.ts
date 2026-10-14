// 14 Oct — which customer files a dealer login sees on its lists (loan
// facilitation, payment pending, …): its own (leads.dealer_id = its code),
// plus — for the iTarang house dealer only — every file the house pushed out
// to a dealer, wherever it is now (houseOriginatedLeadIds). The house keeps
// full access to those, so its lists must show them too.

import { eq, inArray, or, type SQL } from "drizzle-orm";

import { leads } from "@/lib/db/schema";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { houseOriginatedLeadIds } from "@/lib/leads/pushGuards";

/** WHERE fragment over `leads` for the files `dealerCode` may see. */
export async function dealerVisibleLeads(dealerCode: string): Promise<SQL> {
    const own = eq(leads.dealer_id, dealerCode);
    const house = await houseDealerCode();
    if (!house || dealerCode !== house) return own;
    const pushed = [...(await houseOriginatedLeadIds(house))];
    return pushed.length ? or(own, inArray(leads.id, pushed))! : own;
}
