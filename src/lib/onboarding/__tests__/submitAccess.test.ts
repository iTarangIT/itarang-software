/**
 * Who may save what through the dealer onboarding form (tracker ID 129).
 *
 * The row's own test: "submit the public form with an existing in-progress
 * dealer's email; it must not touch that application."
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    bankChanges,
    callerFor,
    decideSubmit,
    generateResumeOtp,
    hashResumeOtp,
    maskAccountNumber,
    maskEmail,
    planDocuments,
    RESUME_OTP_FORMAT_RE,
    RESUME_TOKEN_TTL_MS,
    signResumeToken,
    verifyResumeToken,
    type ApplicationRef,
    type SubmitCaller,
} from "../submitAccess";

afterEach(() => vi.unstubAllEnvs());

const ANON: SubmitCaller = { kind: "anonymous", userId: null };
const DEALER: SubmitCaller = { kind: "dealer", userId: "dealer-1" };
const OTHER_DEALER: SubmitCaller = { kind: "dealer", userId: "dealer-2" };
const STAFF: SubmitCaller = { kind: "staff", userId: "staff-1" };

const app = (over: Partial<ApplicationRef> = {}): ApplicationRef => ({
    id: "app-1",
    dealer_user_id: null,
    onboarding_status: "draft",
    is_locked: false,
    ...over,
});
const none = { byId: null, byUser: null, byIdentity: null, resumeApplicationId: null };

describe("callerFor", () => {
    it("staff are the roles that complete an onboarding for a dealer; everyone else signed in is a dealer", () => {
        for (const role of ["admin", "sales_head", "ceo", "inside_sales_rep", "asm"]) {
            expect(callerFor({ id: "u", role }).kind, role).toBe("staff");
        }
        for (const role of ["dealer", "user", "nbfc_partner", "", null]) {
            expect(callerFor({ id: "u", role }).kind, String(role)).toBe("dealer");
        }
        expect(callerFor(null)).toEqual({ kind: "anonymous", userId: null });
    });
});

describe("the public form cannot take over someone else's application", () => {
    it("with no login and no match, it creates a new application", () => {
        expect(decideSubmit({ caller: ANON, ...none })).toEqual({ action: "create" });
    });

    it("typing an in-progress dealer's email (or dealer code) does not touch that application", () => {
        for (const status of ["draft", "submitted", "correction_requested", "rejected"]) {
            const d = decideSubmit({ caller: ANON, ...none, byIdentity: app({ onboarding_status: status }) });
            expect(d, status).toMatchObject({ action: "refuse", status: 409, code: "verify_required" });
        }
    });

    it("naming an application id proves nothing either — not in progress, and not approved", () => {
        expect(decideSubmit({ caller: ANON, ...none, byId: app() })).toMatchObject({
            action: "refuse",
            code: "verify_required",
        });
        expect(decideSubmit({ caller: ANON, ...none, byId: app({ onboarding_status: "approved" }) })).toMatchObject({
            action: "refuse",
        });
    });

    it("another dealer's login is no better than no login", () => {
        const theirs = app({ dealer_user_id: "dealer-1" });
        expect(decideSubmit({ caller: OTHER_DEALER, ...none, byId: theirs })).toMatchObject({
            action: "refuse",
            code: "verify_required",
        });
        expect(decideSubmit({ caller: OTHER_DEALER, ...none, byIdentity: theirs })).toMatchObject({
            action: "refuse",
            code: "verify_required",
        });
    });

    it("a resume token opens exactly the application it was issued for", () => {
        expect(decideSubmit({ caller: ANON, ...none, byIdentity: app(), resumeApplicationId: "app-1" })).toEqual({
            action: "update",
            applicationId: "app-1",
        });
        expect(decideSubmit({ caller: ANON, ...none, byId: app(), resumeApplicationId: "app-1" })).toEqual({
            action: "update",
            applicationId: "app-1",
        });
        // A token for another application is not proof for this one.
        expect(
            decideSubmit({ caller: ANON, ...none, byIdentity: app(), resumeApplicationId: "app-2" }),
        ).toMatchObject({ action: "refuse", code: "verify_required" });
    });
});

describe("who may update an application", () => {
    it("the dealer it belongs to, while it is still a draft or back for correction", () => {
        const mine = (status: string) => app({ dealer_user_id: "dealer-1", onboarding_status: status });
        for (const status of ["draft", "correction_requested", "rejected"]) {
            expect(decideSubmit({ caller: DEALER, ...none, byUser: mine(status) }), status).toEqual({
                action: "update",
                applicationId: "app-1",
            });
        }
    });

    it("staff, for any application still open to the form", () => {
        expect(decideSubmit({ caller: STAFF, ...none, byId: app() })).toEqual({
            action: "update",
            applicationId: "app-1",
        });
        // Staff with no id named start a new application; a typed email does not pick one for them silently...
        expect(decideSubmit({ caller: STAFF, ...none })).toEqual({ action: "create" });
        // ...but they are trusted to continue the open one it matches.
        expect(decideSubmit({ caller: STAFF, ...none, byIdentity: app() })).toEqual({
            action: "update",
            applicationId: "app-1",
        });
    });

    it("a row with no status yet counts as a draft", () => {
        expect(decideSubmit({ caller: STAFF, ...none, byId: app({ onboarding_status: null }) })).toEqual({
            action: "update",
            applicationId: "app-1",
        });
    });
});

describe("once submitted, the form cannot change it — for anyone", () => {
    it("submitted, approved and locked applications are refused even with proof", () => {
        const cases: Array<[string, ApplicationRef]> = [
            ["submitted", app({ onboarding_status: "submitted", dealer_user_id: "dealer-1" })],
            ["approved by id", app({ onboarding_status: "approved", dealer_user_id: "dealer-1" })],
            ["locked draft", app({ is_locked: true, dealer_user_id: "dealer-1" })],
        ];
        for (const [label, target] of cases) {
            for (const caller of [STAFF, DEALER]) {
                expect(decideSubmit({ caller, ...none, byId: target }), `${label} / ${caller.kind}`).toMatchObject({
                    action: "refuse",
                    status: 409,
                    code: "locked",
                });
            }
            expect(
                decideSubmit({ caller: ANON, ...none, byId: target, resumeApplicationId: target.id }),
                `${label} / token`,
            ).toMatchObject({ action: "refuse", code: "locked" });
        }
    });

    it("a dealer whose earlier application was approved may still start a new one", () => {
        const approved = app({ onboarding_status: "approved", dealer_user_id: "dealer-1" });
        expect(decideSubmit({ caller: DEALER, ...none, byUser: approved })).toEqual({ action: "create" });
    });
});

describe("one-time code and resume token", () => {
    it("the code is six digits and its hash is tied to the application", () => {
        for (let i = 0; i < 50; i++) expect(generateResumeOtp()).toMatch(RESUME_OTP_FORMAT_RE);
        expect(hashResumeOtp("app-1", "123456")).toBe(hashResumeOtp("app-1", "123456"));
        expect(hashResumeOtp("app-1", "123456")).not.toBe(hashResumeOtp("app-2", "123456"));
        expect(hashResumeOtp("app-1", "123456")).not.toContain("123456");
    });

    it("a token is valid for its application until it expires, and cannot be forged or re-pointed", () => {
        vi.stubEnv("ONBOARDING_RESUME_SECRET", "test-secret-0123456789");
        const now = Date.UTC(2026, 9, 5, 10, 0, 0);
        const token = signResumeToken("app-1", now)!;
        expect(verifyResumeToken(token, now)).toBe("app-1");
        expect(verifyResumeToken(token, now + RESUME_TOKEN_TTL_MS - 1000)).toBe("app-1");
        expect(verifyResumeToken(token, now + RESUME_TOKEN_TTL_MS + 1000)).toBeNull();

        const [, exp, sig] = token.split(".");
        expect(verifyResumeToken(`app-2.${exp}.${sig}`, now)).toBeNull();
        expect(verifyResumeToken(`app-1.${Number(exp) + 60_000}.${sig}`, now)).toBeNull();
        expect(verifyResumeToken(`app-1.${exp}.${"0".repeat(64)}`, now)).toBeNull();
        for (const bad of [null, undefined, "", "app-1", "a.b", "a.b.c.d"]) {
            expect(verifyResumeToken(bad, now), String(bad)).toBeNull();
        }

        vi.stubEnv("ONBOARDING_RESUME_SECRET", "another-secret-0123456789");
        expect(verifyResumeToken(token, now)).toBeNull();
    });

    it("with no secret available no token is issued or accepted", () => {
        vi.stubEnv("ONBOARDING_RESUME_SECRET", "");
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
        expect(signResumeToken("app-1")).toBeNull();
        expect(verifyResumeToken("app-1.9999999999999.abc")).toBeNull();
    });

    it("the address shown back is masked", () => {
        expect(maskEmail("rajesh@example.com")).toBe("r*****@example.com");
        expect(maskEmail("ab@example.com")).toBe("a**@example.com");
        expect(maskEmail("")).toBe("the registered email");
        expect(maskEmail(null)).toBe("the registered email");
    });
});

describe("bank details and documents", () => {
    it("reports exactly the bank fields that changed", () => {
        const before = { bank_name: "HDFC", account_number: "111122223333", beneficiary_name: "A", ifsc_code: "HDFC0001" };
        expect(bankChanges(before, { ...before })).toEqual([]);
        expect(bankChanges(before, { ...before, bank_name: " HDFC " })).toEqual([]);
        expect(bankChanges(before, { ...before, account_number: "999988887777" })).toEqual([
            { field: "account_number", from: "111122223333", to: "999988887777" },
        ]);
        expect(bankChanges(null, before).map((c) => c.field)).toEqual([
            "bank_name",
            "account_number",
            "beneficiary_name",
            "ifsc_code",
        ]);
    });

    it("an alert never carries a full account number", () => {
        expect(maskAccountNumber("111122223333")).toBe("••••3333");
        expect(maskAccountNumber("12 34")).toBe("••••");
        expect(maskAccountNumber(null)).toBeNull();
    });

    it("an unchanged document is kept; a replaced one is reported, not silently dropped", () => {
        const existing = [
            { id: "d1", document_type: "gst_certificate", storage_path: "a/gst-old.pdf" },
            { id: "d2", document_type: "company_pan", storage_path: "a/pan.pdf" },
            { id: "d3", document_type: "undated_cheques", storage_path: "a/cheque-old.png" },
        ];
        const incoming = [
            { document_type: "gst_certificate", storage_path: "a/gst-new.pdf" },
            { document_type: "company_pan", storage_path: "a/pan.pdf" },
        ];
        const plan = planDocuments(existing, incoming);
        expect(plan.keep.map((d) => d.id)).toEqual(["d2"]);
        expect(plan.add).toEqual([{ document_type: "gst_certificate", storage_path: "a/gst-new.pdf" }]);
        expect(plan.replaced.map((d) => d.id)).toEqual(["d1", "d3"]);
        // Nothing is lost: every existing row is either kept or reported.
        expect(plan.keep.length + plan.replaced.length).toBe(existing.length);
    });
});

describe("the submit route uses the rule", () => {
    const route = readFileSync(
        join(process.cwd(), "src", "app", "api", "dealer", "onboarding", "submit", "route.ts"),
        "utf8",
    );

    it("decides before it writes, and only writes the application it decided on", () => {
        const decideAt = route.indexOf("decideSubmit(");
        const writeAt = route.indexOf(".update(dealerOnboardingApplications)");
        expect(decideAt).toBeGreaterThan(-1);
        expect(writeAt).toBeGreaterThan(decideAt);
        // The old fallback to the id in the request is gone.
        expect(route).not.toMatch(/existingApplication\?\.id\s*\|\|\s*applicationId/);
    });

    it("no longer deletes every document, and takes the staff flag from the session", () => {
        expect(route).toMatch(/planDocuments\(/);
        expect(route).toMatch(/onboarding_documents_replaced/);
        expect(route).toMatch(/onboarding_bank_details_changed/);
        expect(route).toMatch(/isStaff && rawBody\.internalSubmission === true/);
        expect(route.match(/rawBody\.internalSubmission/g)?.length).toBe(1);
    });
});
