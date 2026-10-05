"use client";

// Save the calculator run on screen as a CALCULATOR assessment on a lead
// (FR-07.2: Ecofy stores the release, the inputs and every step's result).
// The recommended system is pre-selected; picking another one needs a reason
// (FR-07.8 / AssessmentCreate.overrideReason; UAT-15). Ecofy recomputes on
// save from the same inputs — the CRM never sends sizes of its own.

import { useState } from "react";
import { toast } from "sonner";
import { runLeadAction } from "./client";
import type { CalculatorComputed } from "./EcofyCalculator";
import { Btn, Field, inputCls } from "./ui";

export function CalculatorAssessmentSave({
    leadId,
    computed,
    onSaved,
    label = "Save as this lead's assessment",
}: {
    leadId: string;
    computed: CalculatorComputed | null;
    onSaved?: () => void;
    label?: string;
}) {
    const [picked, setPicked] = useState<string | null>(null);
    const [overrideReason, setOverrideReason] = useState("");
    const [busy, setBusy] = useState(false);

    const options = computed?.result.options ?? [];
    const recommended = options.find((o) => o.role === "RECOMMENDED")?.systemCode ?? null;
    // Default to the recommendation; a choice no longer offered falls back to it.
    const selected = picked && options.some((o) => o.systemCode === picked) ? picked : recommended;
    const overriding = Boolean(selected) && selected !== recommended;
    const reasonOk = !overriding || overrideReason.trim().length >= 3;

    async function save() {
        if (!computed) return;
        setBusy(true);
        try {
            await runLeadAction(leadId, {
                action: "save_assessment",
                method: "CALCULATOR",
                calculator: computed.input,
                selectedSystemCode: selected ?? undefined,
                recommendedSystemCode: recommended,
                overrideReason: overriding ? overrideReason.trim() : undefined,
            });
            toast.success("Calculator assessment saved in Ecofy");
            setPicked(null);
            setOverrideReason("");
            onSaved?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not save the assessment");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-3">
            {!computed ? (
                <p className="text-sm text-gray-600">Enter the inputs above; the save button opens once Ecofy has computed them.</p>
            ) : (
                <>
                    <p className="text-sm text-gray-700">
                        Outcome: <b>{computed.result.recommendationStatus.replace(/_/g, " ").toLowerCase()}</b> · release v
                        {computed.result.releaseVersion}.
                        {computed.result.recommendationStatus === "PENDING_TECHNICAL_DATA" &&
                            " It is saved as pending technical data — a quote on it will be provisional."}
                    </p>
                    {options.length > 0 && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field label="System">
                                <select className={inputCls} value={selected ?? ""} onChange={(e) => setPicked(e.target.value || null)}>
                                    {!recommended && <option value="">— no system selected —</option>}
                                    {options.map((o) => (
                                        <option key={o.systemCode} value={o.systemCode}>
                                            {o.systemName} ({o.role.toLowerCase()})
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            {overriding && (
                                <Field label="Reason for choosing another system *" hint="Recorded in Ecofy with the assessment">
                                    <input
                                        className={inputCls}
                                        minLength={3}
                                        maxLength={500}
                                        value={overrideReason}
                                        onChange={(e) => setOverrideReason(e.target.value)}
                                    />
                                </Field>
                            )}
                        </div>
                    )}
                </>
            )}
            <div className="flex justify-end">
                <Btn variant="primary" disabled={busy || !computed || !reasonOk} onClick={save}>
                    {busy ? "Saving…" : label}
                </Btn>
            </div>
        </div>
    );
}
