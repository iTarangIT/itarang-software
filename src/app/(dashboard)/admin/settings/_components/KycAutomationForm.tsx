"use client";

// E-246 — KYC auto-approval SLA. Lets an admin decide how long a submitted case
// waits for a human before the system clears it itself.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** E-248 — the cards that can carry their own window. Order = the review screen. */
const CARD_TYPES = ["aadhaar", "pan", "bank", "cibil", "rc"] as const;
type CardType = (typeof CARD_TYPES)[number];

const CARD_LABELS: Record<CardType, string> = {
    aadhaar: "Aadhaar Verification",
    pan: "PAN Verification",
    bank: "Bank Account Verification",
    cibil: "Equifax Credit Score",
    rc: "RC to Chassis (Vehicle)",
};

type Settings = {
    enabled: boolean;
    /** Whole minutes. See the note on units in lib/kyc/auto-approval-settings. */
    slaMinutes: number;
    /**
     * E-248 — per-card overrides in whole minutes. A card absent from the map
     * (or set to null on the way to the server) inherits `slaMinutes`, so the
     * default keeps tracking a later change to the global window.
     */
    cardSlaMinutes: Partial<Record<CardType, number>>;
    autoVerifyConsent: boolean;
    autoApproveCards: boolean;
    autoVerifyRequiredDocs: boolean;
    autoFinalApprove: boolean;
};

const MIN_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60;

/** One-click windows, in minutes. Anything else goes through Custom. */
const PRESETS = [5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880];

const UNITS = [
    { key: "minutes", label: "minutes", mult: 1 },
    { key: "hours", label: "hours", mult: 60 },
    { key: "days", label: "days", mult: 1440 },
] as const;

type UnitKey = (typeof UNITS)[number]["key"];

