// Who may save what through the dealer onboarding form (tracker ID 129).
//
// POST /api/dealer/onboarding/submit needs no login — a prospective dealer has
// no account. It used to find "the existing application" by whatever the
// request said (an application id, the owner e-mail typed into the form, a
// dealer code) and overwrite the first match: company, owners, BANK ACCOUNT,
// documents, and the status back to "submitted". Anyone who knew a dealer's
// e-mail could replace their application; with the id, even an approved one.
//
// The rule now, in one pure function so it can be tested without a database:
//
//   - an application is only ever UPDATED by someone who proves it is theirs:
//     iTarang staff, the dealer login it belongs to, or a resume token issued
//     after a one-time code was sent to the e-mail ON THE APPLICATION;
//   - a match on a typed e-mail or dealer code never selects a row to update.
//     It only tells the caller an application exists and how to prove it;
//   - once an application is submitted (or approved, or locked) the form
//     cannot change it. Changes go through "Correction requested".
//
// No db import. node:crypto only.

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

/** Same list as GET /api/dealer-onboarding/[applicationId] — staff who complete an onboarding for a dealer. */
export const ONBOARDING_STAFF_ROLES: readonly string[] = ["admin", "sales_head", "ceo", "inside_sales_rep", "asm"];

/** Statuses in which the form may still write. `null` is a row that predates the column. */
export const FORM_EDITABLE_STATUSES: readonly string[] = ["draft", "correction_requested", "rejected"];

export type SubmitCaller =
    | { kind: "staff"; userId: string }
    | { kind: "dealer"; userId: string }
    | { kind: "anonymous"; userId: null };

export function callerFor(user: { id: string; role: string | null } | null): SubmitCaller {
    if (!user) return { kind: "anonymous", userId: null };
    return ONBOARDING_STAFF_ROLES.includes(user.role ?? "")
        ? { kind: "staff", userId: user.id }
        : { kind: "dealer", userId: user.id };
}

export type ApplicationRef = {
    id: string;
    dealer_user_id: string | null;
    onboarding_status: string | null;
    is_locked?: boolean | null;
};

export type SubmitDecision =
    | { action: "create" }
    | { action: "update"; applicationId: string }
    | { action: "refuse"; status: 409; code: "verify_required" | "locked"; message: string };

const VERIFY_MESSAGE =
    "An application already exists for these details. Verify with the code sent to the owner's registered email to continue it.";
const LOCKED_MESSAGE =
    "This application has already been submitted and is under review, so it cannot be changed from this form. " +
    "If something needs correcting, iTarang will send a correction request.";

export function decideSubmit(input: {
    caller: SubmitCaller;
    /** The row with the application id the request named, if it exists. */
    byId: ApplicationRef | null;
    /** A signed-in dealer's own latest application. Ignored for staff and anonymous callers. */
    byUser: ApplicationRef | null;
    /** The latest application that is NOT approved and matches the typed owner e-mail or dealer code. */
    byIdentity: ApplicationRef | null;
    /** The application id inside a valid resume token, else null. */
    resumeApplicationId: string | null;
}): SubmitDecision {
    const { caller } = input;
    const proven = (app: ApplicationRef) =>
        caller.kind === "staff" ||
        (caller.kind === "dealer" && !!app.dealer_user_id && app.dealer_user_id === caller.userId) ||
        input.resumeApplicationId === app.id;

    let target = input.byId;
    if (!target && caller.kind === "dealer" && input.byUser) {
        // A dealer's earlier, approved application does not stop a new one.
        if (input.byUser.onboarding_status !== "approved") target = input.byUser;
    }
    if (!target && input.byIdentity) {
        // Typed details never pick the row by themselves.
        if (!proven(input.byIdentity)) {
            return { action: "refuse", status: 409, code: "verify_required", message: VERIFY_MESSAGE };
        }
        target = input.byIdentity;
    }
    if (!target) return { action: "create" };

    if (!proven(target)) {
        return { action: "refuse", status: 409, code: "verify_required", message: VERIFY_MESSAGE };
    }
    const status = target.onboarding_status ?? "draft";
    if (target.is_locked || !FORM_EDITABLE_STATUSES.includes(status)) {
        return { action: "refuse", status: 409, code: "locked", message: LOCKED_MESSAGE };
    }
    return { action: "update", applicationId: target.id };
}

// ── one-time code ───────────────────────────────────────────────────────────
// Six digits: these endpoints are public, unlike the session-gated password
// change code (four digits, src/lib/auth/password-change-otp.ts).

