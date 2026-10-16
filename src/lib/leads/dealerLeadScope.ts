// Which customer files a dealer login sees on its lists (loan facilitation,
// payment pending, …): its own (leads.dealer_id = its code).
//
// 14 Oct this also gave the iTarang house dealer every file it pushed out,
// so a pushed file showed on the house's cards AND the receiving dealer's.
// 16 Oct (ID 183, decided 14 Oct): the dealer is the only owner of a pushed
// file — it counts only under that dealer. The house sees its pushed files on
// the Pushed files list (/api/leads/pushed-files), never in its own counts.

import { eq, type SQL } from "drizzle-orm";

import { leads } from "@/lib/db/schema";

/** WHERE fragment over `leads` for the files `dealerCode` may see. */
export async function dealerVisibleLeads(dealerCode: string): Promise<SQL> {
    return eq(leads.dealer_id, dealerCode);
}
