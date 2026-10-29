// B1 + D7 — which leads a campaign may dial at all. Pure, no I/O.
//
// Three rules, applied where a campaign is created (createCampaign) and again
// at dial time (advanceCampaign) for campaigns created before them:
//
//   1. Mobiles only (Priya call drops, B1). 15 of 54 "connected" calls on
//      21-22 Oct were 080-6xxx / 080-7xxx cloud-telephony numbers that answer
//      instantly and forward nowhere. The doc's rule, +91[6-9] + 9 digits, does
//      not catch them: stored as +91 80 6xxx xxxx their last ten digits start
//      with 8, and Patna (0612), Bhopal (0755) and Raipur (0771) landlines start
//      with 6 or 7. libphonenumber knows India's mobile and fixed-line series,
//      so it decides. FIXED_LINE_OR_MOBILE (series shared by both) is dialled;
//      most of those are real mobiles.
//   2. No vehicle showrooms (B1). A listing titled "TVS - …", "Bajaj Auto …"
//      or "… Showroom" is a two-wheeler showroom, not a battery dealer. "Motors"
//      is deliberately NOT on the list: many genuine e-rickshaw dealers are
//      "X Motors". A name that also says battery / e-rickshaw / inverter / solar
//      / EV / lithium / electric / ESS / energy / Toto is kept (ID 207).
//   3. One dial per number per campaign (D7), compared on the last 10 digits
//      like the ID 81 duplicate check. The first lead in queue order is kept.

import { parsePhoneNumberFromString, type MetadataJson } from "libphonenumber-js/core";
import metadataJson from "libphonenumber-js/metadata.max.json";

// The core API with the metadata passed in, not "libphonenumber-js/max": under
// tsx (the BullMQ worker, scripts) /max's require() picks up the ESM build of
// its metadata and every number parses as invalid. "max" is the metadata that
// knows mobile from fixed-line series.
const METADATA: MetadataJson =
    (metadataJson as unknown as { default?: MetadataJson }).default ??
    (metadataJson as unknown as MetadataJson);

export type PhoneType =
    | "mobile"
    | "fixed_or_mobile"
    | "fixed_line"
    | "toll_free"
    | "other"
    | "invalid"
    // D2 / D7 — learned from a call, never from the number's shape (see
    // phoneTypeStore.noteCallResultForNumber): a company IVR answered, or the
    // carrier said the number does not exist. Cleared when a person answers.
    | "switchboard"
    | "dead_number";

/** Phone types a call taught us. A re-classification must not overwrite them. */
export const OBSERVED_PHONE_TYPES = ["switchboard", "dead_number"] as const;

/** What kind of number this is. Indian numbers without +91 are read as Indian. */
export function classifyPhone(raw: string | null | undefined): PhoneType {
    const s = (raw ?? "").trim();
    if (!s) return "invalid";
    const p = parsePhoneNumberFromString(s, "IN", METADATA);
    if (!p || !p.isValid()) return "invalid";
    // The dialler calls India only.
    if (p.country !== "IN") return "other";
    switch (p.getType()) {
        case "MOBILE":
            return "mobile";
        case "FIXED_LINE_OR_MOBILE":
            return "fixed_or_mobile";
        case "FIXED_LINE":
            return "fixed_line";
        case "TOLL_FREE":
            return "toll_free";
        default:
            return "other";
    }
}

export function isDialablePhoneType(t: PhoneType): boolean {
    return t === "mobile" || t === "fixed_or_mobile";
}

/** The duplicate key: the last 10 digits, as the ID 81 duplicate check uses. */
export function phoneKey(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
}

const SHOWROOM_RE =
    /\b(?:tvs|hero\s*moto\s*corp|euler|bajaj\s+auto|honda|ather|ola(?:\s+electric)?|showroom)\b/i;
// ID 207 (Kartik, 28 Oct): two-wheeler EV and ESS dealers are in range, so a
// name that also says EV / lithium / electric / ESS / BESS / energy / Toto or
// any rickshaw spelling (rickshaw, rikshaw, riksha) is kept. EV and ESS are
// whole words so "Seva" and "Express" do not count.
const DEALER_WORDS_RE =
    /batter(?:y|ies)|ric?ksha|inverter|solar|lithium|electric|energy|\btoto\b|\bevs?\b|\bb?ess\b/i;

