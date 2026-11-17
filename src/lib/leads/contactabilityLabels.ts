// The contactability vocabulary and its words, without the database: shared by
// contactability.ts (which re-exports both) and pure code such as the data
// downloads (ID 224), whose tests cannot load the database client.

export type Contactability = "dead_number" | "non_responsive";

/**
 * ID 126 — is this lead in the Number Repair queue? Its number is flagged (dead or not
 * answering), it is still active and not Lost. The queue's SQL (NUMBER_REPAIR_WHERE in
 * contactability.ts) and "Repair failed → Lost" use this one rule.
 */
export function inNumberRepair(lead: {
    contactability: string | null | undefined;
    is_active: boolean | null | undefined;
    lead_status: string | null | undefined;
}): boolean {
    return Boolean(lead.contactability) && lead.is_active !== false && lead.lead_status !== "Lost";
}

export const CONTACTABILITY_LABEL: Record<Contactability, string> = {
    dead_number: "Dead number",
    non_responsive: "Non-responsive (6 calls on 6 days, 45 days, no answer)",
};
