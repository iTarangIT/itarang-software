import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/notify", () => ({ notifyUser: vi.fn() }));

import { leadHrefFor, queueHrefFor } from "../newOwnerNotice";

describe("reassign notice links (12 Oct)", () => {
    it("an ASM opens the lead on the ASM page; everyone else on the lead working page", () => {
        expect(leadHrefFor("asm", "L1")).toBe("/asm/lead/L1");
        expect(leadHrefFor("ASM", "L1")).toBe("/asm/lead/L1");
        expect(leadHrefFor("inside_sales_rep", "L1")).toBe("/inside-sales/lead/L1");
        expect(leadHrefFor("partner", "L1")).toBe("/inside-sales/lead/L1");
        expect(leadHrefFor(null, "L1")).toBe("/inside-sales/lead/L1");
    });

    it("a bulk summary opens the person's queue", () => {
        expect(queueHrefFor("asm")).toBe("/asm");
        expect(queueHrefFor("inside_sales_rep")).toBe("/inside-sales");
    });
});
