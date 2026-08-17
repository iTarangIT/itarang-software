/**
 * KYC auto-approval settings (E-242).
 *
 * Stored as one jsonb blob under the `kyc_auto_approval` key in `app_settings`
 * — the same generic key/value store used by `ai_caller_enabled`,
 * `intellicar_battery_thresholds` and `fx_rates_fallback`. A dedicated table
 * would buy nothing: this is a singleton read by one ticker and written by one
 * admin form.
 *
 * The read path merges the stored patch over DEFAULTS rather than trusting the
 * row to be complete, so adding a field here is not a data migration — rows
 * written before the field existed simply pick up its default.
 *
 * THE WINDOW IS STORED IN WHOLE MINUTES, not hours. Hours were the first cut,
 * but the moment the window can be set to 2 minutes the unit stops working: 2
 * minutes is 0.0333… hours recurring, so every read/write round-trip drifts and
 * "2 minutes" eventually stops being 2 minutes. Minutes are exact for every
 * value the form can express, and the one place that needs a duration
 * (`slaDueAtFrom`) multiplies up rather than down.
 *
 * `slaHours` is still READ for backward compatibility — any row saved before
 * this change carries it and must keep meaning what it meant.
 *
 * DEFAULTS ARE OFF. Deploying E-242 plus this code changes no behaviour until
 * an admin explicitly turns it on at /admin/settings/kyc-automation. That is
 * deliberate: the sweep accepts identity cards without calling the verification
 * providers, so it must never switch itself on as a side effect of a deploy.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

const SETTINGS_KEY = "kyc_auto_approval";

/** Hard bounds on the SLA window: 1 minute to 7 days. */
export const MIN_SLA_MINUTES = 1;
export const MAX_SLA_MINUTES = 7 * 24 * 60; // 10080

/**
 * The choices the form offers as one-click presets, in minutes. Any value in
 * range is still accepted — the form's "Custom…" option can express minutes,
 * hours or days, and short windows are genuinely useful for testing the sweep
 * without waiting hours for it to fire.
 */
export const SLA_PRESETS_MINUTES = [
    5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880,
] as const;

/**
 * The verification cards an admin can give their own window (E-244). Mirrors
 * `ADMIN_CARD_VERIFICATION_TYPES` in `final-decision.ts` — the sweep accepts
 * exactly these, so offering a window for anything else would be a setting that
 * does nothing.
 */
export const CARD_SLA_TYPES = ["aadhaar", "pan", "bank", "cibil", "rc"] as const;
export type CardSlaType = (typeof CARD_SLA_TYPES)[number];

/** What each card is called on the review screen, so the form matches it. */
export const CARD_SLA_LABELS: Record<CardSlaType, string> = {
    aadhaar: "Aadhaar Verification",
    pan: "PAN Verification",
    bank: "Bank Account Verification",
    cibil: "Equifax Credit Score",
    rc: "RC to Chassis (Vehicle)",
};

export type KycAutoApprovalSettings = {
    /** Master kill switch. Everything below is inert while this is false. */
    enabled: boolean;
    /** Whole minutes from dealer submission before the sweep may act. */
    slaMinutes: number;
    /**
     * Per-card overrides of `slaMinutes`, in whole minutes (E-244). A card
     * absent from this map inherits `slaMinutes`, which is why the map is
     * partial rather than a complete record defaulted to the global value —
     * "inherit" has to survive a later change to the global window, and a
     * materialised copy of it would silently stop tracking.
     *
     * Each card is accepted on its OWN deadline, and the case is only finally
     * approved once the last of them has passed. So a 1-hour Equifax window on
     * a 20-minute case does not just delay that card, it delays the approval —
     * which is the point: approving the case while a card is still inside its
     * review window would make the window meaningless.
     */
    cardSlaMinutes: Partial<Record<CardSlaType, number>>;
    /** Verify consent the moment it is signed, with no admin click. */
    autoVerifyConsent: boolean;
    /** Accept still-pending verification cards when the SLA expires. */
    autoApproveCards: boolean;
    /** Mark required supporting-doc requests verified when the SLA expires. */
    autoVerifyRequiredDocs: boolean;
    /** Run the final approve (this is what unlocks the dealer's Step 4). */
    autoFinalApprove: boolean;
};

