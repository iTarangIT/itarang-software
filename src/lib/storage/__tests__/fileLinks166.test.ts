/**
 * Tracker ID 166 (2–4 Nov): links a screen hands out for stored files.
 *   - viewerFileLink / signFileLinksDeep: every one of OUR stored files in a
 *     response becomes a fresh 15-minute link for the viewer; provider links
 *     and other strings are left alone;
 *   - onboardingFileLink: a dealer with no login gets a 15-minute link signed
 *     for its application (`by = app:<id>`), onboarding buckets only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    fileLinkTooLong,
    fileLinkValid,
    isOnboardingLinkSubject,
    onboardingFileLink,
    signFileLinksDeep,
    viewerFileLink,
} from "../fileAccess";

const params = (url: string) => new URL(url, "https://crm.example").searchParams;

describe("viewer links (ID 166)", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("signs a stored file for the viewer, 15 minutes", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const link = viewerFileLink("/api/files/documents/kyc/LEAD-1/pan.jpg", "user-1")!;
        const q = params(link);
        expect(link.startsWith("/api/files/documents/kyc/LEAD-1/pan.jpg?")).toBe(true);
        expect(q.get("by")).toBe("user-1");
        expect(fileLinkValid("documents", "kyc/LEAD-1/pan.jpg", q.get("exp"), q.get("sig"), Date.now(), "user-1")).toBe(true);
        expect(fileLinkTooLong(q.get("exp"))).toBe(false);
    });

    it("leaves provider links, empty values and other strings alone", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        expect(viewerFileLink("https://provider.example/rec.mp3", "u")).toBe("https://provider.example/rec.mp3");
        expect(viewerFileLink(null, "u")).toBeNull();
        const out = signFileLinksDeep(
            {
                fileUrl: "/api/files/documents/a/b.pdf",
                nested: [{ api_response: { video_url: "/api/files/documents/v/x.mp4" } }],
                name: "ABCDE1234F",
                when: new Date(0),
                n: 3,
            },
            "user-9",
        );
        expect(params(out.fileUrl).get("by")).toBe("user-9");
        expect(params(out.nested[0].api_response.video_url).get("by")).toBe("user-9");
        expect(out.name).toBe("ABCDE1234F");
        expect(out.when).toBeInstanceOf(Date);
        expect(out.n).toBe(3);
    });

    it("an old Supabase address (video KYC rows) leaves as a fresh proxy link too (5 Nov)", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const legacy = "https://abcd.supabase.co/storage/v1/object/public/documents/kyc/LEAD-1/video.webm";
        const out = signFileLinksDeep({ api_response: { video_url: legacy } }, "user-3");
        const link = out.api_response.video_url;
        expect(link.startsWith("/api/files/documents/kyc/LEAD-1/video.webm?")).toBe(true);
        const q = params(link);
        expect(q.get("by")).toBe("user-3");
        expect(fileLinkValid("documents", "kyc/LEAD-1/video.webm", q.get("exp"), q.get("sig"), Date.now(), "user-3")).toBe(true);
        expect(viewerFileLink(legacy, "user-3")!.includes("supabase")).toBe(false);
        // an unknown bucket is not ours: left alone
        const other = "https://abcd.supabase.co/storage/v1/object/public/other-bucket/x.pdf";
        expect(viewerFileLink(other, "u")).toBe(other);
    });
});

describe("onboarding links for a dealer with no login (ID 166 decision 5)", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("signs for the application, 15 minutes, onboarding buckets only", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const link = onboardingFileLink("/api/files/dealer-documents/gst/1-abc-gst.pdf", "app-uuid")!;
        const q = params(link);
        expect(q.get("by")).toBe("app:app-uuid");
        expect(isOnboardingLinkSubject(q.get("by"))).toBe(true);
        expect(fileLinkValid("dealer-documents", "gst/1-abc-gst.pdf", q.get("exp"), q.get("sig"), Date.now(), "app:app-uuid")).toBe(true);
        // the subject is inside the signature: another application's id fails
        expect(fileLinkValid("dealer-documents", "gst/1-abc-gst.pdf", q.get("exp"), q.get("sig"), Date.now(), "app:other")).toBe(false);
        expect(fileLinkTooLong(q.get("exp"))).toBe(false);
        // a customer KYC file is never an onboarding file
        expect(onboardingFileLink("/api/files/documents/kyc/LEAD-1/pan.jpg", "app-uuid")).toBeNull();
    });

    it("a user id is not an application subject", () => {
        expect(isOnboardingLinkSubject("0b9f8a7e-0000-4000-8000-000000000000")).toBe(false);
        expect(isOnboardingLinkSubject("app:")).toBe(false);
        expect(isOnboardingLinkSubject(null)).toBe(false);
    });
});
