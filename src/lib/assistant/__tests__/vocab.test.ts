import { describe, expect, it } from "vitest";
import {
    CALL_VOCAB,
    HINGLISH_CALL_ALIASES,
    HINGLISH_VISIT_ALIASES,
    NO_CHANGE,
    VISIT_VOCAB,
    checkCallProposal,
    checkVisitProposal,
} from "../vocab";
import { CONNECTED_DISPOSITIONS, classifyDisposition } from "@/lib/leads/dispositions";
import { LEAD_STATUS, LOST_REASON } from "@/lib/lifecycle/transitions";
import { VISIT_OUTCOME } from "@/lib/asm/types";

// INV6 — closed vocabulary: the §9.3 map may only NARROW the existing enums.
describe("INV6_closed_vocabulary: §9.3 map is a subset of the existing enums", () => {
    it("every call label is a sheet disposition with the row's connect status", () => {
        for (const row of CALL_VOCAB) {
            for (const label of row.labels) {
                const hit = classifyDisposition(label);
                expect(hit?.isKnown, `${row.id}: ${label}`).toBe(true);
                expect(hit?.label).toBe(label);
                expect(hit?.connectStatus).toBe(row.connect);
            }
        }
    });

    it("every connected label sits in at least one of the row's buckets", () => {
        for (const row of CALL_VOCAB.filter((r) => r.buckets)) {
            for (const label of row.labels) {
                const inSome = row.buckets!.some((b) => CONNECTED_DISPOSITIONS[b].includes(label));
                expect(inSome, `${row.id}: ${label}`).toBe(true);
            }
        }
    });

    it("every status, lost reason and visit outcome is a member of its enum", () => {
        const statuses = new Set<string>([...LEAD_STATUS, NO_CHANGE]);
        const reasons = new Set<string>(LOST_REASON);
        for (const row of CALL_VOCAB) {
            row.status.options.forEach((s) => expect(statuses.has(s), s).toBe(true));
            Object.values(row.lostReasonByLabel).flat().forEach((r) => expect(reasons.has(r), r).toBe(true));
        }
        for (const row of VISIT_VOCAB) {
            row.outcomes.forEach((o) => expect(VISIT_OUTCOME).toContain(o));
            row.lostReasons.forEach((r) => expect(reasons.has(r), r).toBe(true));
            for (const rule of Object.values(row.statusByOutcome)) {
                rule.options.forEach((s) => expect(statuses.has(s), s).toBe(true));
            }
        }
    });

    it("every Hinglish alias points at a sheet label or a visit outcome", () => {
        for (const [alias, label] of Object.entries(HINGLISH_CALL_ALIASES)) {
            expect(classifyDisposition(label)?.isKnown, alias).toBe(true);
        }
        for (const outcome of Object.values(HINGLISH_VISIT_ALIASES)) {
            expect(VISIT_OUTCOME).toContain(outcome);
        }
    });

    it("is frozen", () => {
        expect(Object.isFrozen(CALL_VOCAB)).toBe(true);
        expect(Object.isFrozen(CALL_VOCAB[0].status.options)).toBe(true);
        expect(Object.isFrozen(HINGLISH_CALL_ALIASES)).toBe(true);
        expect(() => {
            (CALL_VOCAB as unknown as unknown[]).push({});
        }).toThrow();
    });

    it("matches the frozen snapshot (any change is a deliberate spec change)", () => {
        expect({ CALL_VOCAB, VISIT_VOCAB, HINGLISH_CALL_ALIASES, HINGLISH_VISIT_ALIASES }).toMatchSnapshot();
    });
});

