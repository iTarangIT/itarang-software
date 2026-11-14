// ID 227: NBFC upkeep can run its harmless half (emails + flags) without the wallet debits.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/email/sendManualHandoffEmail", () => ({ sendManualHandoffNudge: async () => {} }));
vi.mock("@/lib/nbfc/wallet/provider", () => ({ getWalletFundsProvider: async () => null }));
const { parseSteps } = await import("../route");

describe("parseSteps", () => {
    it("flags / wallet as asked; anything else is the old all-four run", () => {
        expect(parseSteps("flags")).toBe("flags");
        expect(parseSteps("wallet")).toBe("wallet");
        expect(parseSteps(null)).toBe("all");
        expect(parseSteps("everything")).toBe("all");
    });
});