/** A two-wheeler / vehicle showroom by its listing title. */
export function isVehicleShowroom(name: string | null | undefined): boolean {
    const s = name ?? "";
    return SHOWROOM_RE.test(s) && !DEALER_WORDS_RE.test(s);
}

export type EnrolSkip =
    | "no_phone"
    | "not_mobile"
    | "vehicle_showroom"
    | "duplicate_number"
    | "switchboard"
    | "dead_number"
    // D8 — a person owes this dealer a promised call; the AI does not ring him.
    | "open_callback";

/** The dialer_campaign_leads.call_outcome written for a lead skipped at enrolment. */
export const ENROL_SKIP_OUTCOME: Record<EnrolSkip, string> = {
    no_phone: "no_phone",
    not_mobile: "skipped_not_mobile",
    vehicle_showroom: "skipped_vehicle_showroom",
    duplicate_number: "skipped_duplicate_number",
    switchboard: "skipped_switchboard",
    dead_number: "skipped_dead_number",
    open_callback: "skipped_open_callback",
};

export type EnrolCandidate = {
    id: string;
    phone: string | null;
    name: string | null;
    /** D7 — a switchboard / dead number a call already found on this number. */
    observed?: "switchboard" | "dead_number" | null;
    /** D8 — an open promised callback: a person calls him, not the AI. */
    openCallback?: boolean;
};
export type EnrolDecision = { id: string; phoneType: PhoneType; skip: EnrolSkip | null };

/**
 * One decision per lead, in queue order. A number that is not a mobile is
 * reported as that, not as a duplicate; only dialable leads claim a number.
 */
export function planEnrolment(leads: EnrolCandidate[]): EnrolDecision[] {
    const seen = new Set<string>();
    return leads.map((l) => {
        const phoneType = classifyPhone(l.phone);
        if (l.openCallback) return { id: l.id, phoneType, skip: "open_callback" };
        if (!(l.phone ?? "").trim()) return { id: l.id, phoneType, skip: "no_phone" };
        if (!isDialablePhoneType(phoneType)) return { id: l.id, phoneType, skip: "not_mobile" };
        if (l.observed) return { id: l.id, phoneType: l.observed, skip: l.observed };
        if (isVehicleShowroom(l.name)) return { id: l.id, phoneType, skip: "vehicle_showroom" };
        const key = phoneKey(l.phone);
        if (key && seen.has(key)) return { id: l.id, phoneType, skip: "duplicate_number" };
        if (key) seen.add(key);
        return { id: l.id, phoneType, skip: null };
    });
}

/** "3 not a mobile, 1 vehicle showroom" — or null when nothing was skipped. */
export function describeEnrolSkips(counts: Record<EnrolSkip, number>): string | null {
    const parts: string[] = [];
    if (counts.not_mobile) parts.push(`${counts.not_mobile} not a mobile`);
    if (counts.no_phone) parts.push(`${counts.no_phone} with no phone`);
    if (counts.vehicle_showroom) {
        parts.push(`${counts.vehicle_showroom} vehicle showroom${counts.vehicle_showroom === 1 ? "" : "s"}`);
    }
    if (counts.duplicate_number) {
        parts.push(`${counts.duplicate_number} duplicate number${counts.duplicate_number === 1 ? "" : "s"}`);
    }
    if (counts.switchboard) {
        parts.push(`${counts.switchboard} switchboard${counts.switchboard === 1 ? "" : "s"}`);
    }
    if (counts.dead_number) {
        parts.push(`${counts.dead_number} dead number${counts.dead_number === 1 ? "" : "s"}`);
    }
    if (counts.open_callback) {
        parts.push(`${counts.open_callback} with a callback a person owes`);
    }
    return parts.length ? parts.join(", ") : null;
}

/** Why a dial-time check refuses a lead, or null to dial it. */
export function dialTimeSkip(lead: { phone: string | null; name: string | null }): EnrolSkip | null {
    if (!isDialablePhoneType(classifyPhone(lead.phone))) return "not_mobile";
    if (isVehicleShowroom(lead.name)) return "vehicle_showroom";
    return null;
}