export const DEFAULT_KYC_AUTO_APPROVAL_SETTINGS: KycAutoApprovalSettings = {
    enabled: false,
    slaMinutes: 240, // 4 hours
    // Empty = every card inherits the global window, which is exactly how the
    // feature behaved before E-244.
    cardSlaMinutes: {},
    autoVerifyConsent: true,
    autoApproveCards: true,
    autoVerifyRequiredDocs: true,
    autoFinalApprove: true,
};

function toBool(raw: unknown, fallback: boolean): boolean {
    return typeof raw === "boolean" ? raw : fallback;
}

/** Clamp to [MIN, MAX] and round to a whole minute. Unparseable → default. */
export function clampSlaMinutes(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_KYC_AUTO_APPROVAL_SETTINGS.slaMinutes;
    return Math.min(MAX_SLA_MINUTES, Math.max(MIN_SLA_MINUTES, Math.round(n)));
}

/**
 * Render a minute count the way a human would say it. Used by the form, the
 * admin notification and the auto-action note written onto each card, so all
 * three describe the same window in the same words.
 */
export function formatSlaWindow(minutes: number): string {
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

    if (minutes % 1440 === 0) {
        const d = minutes / 1440;
        return `${d} day${d === 1 ? "" : "s"}`;
    }
    if (minutes % 60 === 0) {
        const h = minutes / 60;
        return `${h} hour${h === 1 ? "" : "s"}`;
    }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}m`;
}

/**
 * Normalise whatever is in the jsonb column into a complete settings object.
 * Exported so the API route can validate a PUT body through the same funnel
 * the reader uses — one place decides what a valid setting is.
 *
 * `slaMinutes` wins when present; `slaHours` is the legacy shape and is only
 * consulted when it is not, so a row written before the unit change keeps
 * meaning exactly what it meant.
 */
/**
 * Normalise the per-card window map (E-244).
 *
 * Absent, null, empty string and unparseable all mean the SAME thing — "inherit
 * the global window" — and are dropped rather than stored, so the map only ever
 * contains real overrides. That is what lets the form send `{cibil: null}` to
 * clear one card back to the default without a separate delete call.
 *
 * Unknown keys are discarded: a card that the sweep does not accept cannot be
 * given a window, or the form would show a setting with no effect.
 */
function normalizeCardSlaMinutes(
    raw: unknown,
    base: Partial<Record<CardSlaType, number>>,
): Partial<Record<CardSlaType, number>> {
    if (raw === undefined) return { ...base };
    const patch = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

    const out: Partial<Record<CardSlaType, number>> = {};
    for (const type of CARD_SLA_TYPES) {
        // A key present in the patch wins — including a null/empty one, which
        // is how a card is cleared back to the global window.
        const value = Object.hasOwn(patch, type) ? patch[type] : base[type];
        if (value === null || value === undefined || value === "") continue;
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        out[type] = clampSlaMinutes(n);
    }
    return out;
}

export function normalizeKycAutoApprovalSettings(
    raw: unknown,
    base: KycAutoApprovalSettings = DEFAULT_KYC_AUTO_APPROVAL_SETTINGS,
): KycAutoApprovalSettings {
    const patch = (raw && typeof raw === "object" ? raw : {}) as Partial<
        Record<keyof KycAutoApprovalSettings | "slaHours", unknown>
    >;

    let slaMinutes = base.slaMinutes;
    if (patch.slaMinutes !== undefined) {
        slaMinutes = clampSlaMinutes(patch.slaMinutes);
    } else if (patch.slaHours !== undefined) {
        const hours = Number(patch.slaHours);
        if (Number.isFinite(hours)) slaMinutes = clampSlaMinutes(hours * 60);
    }

    return {
        enabled: toBool(patch.enabled, base.enabled),
        slaMinutes,
        cardSlaMinutes: normalizeCardSlaMinutes(patch.cardSlaMinutes, base.cardSlaMinutes),
        autoVerifyConsent: toBool(patch.autoVerifyConsent, base.autoVerifyConsent),
        autoApproveCards: toBool(patch.autoApproveCards, base.autoApproveCards),
        autoVerifyRequiredDocs: toBool(
            patch.autoVerifyRequiredDocs,
            base.autoVerifyRequiredDocs,
        ),
        autoFinalApprove: toBool(patch.autoFinalApprove, base.autoFinalApprove),
    };
}

/**
 * Read the current settings. Never throws — a DB hiccup on this path must not
 * take down the dealer's submit route (which reads it to stamp the deadline) or
 * a consent save. Failing closed to `enabled: false` is the safe direction: the
 * worst case is that a case waits for a human, which is today's behaviour.
 */
export async function getKycAutoApprovalSettings(): Promise<KycAutoApprovalSettings> {
    try {
        const [row] = await db
            .select({ value: appSettings.value })
            .from(appSettings)
            .where(eq(appSettings.key, SETTINGS_KEY))
            .limit(1);
        return normalizeKycAutoApprovalSettings(row?.value);
    } catch (err) {
        console.error("[kyc-auto-approval] failed to read settings:", err);
        return { ...DEFAULT_KYC_AUTO_APPROVAL_SETTINGS };
    }
}

/**
 * Merge a partial patch over the current settings and persist the whole object.
 * Stores the complete blob (not the patch) so a reader never has to know which
 * generation of the shape it is looking at — which also means the legacy
 * `slaHours` key is dropped the first time a row is re-saved.
 */
export async function setKycAutoApprovalSettings(
    patch: Partial<KycAutoApprovalSettings>,
): Promise<KycAutoApprovalSettings> {
    const current = await getKycAutoApprovalSettings();
    const next = normalizeKycAutoApprovalSettings(patch, current);
    const now = new Date();

    await db
        .insert(appSettings)
        .values({ key: SETTINGS_KEY, value: next, updated_at: now })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: { value: next, updated_at: now },
        });

    return next;
}

/**
 * The deadline to stamp on a queue row at dealer submit, or null when the
 * feature is off — the sweep skips NULL, so a case submitted while disabled can
 * never be auto-approved later by simply flipping the switch on.
 */
export function slaDueAtFrom(
    submittedAt: Date,
    settings: KycAutoApprovalSettings,
): Date | null {
    if (!settings.enabled) return null;
    return new Date(submittedAt.getTime() + settings.slaMinutes * 60_000);
}

/** The window that applies to one card: its own override, else the global one. */
export function cardSlaMinutesFor(
    type: CardSlaType,
    settings: KycAutoApprovalSettings,
): number {
    return settings.cardSlaMinutes[type] ?? settings.slaMinutes;
}

/** The per-card deadline map to snapshot on the queue row. Null while off. */
export function cardSlaDueAtFrom(
    submittedAt: Date,
    settings: KycAutoApprovalSettings,
): Record<CardSlaType, string> | null {
    if (!settings.enabled) return null;
    const out = {} as Record<CardSlaType, string>;
    for (const type of CARD_SLA_TYPES) {
        out[type] = new Date(
            submittedAt.getTime() + cardSlaMinutesFor(type, settings) * 60_000,
        ).toISOString();
    }
    return out;
}

/**
 * Everything the queue row needs stamping at dealer submit (E-244).
 *
 * ONE FUNCTION BECAUSE THE THREE VALUES MUST AGREE. `sla_due_at` is the case
 * deadline, `sla_card_due_at` is the per-card snapshot, and `sla_next_due_at`
 * is the scheduler's pointer at the earliest of them all — the sweep selects on
 * that pointer, so a row whose pointer disagreed with its deadlines would
 * either be visited too early every tick or never visited at all.
 *
 * THE SNAPSHOT IS THE POINT. Resolving the per-card windows here, at submit,
 * rather than reading the settings when the sweep runs, is what keeps the
 * promise the settings screen makes: changing a window only affects cases
 * submitted from now on, and a case already in the queue keeps the deadlines it
 * was admitted under.
 *
 * All three are null while the feature is off, and every sweep predicate skips
 * null, so enabling it can never reach back over existing cases.
 */
export function slaStampFor(
    submittedAt: Date,
    settings: KycAutoApprovalSettings,
): {
    sla_due_at: Date | null;
    sla_card_due_at: Record<CardSlaType, string> | null;
    sla_next_due_at: Date | null;
} {
    const caseDue = slaDueAtFrom(submittedAt, settings);
    const cardDue = cardSlaDueAtFrom(submittedAt, settings);

    let next: Date | null = caseDue;
    if (cardDue) {
        for (const iso of Object.values(cardDue)) {
            const t = new Date(iso);
            if (!next || t.getTime() < next.getTime()) next = t;
        }
    }

    return { sla_due_at: caseDue, sla_card_due_at: cardDue, sla_next_due_at: next };
}