export const RESUME_OTP_LENGTH = 6;
export const RESUME_OTP_TTL_MS = 10 * 60 * 1000;
export const RESUME_OTP_MAX_ATTEMPTS = 5;
/** Codes one application may be sent within RESUME_OTP_SEND_WINDOW_MS. */
export const RESUME_OTP_MAX_SENDS = 3;
export const RESUME_OTP_SEND_WINDOW_MS = 30 * 60 * 1000;
export const RESUME_OTP_FORMAT_RE = new RegExp(`^\\d{${RESUME_OTP_LENGTH}}$`);

export function generateResumeOtp(): string {
    return String(randomInt(0, 10 ** RESUME_OTP_LENGTH)).padStart(RESUME_OTP_LENGTH, "0");
}

/** Bound to the application, so a code for one application proves nothing about another. */
export function hashResumeOtp(applicationId: string, code: string): string {
    return createHash("sha256").update(`${applicationId}:${code}`).digest("hex");
}

/** j***@example.com — enough to recognise your own address, not to learn someone else's. */
export function maskEmail(email: string | null | undefined): string {
    const [local, domain] = (email ?? "").trim().split("@");
    if (!local || !domain) return "the registered email";
    return `${local[0]}${"*".repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}

// ── resume token ────────────────────────────────────────────────────────────
// Proof, for the next half hour, that the holder received the code sent to the
// e-mail on application <id>. `<id>.<exp>.<hmac>`.

export const RESUME_TOKEN_TTL_MS = 30 * 60 * 1000;

function tokenSecret(): string | null {
    const own = process.env.ONBOARDING_RESUME_SECRET?.trim();
    if (own) return own;
    const master = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    return master ? createHmac("sha256", master).update("onboarding-resume-v1").digest("hex") : null;
}

const mac = (secret: string, applicationId: string, exp: number) =>
    createHmac("sha256", secret).update(`${applicationId}.${exp}`).digest("hex");

export function signResumeToken(applicationId: string, now: number = Date.now()): string | null {
    const secret = tokenSecret();
    if (!secret) return null;
    const exp = now + RESUME_TOKEN_TTL_MS;
    return `${applicationId}.${exp}.${mac(secret, applicationId, exp)}`;
}

/** The application id a token is for, or null when it is missing, forged or expired. */
export function verifyResumeToken(token: string | null | undefined, now: number = Date.now()): string | null {
    const secret = tokenSecret();
    const parts = (token ?? "").split(".");
    if (!secret || parts.length !== 3) return null;
    const [applicationId, expRaw, sig] = parts;
    const exp = Number(expRaw);
    if (!applicationId || !Number.isInteger(exp) || exp < now) return null;
    const want = Buffer.from(mac(secret, applicationId, exp));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got) ? applicationId : null;
}

// ── what a submit may change ────────────────────────────────────────────────

export const BANK_FIELDS = ["bank_name", "account_number", "beneficiary_name", "ifsc_code"] as const;
export type BankDetails = Partial<Record<(typeof BANK_FIELDS)[number], string | null>>;

/** The bank fields that differ, old → new. Empty when nothing changed. */
export function bankChanges(
    before: BankDetails | null | undefined,
    after: BankDetails,
): Array<{ field: (typeof BANK_FIELDS)[number]; from: string | null; to: string | null }> {
    const norm = (v: string | null | undefined) => (v ?? "").trim() || null;
    return BANK_FIELDS.map((field) => ({ field, from: norm(before?.[field]), to: norm(after[field]) })).filter(
        (c) => c.from !== c.to,
    );
}

/** ••••1234 — for alerts and logs; the full number stays in the audit row. */
export function maskAccountNumber(value: string | null | undefined): string | null {
    const v = (value ?? "").replace(/\s+/g, "");
    if (!v) return null;
    return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}

export type StoredDocument = { id?: string; document_type: string; storage_path: string };

/**
 * Which stored documents a submit keeps, adds and replaces. A document whose
 * file is unchanged is left alone — its verification state with it. One that
 * the new submission no longer carries is REPLACED, never silently deleted:
 * the caller records it before removing the row, and the file stays in storage.
 */
export function planDocuments<E extends StoredDocument, N extends StoredDocument>(
    existing: readonly E[],
    incoming: readonly N[],
): { keep: E[]; add: N[]; replaced: E[] } {
    const key = (d: StoredDocument) => `${d.document_type}::${d.storage_path}`;
    const want = new Set(incoming.map(key));
    const have = new Set(existing.map(key));
    return {
        keep: existing.filter((d) => want.has(key(d))),
        add: incoming.filter((d) => !have.has(key(d))),
        replaced: existing.filter((d) => !want.has(key(d))),
    };
}