describe("checkCallProposal", () => {
    it("UC-03: did not pick → no status change", () => {
        expect(checkCallProposal({ label: "Did not pick", connect: "not_connected" })).toEqual({
            ok: true, status: NO_CHANGE, lostReason: null, interest: null,
        });
    });

    it("not-connected may never propose a status", () => {
        expect(checkCallProposal({ label: "Switch off", connect: "not_connected", status: "Lost" }).ok).toBe(false);
    });

    it("UC-02: price high + Lost → price_high", () => {
        expect(
            checkCallProposal({ label: "Price High", connect: "connected", bucket: "Warm", status: "Lost" }),
        ).toEqual({ ok: true, status: "Lost", lostReason: "price_high", interest: null });
    });

    it("price high with no decision → asks", () => {
        const r = checkCallProposal({ label: "Price High", connect: "connected", bucket: "Warm" });
        expect(r.ok).toBe(false);
    });

    it("commercials explained without a temperature → asks warm or hot", () => {
        const r = checkCallProposal({ label: "Commercials Explained", connect: "connected" });
        expect(r).toEqual({ ok: false, question: "Is the dealer warm or hot?" });
    });

    it("commercials explained under Hot → Commercials_Explained", () => {
        const r = checkCallProposal({
            label: "Commercials Explained", connect: "connected", bucket: "Hot", status: "Commercials_Explained",
        });
        expect(r).toMatchObject({ ok: true, status: "Commercials_Explained" });
    });

    it("a bucket the label isn't filed under → asks", () => {
        expect(checkCallProposal({ label: "Price High", connect: "connected", bucket: "Hot" }).ok).toBe(false);
    });

    it("a status outside the row → asks, never guesses", () => {
        expect(
            checkCallProposal({ label: "As to Call Back", connect: "connected", bucket: "Cold", status: "Converted" }).ok,
        ).toBe(false);
    });

    it("quote sent proposes interest hot", () => {
        expect(
            checkCallProposal({ label: "Quotation Sent", connect: "connected", bucket: "Hot", status: "Awaiting_Customer_Decision" }),
        ).toMatchObject({ ok: true, interest: "hot" });
    });

    it("lost: shop closed → business_closed; a mismatched reason → asks", () => {
        expect(
            checkCallProposal({ label: "Business Closed", connect: "connected", bucket: "Lost", status: "Lost" }),
        ).toMatchObject({ ok: true, lostReason: "business_closed" });
        expect(
            checkCallProposal({ label: "Business Closed", connect: "connected", bucket: "Lost", status: "Lost", lostReason: "price_high" }).ok,
        ).toBe(false);
    });

    it("labels outside the map (e.g. REJECTED BY US, Deal Closed) → asks", () => {
        expect(checkCallProposal({ label: "REJECTED BY US", connect: "connected", bucket: "Lost", status: "Lost" }).ok).toBe(false);
        expect(checkCallProposal({ label: "Deal Closed", connect: "connected", bucket: "Converted" }).ok).toBe(false);
        expect(checkCallProposal({ label: "made up", connect: "connected" }).ok).toBe(false);
    });
});

describe("checkVisitProposal", () => {
    it("UC-01: productive → no status change", () => {
        expect(checkVisitProposal({ outcome: "productive" })).toMatchObject({ ok: true, status: NO_CHANGE });
    });

    it("commercials progressed must say explained or finalised", () => {
        expect(checkVisitProposal({ outcome: "commercials_progressed" }).ok).toBe(false);
        expect(
            checkVisitProposal({ outcome: "commercials_progressed", status: "Commercials_Finalised" }),
        ).toMatchObject({ ok: true, status: "Commercials_Finalised" });
    });

    it("dealer uninterested → asks keep open or Lost; Lost needs an allowed reason", () => {
        expect(checkVisitProposal({ outcome: "dealer_uninterested" }).ok).toBe(false);
        expect(checkVisitProposal({ outcome: "dealer_uninterested", status: NO_CHANGE })).toMatchObject({ ok: true });
        expect(checkVisitProposal({ outcome: "dealer_uninterested", status: "Lost" }).ok).toBe(false);
        expect(
            checkVisitProposal({ outcome: "dealer_uninterested", status: "Lost", lostReason: "not_interested" }),
        ).toMatchObject({ ok: true, lostReason: "not_interested" });
        expect(
            checkVisitProposal({ outcome: "dealer_uninterested", status: "Lost", lostReason: "business_closed" }).ok,
        ).toBe(false);
    });

    it("outcomes outside the map → asks", () => {
        expect(checkVisitProposal({ outcome: "scheduling_issue" }).ok).toBe(false);
        expect(checkVisitProposal({ outcome: "other" }).ok).toBe(false);
    });
});
