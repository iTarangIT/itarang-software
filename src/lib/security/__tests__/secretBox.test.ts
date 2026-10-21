import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lastChars, open, seal, secretBoxEnabled } from "@/lib/security/secretBox";

// A32 — NeoDove endpoint URLs stored encrypted, bound to their row.

afterEach(() => vi.unstubAllEnvs());

describe("secretBox", () => {
    it("round-trips under the same AAD and refuses another row's AAD", () => {
        vi.stubEnv("APP_SECRETS_ENC_KEY", randomBytes(32).toString("base64"));
        const url = "https://api.neodove.com/integration/custom/abc123/leads";
        const s = seal(url, "neodove:NDC-1:push");
        expect(s.ciphertext).not.toContain("neodove");
        expect(open(s, "neodove:NDC-1:push")).toBe(url);
        expect(open(s, "neodove:NDC-2:push")).toBeNull();
    });

    it("a tampered value or a different key opens to null", () => {
        vi.stubEnv("APP_SECRETS_ENC_KEY", randomBytes(32).toString("base64"));
        const s = seal("secret", "a");
        expect(open({ ...s, ciphertext: Buffer.from("x").toString("base64") }, "a")).toBeNull();
        vi.stubEnv("APP_SECRETS_ENC_KEY", randomBytes(32).toString("base64"));
        expect(open(s, "a")).toBeNull();
    });

    it("falls back to the NBFC vault key; no key = disabled and seal refuses", () => {
        vi.stubEnv("APP_SECRETS_ENC_KEY", "");
        vi.stubEnv("NBFC_CREDENTIALS_ENC_KEY", randomBytes(32).toString("base64"));
        expect(secretBoxEnabled()).toBe(true);
        vi.stubEnv("NBFC_CREDENTIALS_ENC_KEY", "");
        expect(secretBoxEnabled()).toBe(false);
        expect(() => seal("x", "a")).toThrow(/APP_SECRETS_ENC_KEY/);
    });

    it("shows only the last characters", () => {
        expect(lastChars("https://x/abcd1234")).toBe("1234");
        expect(lastChars("ab")).toBe("••");
    });
});
