// The history tabs on an Ecofy lead page (EcofyLeadDetail) and the `?tab=`
// deep link into them (the Financing queue links to the Financing tab).
//
// Pure: imported by the client page and by unit tests.

export const ECOFY_LEAD_TABS = [
    "Timeline",
    "Activities",
    "Appointments",
    "Assessment",
    "Offer",
    "Financing",
    "Installation",
    "Documents",
    "Withdrawal",
] as const;

export type EcofyLeadTab = (typeof ECOFY_LEAD_TABS)[number];

/** `?tab=…` → the tab to open first; anything unknown opens the Timeline. */
export function initialEcofyTab(v: string | null | undefined): EcofyLeadTab {
    return (ECOFY_LEAD_TABS as readonly string[]).includes(v ?? "") ? (v as EcofyLeadTab) : "Timeline";
}

/** A lead page URL (from ecofyLeadHref) that opens on one tab. */
export function withEcofyTab(href: string, tab: EcofyLeadTab): string {
    return `${href}${href.includes("?") ? "&" : "?"}tab=${encodeURIComponent(tab)}`;
}
