/**
 * The public file link (tracker ID 128): a path cannot climb out of its
 * bucket in any encoding, agreements are not public, the public upload only
 * writes to its own folders, and a signed link expires.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    FRESH_LINK_TTL_SECONDS,
    fileLinkSignature,
    fileLinkTooLong,
    fileLinkValid,
    filesProxyTarget,
    linkTtl,
    isPrivateDealerDocument,
    publicUploadFolder,
    safeStorageKey,
    safeUploadFileName,
    shareableFileUrl,
    signedFilePath,
} from "../fileAccess";
import { isStoredFileUrl, onFreshFileClick } from "../freshFileLink";

afterEach(() => vi.unstubAllEnvs());

describe("safeStorageKey", () => {
    it("passes ordinary keys through unchanged", () => {
        expect(safeStorageKey(["upload-gst-certificate", "1759-abc-GST (1).pdf"])).toBe(
            "upload-gst-certificate/1759-abc-GST (1).pdf",
        );
        expect(safeStorageKey(["kyc", "L-1", "pan_1759.jpg"])).toBe("kyc/L-1/pan_1759.jpg");
        // A literal percent sign in a name is not an encoding.
        expect(safeStorageKey(["a", "100%-report.pdf"])).toBe("a/100%-report.pdf");
    });

    it("refuses going up a folder, however it is written", () => {
        for (const bad of [
            ["..", "documents", "kyc", "x.jpg"],
            ["a", "..", "x.jpg"],
            ["%2e%2e", "documents", "x.jpg"],
            ["%2E%2E", "x.jpg"],
            ["%252e%252e", "x.jpg"],
            ["%25252e%25252e", "x.jpg"],
            [".%2e", "x.jpg"],
            ["a%2f..%2fdocuments", "x.jpg"],
            ["a%252f..%252fb", "x.jpg"],
            ["a/../b", "x.jpg"],
            ["a\\..\\b", "x.jpg"],
            ["a%5c..%5cb", "x.jpg"],
            [".", "x.jpg"],
            ["", "x.jpg"],
            ["a\0b", "x.jpg"],
            ["a%00b", "x.jpg"],
        ]) {
            expect(safeStorageKey(bad), JSON.stringify(bad)).toBeNull();
        }
        expect(safeStorageKey([])).toBeNull();
        expect(safeStorageKey(null)).toBeNull();
    });
});

describe("private folders inside dealer-documents", () => {
    it("agreements, audit trails and buyback evidence are private", () => {
        for (const key of [
            "agreements/8d2f/signed-agreement.pdf",
            "agreements/8d2f/audit-trail.pdf",
            "agreements/8d2f/files/1759-0-signed.pdf",
            "Agreements/8d2f/x.pdf",
            "buyback/B-1/pan.jpg",
            "dealer-signed-agreement-upload/x.pdf",
            "agreement-template-file/t.pdf",
            "8d2f/signed-agreement.pdf",
        ]) {
            expect(isPrivateDealerDocument(key), key).toBe(true);
        }
    });

    it("what a dealer uploads during onboarding stays public", () => {
        for (const key of [
            "upload-gst-certificate/1759-abc-gst.pdf",
            "owner-photograph/1759-abc-me.jpg",
            "4-undated-cheques/1759-abc-cheque.png",
            "visit-photos/1759-abc.jpg",
            "general/1759-abc-file.pdf",
        ]) {
            expect(isPrivateDealerDocument(key), key).toBe(false);
        }
    });
});

describe("the public upload", () => {
    it("accepts the folders the wizard sends", () => {
        for (const f of ["upload-gst-certificate", "4-undated-cheques", "owner-photograph", "visit-photos", "commercials"]) {
            expect(publicUploadFolder(f), f).toBe(f);
        }
        expect(publicUploadFolder(null)).toBe("general");
        expect(publicUploadFolder("")).toBe("general");
    });

    it("refuses a private folder, a nested path or anything that is not a slug", () => {
        for (const f of ["agreements", "buyback", "agreements/8d2f", "../documents", "a/b", "A-B", "a b", "a.b", "-a", "%2e%2e"]) {
            expect(publicUploadFolder(f), f).toBeNull();
        }
    });

    it("strips paths and odd characters from the file name", () => {
        expect(safeUploadFileName("my cheque (1).PDF")).toBe("my-cheque-(1).PDF");
        expect(safeUploadFileName("../../etc/passwd")).toBe("passwd");
        expect(safeUploadFileName("..\\..\\x.pdf")).toBe("x.pdf");
        expect(safeUploadFileName("a%2f..%2fb.pdf")).toBe("a_2f.._2fb.pdf");
        expect(safeUploadFileName("")).toBe("file");
        expect(safeUploadFileName("....")).toBe("file");
    });
});

describe("signed links", () => {
    const KEY = "agreements/8d2f/signed-agreement.pdf";

    it("a link is valid until it expires, for that file only", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const now = Date.UTC(2026, 9, 5, 10, 0, 0);
        const link = fileLinkSignature("dealer-documents", KEY, 3600, now)!;
        const ok = (key: string, exp: string | null, sig: string | null, at = now) =>
            fileLinkValid("dealer-documents", key, exp, sig, at);

        expect(ok(KEY, String(link.exp), link.sig)).toBe(true);
        expect(ok(KEY, String(link.exp), link.sig, now + 3599_000)).toBe(true);
        expect(ok(KEY, String(link.exp), link.sig, now + 3601_000)).toBe(false);
        // Another file, a stretched expiry, a wrong or missing signature.
        expect(ok("agreements/other/signed-agreement.pdf", String(link.exp), link.sig)).toBe(false);
        expect(ok(KEY, String(link.exp + 86400), link.sig)).toBe(false);
        expect(ok(KEY, String(link.exp), "0".repeat(64))).toBe(false);
        expect(ok(KEY, String(link.exp), null)).toBe(false);
        expect(ok(KEY, null, link.sig)).toBe(false);
        expect(fileLinkValid("documents", KEY, String(link.exp), link.sig, now)).toBe(false);
    });

    it("with no secret available nothing is signed and nothing validates", () => {
        vi.stubEnv("FILE_LINK_SECRET", "");
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
        expect(fileLinkSignature("dealer-documents", KEY, 3600)).toBeNull();
        expect(fileLinkValid("dealer-documents", KEY, "9999999999", "x")).toBe(false);
    });

    it("WhatsApp gets an absolute, signed link for any stored file", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const origin = "https://crm.test";
        const signed = shareableFileUrl(`/api/files/dealer-documents/${KEY}`, { origin })!;
        expect(signed).toMatch(
            /^https:\/\/crm\.test\/api\/files\/dealer-documents\/agreements\/8d2f\/signed-agreement\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/,
        );
        const q = new URL(signed).searchParams;
        expect(fileLinkValid("dealer-documents", KEY, q.get("exp"), q.get("sig"))).toBe(true);

        // ID 119: an onboarding upload is no longer public, so it is signed too.
        const photo = shareableFileUrl("/api/files/dealer-documents/owner-photograph/a.jpg", { origin })!;
        const pq = new URL(photo).searchParams;
        expect(photo.startsWith("https://crm.test/api/files/dealer-documents/owner-photograph/a.jpg?exp=")).toBe(true);
        expect(fileLinkValid("dealer-documents", "owner-photograph/a.jpg", pq.get("exp"), pq.get("sig"))).toBe(true);
        expect(shareableFileUrl("https://elsewhere.test/x.pdf", { origin })).toBe("https://elsewhere.test/x.pdf");
        expect(shareableFileUrl(null)).toBeNull();
    });
});

describe("signedFilePath (ID 119)", () => {
    it("signs a files-proxy path, stays relative, and validates for that file only", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const path = "/api/files/dealer-documents/last-3-years-itr/17849-abc-itr.pdf";
        const signed = signedFilePath(path, 3600)!;
        expect(signed).toMatch(/^\/api\/files\/dealer-documents\/last-3-years-itr\/17849-abc-itr\.pdf\?exp=\d+&sig=[0-9a-f]{64}$/);
        const q = new URL(signed, "https://x.test").searchParams;
        expect(fileLinkValid("dealer-documents", "last-3-years-itr/17849-abc-itr.pdf", q.get("exp"), q.get("sig"))).toBe(true);
        expect(fileLinkValid("documents", "last-3-years-itr/17849-abc-itr.pdf", q.get("exp"), q.get("sig"))).toBe(false);
        // An old signature on the stored path is replaced, not stacked.
        expect(signedFilePath(`${path}?exp=1&sig=old`, 3600)).not.toContain("sig=old");
    });

    it("leaves anything that is not a files-proxy path alone", () => {
        expect(signedFilePath("https://elsewhere.test/x.pdf", 3600)).toBe("https://elsewhere.test/x.pdf");
        expect(signedFilePath(null, 3600)).toBeNull();
    });
});

describe("the routes use these rules", () => {
    const read = (...parts: string[]) => readFileSync(join(process.cwd(), "src", ...parts), "utf8");

    it("the file link checks the path, then login-or-signature and the file rule, before it reads storage", () => {
        const route = read("app", "api", "files", "[bucket]", "[...path]", "route.ts");
        const keyAt = route.indexOf("safeStorageKey(segments)");
        const signAt = route.indexOf("fileLinkValid(");
        const authAt = route.indexOf("getAuthenticatedAppUser()");
        // ID 166: a login alone is not enough — the role / owner rule runs too.
        const ruleAt = route.indexOf("canOpenStoredFile(user, bucket, key)");
        const readAt = route.indexOf("readBucketObject(bucket, key)");
        expect(keyAt).toBeGreaterThan(-1);
        expect(signAt).toBeGreaterThan(keyAt);
        expect(authAt).toBeGreaterThan(signAt);
        expect(ruleAt).toBeGreaterThan(authAt);
        expect(readAt).toBeGreaterThan(ruleAt);
        expect(route).not.toMatch(/segments\.join\(/);
        // ID 119: no bucket is exempt from the login check any more.
        expect(route).not.toMatch(/AUTH_REQUIRED_BUCKETS/);
    });

    it("the public upload only writes to an allowed folder", () => {
        const route = read("app", "api", "uploads", "dealer-documents", "route.ts");
        expect(route).toMatch(/publicUploadFolder\(/);
        expect(route).toMatch(/safeUploadFileName\(/);
    });

    it("there is no fallback to the old storage any more (ID 166)", () => {
        const reader = read("lib", "storage", "readStoredDocument.ts");
        expect(reader).not.toMatch(/storageFallbackEnabled/);
        expect(reader).not.toMatch(/process\.env\.STORAGE_SUPABASE_FALLBACK/);
        // A miss on the active backend is a miss: one read, no second backend.
        const start = reader.indexOf("export async function readBucketObject");
        const fn = reader.slice(start, reader.indexOf("\n}", start));
        expect(fn.match(/getObject\(|fromSupabase\(/g)?.length).toBe(2); // the one ternary
        expect(fn).not.toMatch(/if \(!buf/);
    });

    it("a KYC signed link longer than 15 minutes is not honoured, and `by` is part of the check (ID 166)", () => {
        const route = read("app", "api", "files", "[bucket]", "[...path]", "route.ts");
        expect(route).toMatch(/isKycFile\(file\) && fileLinkTooLong\(exp\)/);
        expect(route).toContain('fileLinkValid(bucket, key, exp, req.nextUrl.searchParams.get("sig"), Date.now(), by)');
    });

    it("the fresh-link endpoint checks the file rule before it signs, for 15 minutes, for this user (ID 166)", () => {
        const route = read("app", "api", "files", "link", "route.ts");
        const authAt = route.indexOf("getAuthenticatedAppUser()");
        const ruleAt = route.indexOf("canOpenStoredFile(user, bucket, key)");
        const signAt = route.indexOf("signedFilePath(target.path, FRESH_LINK_TTL_SECONDS, { by: user.id })");
        expect(authAt).toBeGreaterThan(-1);
        expect(ruleAt).toBeGreaterThan(authAt);
        expect(signAt).toBeGreaterThan(ruleAt);
        expect(route).toMatch(/safeStorageKey\(/);
    });
});

describe("fresh 15-minute links (ID 166)", () => {
    const KYC = "kyc/LEAD-1/aadhaar_front_1.jpg";

    it("a link minted for a user validates only with that user", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const now = 1_800_000_000_000;
        const link = fileLinkSignature("documents", KYC, FRESH_LINK_TTL_SECONDS, now, "user-a")!;
        expect(fileLinkValid("documents", KYC, String(link.exp), link.sig, now, "user-a")).toBe(true);
        expect(fileLinkValid("documents", KYC, String(link.exp), link.sig, now, "user-b")).toBe(false);
        expect(fileLinkValid("documents", KYC, String(link.exp), link.sig, now)).toBe(false);
        // Dead after 15 minutes.
        expect(fileLinkValid("documents", KYC, String(link.exp), link.sig, now + 15 * 60_000 + 1000, "user-a")).toBe(false);
        // A link minted with no user (WhatsApp delivery) signs exactly as before.
        const plain = fileLinkSignature("documents", KYC, 60, now)!;
        expect(fileLinkValid("documents", KYC, String(plain.exp), plain.sig, now)).toBe(true);
    });

    it("signedFilePath carries the user and stays relative", () => {
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const signed = signedFilePath(`/api/files/documents/${KYC}`, FRESH_LINK_TTL_SECONDS, { by: "user-a" })!;
        expect(signed).toMatch(/^\/api\/files\/documents\/kyc\/LEAD-1\/aadhaar_front_1\.jpg\?exp=\d+&sig=[0-9a-f]{64}&by=user-a$/);
        const q = new URL(signed, "https://x.test").searchParams;
        expect(fileLinkValid("documents", KYC, q.get("exp"), q.get("sig"), Date.now(), q.get("by"))).toBe(true);
    });

    it("no signer gives a customer KYC file more than 15 minutes; other files keep their life", () => {
        expect(linkTtl("documents", KYC, 7 * 24 * 3600)).toBe(FRESH_LINK_TTL_SECONDS);
        expect(linkTtl("documents", KYC, 300)).toBe(300);
        expect(linkTtl("dealer-documents", "owner-photograph/a.jpg", 7 * 24 * 3600)).toBe(7 * 24 * 3600);
        vi.stubEnv("FILE_LINK_SECRET", "test-secret-0123456789");
        const kyc = new URL(shareableFileUrl(`/api/files/documents/${KYC}`, { origin: "https://crm.test", ttlSeconds: 3600 })!);
        expect(Number(kyc.searchParams.get("exp")) * 1000 - Date.now()).toBeLessThanOrEqual(FRESH_LINK_TTL_SECONDS * 1000 + 1000);
        const week = new URL(signedFilePath(`/api/files/documents/${KYC}`, 7 * 24 * 3600)!, "https://x.test");
        expect(Number(week.searchParams.get("exp")) * 1000 - Date.now()).toBeLessThanOrEqual(FRESH_LINK_TTL_SECONDS * 1000 + 1000);
    });

    it("fileLinkTooLong spots a link minted for longer than 15 minutes", () => {
        const now = 1_800_000_000_000;
        const s = Math.floor(now / 1000);
        expect(fileLinkTooLong(s + 15 * 60, undefined, now)).toBe(false);
        expect(fileLinkTooLong(s + 15 * 60 + 30, undefined, now)).toBe(false); // clock skew
        expect(fileLinkTooLong(s + 60 * 60, undefined, now)).toBe(true);
        expect(fileLinkTooLong(s + 7 * 24 * 3600, undefined, now)).toBe(true);
        expect(fileLinkTooLong("not-a-number", undefined, now)).toBe(true);
    });

    it("filesProxyTarget finds bucket and key in relative and absolute links", () => {
        expect(filesProxyTarget(`/api/files/documents/${KYC}?exp=1&sig=x`)).toEqual({
            path: `/api/files/documents/${KYC}`,
            bucket: "documents",
            key: KYC,
        });
        expect(filesProxyTarget(`https://crm.test/api/files/documents/${KYC}`)?.key).toBe(KYC);
        expect(filesProxyTarget("/api/files/documents/../x")).toBeNull();
        expect(filesProxyTarget("https://elsewhere.test/x.pdf")).toBeNull();
    });

    it("the click helper only takes over plain clicks on stored files", async () => {
        expect(isStoredFileUrl(`/api/files/documents/${KYC}`)).toBe(true);
        expect(isStoredFileUrl("https://crm.test/api/files/documents/a.pdf")).toBe(true);
        expect(isStoredFileUrl("/api/files/link?u=x")).toBe(false);
        expect(isStoredFileUrl("/api/nbfc-uploads/a.pdf")).toBe(false);
        expect(isStoredFileUrl(null)).toBe(false);

        const ev = (over: Record<string, unknown> = {}) => {
            const e = {
                prevented: false,
                preventDefault() {
                    e.prevented = true;
                },
                button: 0,
                ...over,
            };
            return e;
        };
        const openSpy = vi.fn(() => null);
        vi.stubGlobal("window", { open: openSpy, alert: vi.fn() });
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ url: "/signed" }), { status: 200 })));
        const ctrl = ev({ ctrlKey: true });
        onFreshFileClick(ctrl, `/api/files/documents/${KYC}`);
        expect(ctrl.prevented).toBe(false);
        const other = ev();
        onFreshFileClick(other, "https://elsewhere.test/x.pdf");
        expect(other.prevented).toBe(false);
        const plain = ev();
        onFreshFileClick(plain, `/api/files/documents/${KYC}`);
        expect(plain.prevented).toBe(true);
        expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
        // The pop-up was blocked (open returned null), so the signed link opens directly.
        await new Promise((r) => setTimeout(r, 0));
        expect(openSpy).toHaveBeenLastCalledWith("/signed", "_blank", "noopener,noreferrer");
        vi.unstubAllGlobals();
    });
});
