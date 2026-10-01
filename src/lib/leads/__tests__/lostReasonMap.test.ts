import { describe, expect, it } from "vitest";
import { LOST_REASON_BY_LABEL, lostReasonForLabel } from "../autoProgress";
import { CONNECTED_DISPOSITIONS } from "../dispositions";
import { CALL_VOCAB } from "@/lib/assistant/vocab";
import { LOST_REASON } from "@/lib/lifecycle/transitions";

// ID 76: ONE map from a call outcome to its Lost reason — the forms' Mark Lost
// pre-fill and the WhatsApp Assistant's vocabulary are both built from it.
describe("lost-reason map (ID 76)", () => {
    it("every Lost-bucket outcome has a reason, and every reason is a real one", () => {
        for (const label of CONNECTED_DISPOSITIONS.Lost) {
            expect(lostReasonForLabel(label), label).not.toBeNull();
        }
        for (const reason of Object.values(LOST_REASON_BY_LABEL)) {
            expect(LOST_REASON).toContain(reason);
        }
    });

    it("REJECTED BY US pre-fills the credit reason (ID 76.2); an unmapped label is the rep's pick", () => {
        expect(lostReasonForLabel("REJECTED BY US")).toBe("rejected_by_us_credit");
        expect(lostReasonForLabel("Some other Business")).toBe("moved_to_other_business");
        expect(lostReasonForLabel("Details Shared")).toBeNull();
    });

    it("the Assistant's lost reasons are exactly the shared map's", () => {
        for (const row of CALL_VOCAB) {
            for (const [label, reasons] of Object.entries(row.lostReasonByLabel)) {
                expect(reasons, `${row.id}/${label}`).toEqual([LOST_REASON_BY_LABEL[label]]);
            }
        }
        const lost = CALL_VOCAB.find((r) => r.id === "lost")!;
        expect(lost.labels).toContain("Some other Business");
        expect(lost.lostReasonByLabel["Some other Business"]).toEqual(["moved_to_other_business"]);
    });
});
