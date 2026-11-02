// "Assigned by AI" badge — the reason text pulled out of the system assignment remark.

import { describe, expect, it } from "vitest";
import { aiAssignmentDetail, SYSTEM_ASSIGNMENT_REMARK } from "@/lib/leads/assignmentRemark";

describe("aiAssignmentDetail", () => {
    it("keeps the reason after the dash, including the territory", () => {
        expect(
            aiAssignmentDetail(
                `${SYSTEM_ASSIGNMENT_REMARK} — Qualified lead, due 3 Nov, 11:00 am. Routed to the Patna territory ASM.`,
            ),
        ).toBe("Qualified lead, due 3 Nov, 11:00 am. Routed to the Patna territory ASM.");
    });

    it("returns null when there is no reason", () => {
        expect(aiAssignmentDetail(SYSTEM_ASSIGNMENT_REMARK)).toBeNull();
        expect(aiAssignmentDetail(null)).toBeNull();
    });
});
