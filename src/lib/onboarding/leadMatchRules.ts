/**
 * Tracker ID 214 (decided 2 Nov, Kartik) — every dealer onboarding sits on
 * exactly one lead. The pure rules; the database side is ./leadMatch.ts.
 *
 * On submit the lead is found by, in order:
 *   1. GSTIN                              — automatic
 *   2. any phone on the form = lead phone — automatic when exactly one lead
 *   3. owner / contact email              — automatic when exactly one lead
 *   4. similar name + same city / pincode — "possible": Admin chooses
 *   5. none                               — a new lead, source 'Direct onboarding'
 * A matched lead that is already Converted to another account is the same
 * dealer opening another shop: a NEW lead for the new shop (2 Nov 19:08).
 * Every match is provisional until Admin confirms it at Dealer Validation.
 */

export type MatchMethod = "gstin" | "phone" | "email" | "name_place" | "created" | "admin";

export const MATCH_METHOD_LABEL: Record<MatchMethod, string> = {
    gstin: "Same GSTIN",
    phone: "Same phone number",
    email: "Same owner email",
    name_place: "Similar name, same city / pincode",
    created: "No lead found — created (Direct onboarding)",
    admin: "Chosen by Admin",
};

export type MatchLead = {
    id: string;
    lead_status: string | null;
    current_owner_id: string | null;
    /** The onboarding application that already holds this lead, if any. */
    held_by_app: string | null;
    /** That holder is approved (the dealer is already an account). */
    held_by_approved: boolean;
    created_at: string | null;
    dealer_name?: string | null;
    city?: string | null;
};

export type Ladder = {
    gstin: MatchLead[];
    phone: MatchLead[];
    email: MatchLead[];
    namePlace: MatchLead[];
};

export type MatchDecision =
    | { kind: "link"; lead: MatchLead; method: MatchMethod }
    /** The dealer is already an account through `of`: another shop → a new lead. */
    | { kind: "new_shop"; of: MatchLead; method: MatchMethod }
    /** Admin must choose (a similar name, or more than one lead on a phone / email). */
    | { kind: "possible"; candidates: MatchLead[] }
    | { kind: "create" };

const uniq = (ls: MatchLead[]) => {
    const seen = new Set<string>();
    return ls
        .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
};

/** One matched lead, seen from application `appId`. */
function decideOne(lead: MatchLead, method: MatchMethod, appId: string): MatchDecision {
    if (lead.held_by_app === appId) return { kind: "link", lead, method };
    if (lead.lead_status === "Converted" || (lead.held_by_app && lead.held_by_approved)) {
        return { kind: "new_shop", of: lead, method };
    }
    // An earlier application for the same dealer still holds it — Admin decides.
    if (lead.held_by_app) return { kind: "possible", candidates: [lead] };
    return { kind: "link", lead, method };
}

export function decideLeadMatch(ladder: Ladder, appId: string): MatchDecision {
    // 1. GSTIN: automatic. More than one lead on the same GSTIN → the one this
    // application already holds, else the oldest that is not closed out.
    const g = uniq(ladder.gstin);
    if (g.length > 0) {
        const mine = g.find((l) => l.held_by_app === appId);
        if (mine) return { kind: "link", lead: mine, method: "gstin" };
        const open = g.find((l) => l.lead_status !== "Converted" && !l.held_by_app);
        return decideOne(open ?? g[0], "gstin", appId);
    }
    // 2 / 3. Phone, then email: automatic only when exactly one lead.
    for (const [list, method] of [
        [uniq(ladder.phone), "phone"],
        [uniq(ladder.email), "email"],
    ] as const) {
        if (list.length === 1) return decideOne(list[0], method, appId);
        if (list.length > 1) {
            const mine = list.find((l) => l.held_by_app === appId);
            if (mine) return { kind: "link", lead: mine, method };
            return { kind: "possible", candidates: list };
        }
    }
    // 4. Similar name in the same place: never automatic.
    const np = uniq(ladder.namePlace);
    if (np.length > 0) return { kind: "possible", candidates: np };
    // 5. Nothing: a Direct onboarding lead.
    return { kind: "create" };
}

/**
 * Who owns the lead and who gets the conversion credit (decided 2 Nov):
 *   - the lead has an owner → that owner keeps the lead and the credit;
 *   - no owner, a salesperson on the form → the salesperson owns it, with credit;
 *   - no owner, self-onboarded → the Sales Head owns it, NO credit.
 */
export function ownerAndCredit(input: {
    leadOwnerId: string | null;
    salespersonId: string | null;
    salesHeadId: string | null;
}): { ownerId: string | null; creditUserId: string | null } {
    if (input.leadOwnerId) return { ownerId: input.leadOwnerId, creditUserId: input.leadOwnerId };
    if (input.salespersonId) return { ownerId: input.salespersonId, creditUserId: input.salespersonId };
    return { ownerId: input.salesHeadId, creditUserId: null };
}

/** Lower-case, letters and digits only, common business words dropped. Pure. */
export function nameKey(name: string | null | undefined): string {
    return (name ?? "")
        .toLowerCase()
        .replace(/\b(m\/s|ms|the|and|&|pvt|private|ltd|limited|llp|enterprises?|traders?|agency|agencies|sales|services?|co|company|store|stores|shop)\b/g, " ")
        .replace(/[^a-z0-9]+/g, "")
        .trim();
}

/** "Similar" names: one key contains the other (at least 4 characters). Pure. */
export function similarNames(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = nameKey(a);
    const y = nameKey(b);
    if (x.length < 4 || y.length < 4) return false;
    return x.includes(y) || y.includes(x);
}
