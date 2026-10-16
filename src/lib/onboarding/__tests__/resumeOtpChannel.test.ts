import { describe, expect, it } from "vitest";

import { maskMobile, resumeOtpDryRun, resumeOtpMobile, resumeOtpSentWhere } from "../resumeOtpChannel";

describe("resume code goes to the mobile (ID 166 decision 5)", () => {
    it("reads a 10-digit Indian mobile out of what the form stored", () => {
        expect(resumeOtpMobile("9876543210")).toBe("9876543210");
        expect(resumeOtpMobile("+91 98765 43210")).toBe("9876543210");
        expect(resumeOtpMobile("09876543210")).toBe("9876543210");
        expect(resumeOtpMobile("919876543210")).toBe("9876543210");
    });

    it("refuses what is not a mobile, so the code falls back to email", () => {
        expect(resumeOtpMobile(null)).toBeNull();
        expect(resumeOtpMobile("")).toBeNull();
        expect(resumeOtpMobile("12345")).toBeNull();
        expect(resumeOtpMobile("0221234567")).toBeNull(); // a landline
        expect(resumeOtpMobile("5876543210")).toBeNull();
    });

    it("masks all but the last four digits", () => {
        expect(maskMobile("9876543210")).toBe("XXXXXX3210");
    });

    it("says where the code went", () => {
        expect(resumeOtpSentWhere("sms", "XXXXXX3210")).toBe("XXXXXX3210 by SMS");
        expect(resumeOtpSentWhere("call", "XXXXXX3210")).toBe("XXXXXX3210 by a phone call");
        expect(resumeOtpSentWhere("email", "j***@x.com")).toBe("j***@x.com by email");
    });

    it("never sends from tests, and OTP_DRY_RUN=1 stops sending anywhere", () => {
        expect(resumeOtpDryRun({ NODE_ENV: "test" })).toBe(true);
        expect(resumeOtpDryRun({ NODE_ENV: "production", OTP_DRY_RUN: "1" })).toBe(true);
        expect(resumeOtpDryRun({ NODE_ENV: "development", OTP_DRY_RUN: "true" })).toBe(true);
        expect(resumeOtpDryRun({ NODE_ENV: "production" })).toBe(false);
    });
});