function formatWindow(minutes: number): string {
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    if (minutes % 1440 === 0) {
        const d = minutes / 1440;
        return `${d} day${d === 1 ? "" : "s"}`;
    }
    if (minutes % 60 === 0) {
        const h = minutes / 60;
        return `${h} hour${h === 1 ? "" : "s"}`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Pick the largest unit that divides the value exactly, so 120 → "2 hours". */
function splitMinutes(minutes: number): { value: number; unit: UnitKey } {
    if (minutes % 1440 === 0) return { value: minutes / 1440, unit: "days" };
    if (minutes % 60 === 0) return { value: minutes / 60, unit: "hours" };
    return { value: minutes, unit: "minutes" };
}

const SUB_TOGGLES: { key: keyof Settings; label: string; hint: string }[] = [
    {
        key: "autoVerifyConsent",
        label: "Auto-verify consent on signature",
        hint: "The moment the customer signs, mark the consent verified — no waiting period and no admin click. OTP consents have always self-verified; this covers the e-sign and manual-upload paths.",
    },
    {
        key: "autoApproveCards",
        label: "Auto-accept pending verification cards",
        hint: "Aadhaar, PAN, bank, credit score and RC. Only cards nobody has touched — a card you rejected, or asked for documents on, is left exactly as you left it.",
    },
    {
        key: "autoVerifyRequiredDocs",
        label: "Auto-verify required supporting documents",
        hint: "Step 3 document requests marked required. Optional ones never blocked approval anyway, and rejected ones are left alone.",
    },
    {
        key: "autoFinalApprove",
        label: "Auto-approve the KYC case",
        hint: "Run the final Approve, which is what unlocks the dealer's Step 4. Turn this off to have the cards cleared for you but keep the last decision yourself.",
    },
];

export function KycAutomationForm() {
    const qc = useQueryClient();
    const [draft, setDraft] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);

    // Custom entry is held separately so typing "1" on the way to "15" doesn't
    // get clamped to the minimum under the user's cursor.
    const [isCustom, setIsCustom] = useState(false);
    const [customValue, setCustomValue] = useState("30");
    const [customUnit, setCustomUnit] = useState<UnitKey>("minutes");

    // Same idea per card (E-248), plus which cards are showing the custom
    // controls at all — a card can hold 20 minutes while the dropdown is on a
    // preset, so "is custom" cannot be derived from the value alone.
    const [cardCustomOpen, setCardCustomOpen] = useState<Partial<Record<CardType, boolean>>>({});
    const [cardCustomDraft, setCardCustomDraft] = useState<
        Partial<Record<CardType, { value: string; unit: UnitKey }>>
    >({});

    const { data, isLoading } = useQuery({
        queryKey: ["kyc-automation-settings"],
        queryFn: async () => {
            const res = await fetch("/api/admin/settings/kyc-automation");
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json?.error?.message ?? "Failed to load KYC automation settings");
            }
            return json.data.settings as Settings;
        },
    });

    // Seed the custom controls from whatever is stored, once it arrives.
    useEffect(() => {
        if (!data) return;
        const { value, unit } = splitMinutes(data.slaMinutes);
        setCustomValue(String(value));
        setCustomUnit(unit);
        setIsCustom(!PRESETS.includes(data.slaMinutes));

        const open: Partial<Record<CardType, boolean>> = {};
        const drafts: Partial<Record<CardType, { value: string; unit: UnitKey }>> = {};
        for (const type of CARD_TYPES) {
            const minutes = data.cardSlaMinutes?.[type];
            if (minutes === undefined || minutes === null) continue;
            const split = splitMinutes(minutes);
            drafts[type] = { value: String(split.value), unit: split.unit };
            open[type] = !PRESETS.includes(minutes);
        }
        setCardCustomOpen(open);
        setCardCustomDraft(drafts);
    }, [data]);

    const settings = draft ?? data ?? null;

    function patch(next: Partial<Settings>) {
        if (!settings) return;
        setDraft({ ...settings, ...next });
    }

    function applyCustom(rawValue: string, unit: UnitKey) {
        const mult = UNITS.find((u) => u.key === unit)!.mult;
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n <= 0) return; // let them keep typing
        patch({ slaMinutes: Math.round(n * mult) });
    }

    /** Set one card's window, or clear it back to the global one with null. */
    function patchCard(type: CardType, minutes: number | null) {
        if (!settings) return;
        const next = { ...settings.cardSlaMinutes };
        if (minutes === null) delete next[type];
        else next[type] = minutes;
        patch({ cardSlaMinutes: next });
    }

    function applyCardCustom(type: CardType, rawValue: string, unit: UnitKey) {
        setCardCustomDraft((d) => ({ ...d, [type]: { value: rawValue, unit } }));
        const mult = UNITS.find((u) => u.key === unit)!.mult;
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n <= 0) return; // let them keep typing
        patchCard(type, Math.round(n * mult));
    }

    async function save() {
        if (!settings) return;
        const m = settings.slaMinutes;
        if (!Number.isInteger(m) || m < MIN_MINUTES || m > MAX_MINUTES) {
            toast.error("The review window must be between 1 minute and 7 days.");
            return;
        }
        for (const type of CARD_TYPES) {
            const v = settings.cardSlaMinutes?.[type];
            if (v !== undefined && (!Number.isInteger(v) || v < MIN_MINUTES || v > MAX_MINUTES)) {
                toast.error(`${CARD_LABELS[type]}: the window must be between 1 minute and 7 days.`);
                return;
            }
        }
        setSaving(true);
        try {
            // Send every card explicitly, null meaning "back to the default".
            // Omitting a key would leave the stored override in place, so a
            // cleared card has to say so.
            const cardSlaMinutes = Object.fromEntries(
                CARD_TYPES.map((t) => [t, settings.cardSlaMinutes?.[t] ?? null]),
            );
            const res = await fetch("/api/admin/settings/kyc-automation", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, cardSlaMinutes }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Save failed");
            setDraft(null);
            qc.invalidateQueries({ queryKey: ["kyc-automation-settings"] });
            toast.success(`Saved. Cases now auto-approve after ${formatWindow(m)}.`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

    if (isLoading || !settings) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading KYC automation settings…
            </div>
        );
    }

    const dirty = draft !== null;
    const selectValue = isCustom ? "custom" : String(settings.slaMinutes);

    return (
        <div className="space-y-6">
            {/* Master switch */}
            <div className="rounded-lg border border-border bg-surface-subtle p-4">
                <label className="flex cursor-pointer items-start gap-3">
                    <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={settings.enabled}
                        onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    <span>
                        <span className="block text-sm font-medium text-ink">
                            Enable KYC auto-approval
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                            Off by default. While this is off nothing below applies and every
                            case waits for a human, as it does today.
                        </span>
                    </span>
                </label>

                {settings.enabled && (
                    <div className="mt-3 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            <strong>Auto-accepted cards are not verified cards.</strong> The
                            system marks Aadhaar, PAN, bank and credit-score cards accepted{" "}
                            <em>without calling the verification providers</em> — no Decentro
                            check, no DigiLocker pull. Leads will reach product selection and
                            NBFC routing carrying identity data nobody confirmed. Every
                            auto-action is stamped as a system action and written to the audit
                            log.
                        </span>
                    </div>
                )}
            </div>

            {/* SLA window */}
            <div className="space-y-2">
                <label className="block text-sm font-medium text-ink">
                    Manual review window
                </label>
                <p className="text-xs text-ink-muted">
                    Measured in plain wall-clock time from the dealer&apos;s submission —
                    nights, weekends and holidays all count.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                    <select
                        className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                        value={selectValue}
                        disabled={!settings.enabled}
                        onChange={(e) => {
                            if (e.target.value === "custom") {
                                setIsCustom(true);
                                const { value, unit } = splitMinutes(settings.slaMinutes);
                                setCustomValue(String(value));
                                setCustomUnit(unit);
                                return;
                            }
                            setIsCustom(false);
                            patch({ slaMinutes: Number(e.target.value) });
                        }}
                    >
                        {PRESETS.map((m) => (
                            <option key={m} value={String(m)}>
                                {formatWindow(m)}
                            </option>
                        ))}
                        <option value="custom">Custom…</option>
                    </select>

                    {isCustom && (
                        <>
                            <Input
                                type="number"
                                min="1"
                                step="1"
                                className="w-24"
                                value={customValue}
                                disabled={!settings.enabled}
                                onChange={(e) => {
                                    setCustomValue(e.target.value);
                                    applyCustom(e.target.value, customUnit);
                                }}
                            />
                            <select
                                className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                                value={customUnit}
                                disabled={!settings.enabled}
                                onChange={(e) => {
                                    const u = e.target.value as UnitKey;
                                    setCustomUnit(u);
                                    applyCustom(customValue, u);
                                }}
                            >
                                {UNITS.map((u) => (
                                    <option key={u.key} value={u.key}>
                                        {u.label}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}

                    <span className="text-xs font-medium text-ink-muted">
                        = {formatWindow(settings.slaMinutes)}
                    </span>
                </div>

                <p className="text-xs text-ink-muted">
                    Anything from <strong>1 minute to 7 days</strong>. Short windows are handy
                    for testing the sweep — it runs every 60 seconds, so a 2-minute window
                    fires within about three. Changing this only affects cases submitted from
                    now on; a case already in the queue keeps the deadline it was admitted
                    under.
                </p>
            </div>

            {/* Per-card windows (E-248) */}
            <div className="space-y-2">
                <label className="block text-sm font-medium text-ink">
                    Per-card windows
                </label>
                <p className="text-xs text-ink-muted">
                    Each verification card can wait longer, or clear sooner, than the case
                    itself — 20 minutes for Aadhaar and an hour for the credit score, say.
                    Every card left on <strong>Default</strong> follows the review window
                    above, including when you change it later.
                </p>

                <div className="divide-y divide-border rounded-lg border border-border">
                    {CARD_TYPES.map((type) => {
                        const override = settings.cardSlaMinutes?.[type];
                        const effective = override ?? settings.slaMinutes;
                        const isCardCustom = Boolean(cardCustomOpen[type]);
                        const draft = cardCustomDraft[type] ?? { value: "30", unit: "minutes" as UnitKey };
                        const selectValue =
                            override === undefined
                                ? "default"
                                : isCardCustom
                                  ? "custom"
                                  : String(override);

                        return (
                            <div
                                key={type}
                                className="flex flex-wrap items-center gap-2 px-3 py-2"
                            >
                                <span className="min-w-[190px] flex-1 text-sm text-ink">
                                    {CARD_LABELS[type]}
                                </span>

                                <select
                                    className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                                    value={selectValue}
                                    disabled={!settings.enabled || !settings.autoApproveCards}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        if (v === "default") {
                                            setCardCustomOpen((o) => ({ ...o, [type]: false }));
                                            patchCard(type, null);
                                            return;
                                        }
                                        if (v === "custom") {
                                            setCardCustomOpen((o) => ({ ...o, [type]: true }));
                                            const split = splitMinutes(effective);
                                            setCardCustomDraft((d) => ({
                                                ...d,
                                                [type]: { value: String(split.value), unit: split.unit },
                                            }));
                                            patchCard(type, effective);
                                            return;
                                        }
                                        setCardCustomOpen((o) => ({ ...o, [type]: false }));
                                        patchCard(type, Number(v));
                                    }}
                                >
                                    <option value="default">
                                        Default ({formatWindow(settings.slaMinutes)})
                                    </option>
                                    {PRESETS.map((m) => (
                                        <option key={m} value={String(m)}>
                                            {formatWindow(m)}
                                        </option>
                                    ))}
                                    <option value="custom">Custom…</option>
                                </select>

                                {isCardCustom && (
                                    <>
                                        <Input
                                            type="number"
                                            min="1"
                                            step="1"
                                            className="w-20"
                                            value={draft.value}
                                            disabled={!settings.enabled || !settings.autoApproveCards}
                                            onChange={(e) =>
                                                applyCardCustom(type, e.target.value, draft.unit)
                                            }
                                        />
                                        <select
                                            className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink disabled:opacity-50"
                                            value={draft.unit}
                                            disabled={!settings.enabled || !settings.autoApproveCards}
                                            onChange={(e) =>
                                                applyCardCustom(
                                                    type,
                                                    draft.value,
                                                    e.target.value as UnitKey,
                                                )
                                            }
                                        >
                                            {UNITS.map((u) => (
                                                <option key={u.key} value={u.key}>
                                                    {u.label}
                                                </option>
                                            ))}
                                        </select>
                                    </>
                                )}

                                <span className="w-24 text-right text-xs font-medium text-ink-muted">
                                    = {formatWindow(effective)}
                                </span>
                            </div>
                        );
                    })}
                </div>

                <p className="text-xs text-ink-muted">
                    Each card is accepted on its own clock, and the case is only approved once
                    the <strong>last</strong> window has closed — approving it while a card is
                    still inside its window would make that window meaningless. So the longest
                    window here decides when the dealer&apos;s Step 4 unlocks. Needs{" "}
                    <em>Auto-accept pending verification cards</em> below to be on. As with the
                    review window, a change only affects cases submitted from now on.
                </p>
            </div>

            {/* Sub-toggles */}
            <div className="space-y-3">
                <span className="block text-sm font-medium text-ink">
                    What the system does when the window expires
                </span>
                {SUB_TOGGLES.map((t) => (
                    <label
                        key={t.key}
                        className={`flex items-start gap-3 ${
                            settings.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                        }`}
                    >
                        <input
                            type="checkbox"
                            className="mt-1 h-4 w-4"
                            disabled={!settings.enabled}
                            checked={settings[t.key] as boolean}
                            onChange={(e) =>
                                patch({ [t.key]: e.target.checked } as Partial<Settings>)
                            }
                        />
                        <span>
                            <span className="block text-sm text-ink">{t.label}</span>
                            <span className="mt-0.5 block text-xs text-ink-muted">{t.hint}</span>
                        </span>
                    </label>
                ))}
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-4">
                <Button onClick={save} disabled={saving || !dirty}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save changes
                </Button>
                {dirty && !saving && (
                    <button
                        type="button"
                        className="text-xs text-ink-muted underline"
                        onClick={() => setDraft(null)}
                    >
                        Discard
                    </button>
                )}
            </div>
        </div>
    );
}
