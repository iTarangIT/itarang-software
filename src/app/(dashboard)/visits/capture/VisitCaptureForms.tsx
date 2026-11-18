"use client";

// Tracker ID 196 — the two phone forms behind /visits/capture: a visit on a
// lead (the full visit form, done visits verified) and a visit on an existing
// counter (photo + location, outcome, remarks).
//
// ID 241-2 (agreed 11 Nov): on an existing dealer, once E-386 is on, the
// outcome is the dealer list (Order taken, Payment collected, …), with the
// amount the dealer mentioned (reported by the rep, never revenue) and a next
// visit date — required unless "No follow-up needed".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useVisitForm, VisitFields, type VisitLeadState } from "@/app/(dashboard)/asm/_components/VisitFields";
import { VerifiedVisitCapture, type CapturedVisit } from "@/components/visits/VerifiedVisitCapture";
import { VISIT_OUTCOME, VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";
import {
    AMOUNT_OUTCOMES,
    DEALER_VISIT_OUTCOMES,
    DEALER_VISIT_OUTCOME_LABELS,
    dealerVisitProblem,
    type DealerVisitOutcome,
} from "@/lib/visits/dealerVisitOutcomes";

export function LeadVisitCapture({
    leadId,
    name,
    lead,
    backHref,
}: {
    leadId: string;
    name: string;
    lead: VisitLeadState;
    backHref: string;
}) {
    const router = useRouter();
    const form = useVisitForm(true, lead);
    return (
        <div className="space-y-4">
            <p className="text-sm text-gray-600">
                Visit to <span className="font-medium text-gray-900">{name}</span>
            </p>
            <VisitFields form={form} leadId={leadId} />
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => router.push(backHref)} disabled={form.submitting}>
                    Cancel
                </Button>
                <Button
                    type="button"
                    disabled={form.submitting}
                    onClick={async () => {
                        const ok = await form.submit(leadId);
                        if (ok) router.push(backHref);
                    }}
                >
                    {form.submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Save visit
                </Button>
            </div>
        </div>
    );
}

/** Add `days` to a yyyy-mm-dd day. */
function addDays(day: string, days: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

export function AccountVisitCapture({
    accountId,
    name,
    backHref,
    dealerOutcomes = false,
    todayIst,
}: {
    accountId: string;
    name: string;
    backHref: string;
    /** ID 241-2: E-386 is on — dealer outcomes, reported amount and next visit. */
    dealerOutcomes?: boolean;
    todayIst?: string;
}) {
    const router = useRouter();
    const [capture, setCapture] = useState<CapturedVisit | null>(null);
    const [outcome, setOutcome] = useState<VisitOutcome>("productive");
    const [dealerOutcome, setDealerOutcome] = useState<DealerVisitOutcome | "">("");
    const [amount, setAmount] = useState("");
    const [nextDate, setNextDate] = useState("");
    const [noFollowUp, setNoFollowUp] = useState(false);
    const [remarks, setRemarks] = useState("");
    const [saving, setSaving] = useState(false);
    const today = todayIst ?? new Date().toISOString().slice(0, 10);

    const save = async () => {
        if (!capture) return toast.error("Read your location and take the shop photo first.");
        if (!remarks.trim()) return toast.error("Write what happened at the shop.");
        const amountNum = amount.trim() ? Number(amount.replace(/[,\s₹]/g, "")) : null;
        if (dealerOutcomes) {
            const problem = dealerVisitProblem(
                { dealerOutcome: dealerOutcome || null, reportedAmount: amountNum, nextVisitDate: nextDate || null, noFollowUp },
                today,
            );
            if (problem) return toast.error(problem);
        }
        setSaving(true);
        try {
            const res = await fetch("/api/visits/account", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    account_id: accountId,
                    capture_id: capture.captureId,
                    visit_remarks: remarks.trim(),
                    ...(dealerOutcomes
                        ? {
                              dealer_outcome: dealerOutcome,
                              reported_amount: amountNum,
                              next_visit_date: noFollowUp ? null : nextDate || null,
                              no_follow_up: noFollowUp,
                          }
                        : { visit_outcome: outcome }),
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Could not save the visit");
            toast.success(json?.data?.next_visit_date ? "Visit logged. Next visit booked in My visits." : "Visit logged.");
            router.push(backHref);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const amountMatters = dealerOutcome !== "" && AMOUNT_OUTCOMES.includes(dealerOutcome);

    return (
        <div className="space-y-4">
            <p className="text-sm text-gray-600">
                Visit to <span className="font-medium text-gray-900">{name}</span> — today
            </p>
            <div className="rounded-md border border-gray-200 p-3">
                <Label>
                    Shop photo and live location <span className="text-rose-600">*</span>
                </Label>
                <div className="mt-1">
                    <VerifiedVisitCapture accountId={accountId} value={capture} onChange={setCapture} disabled={saving} />
                </div>
                <p className="mt-2 text-xs text-gray-500">
                    The visit is dated by the server, can&apos;t be back-dated, and a photo can&apos;t be used twice.
                </p>
            </div>

            {dealerOutcomes ? (
                <div>
                    <Label>
                        Outcome <span className="text-rose-600">*</span>
                    </Label>
                    <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Outcome for an existing dealer">
                        {DEALER_VISIT_OUTCOMES.map((o) => (
                            <label
                                key={o}
                                className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                                    dealerOutcome === o ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-gray-200 text-gray-800"
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="dealer_outcome"
                                    value={o}
                                    checked={dealerOutcome === o}
                                    onChange={() => setDealerOutcome(o)}
                                    disabled={saving}
                                />
                                {DEALER_VISIT_OUTCOME_LABELS[o]}
                            </label>
                        ))}
                    </div>
                </div>
            ) : (
                <div>
                    <Label>Outcome</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                        value={outcome}
                        onChange={(e) => setOutcome(e.target.value as VisitOutcome)}
                    >
                        {VISIT_OUTCOME.map((o) => (
                            <option key={o} value={o}>
                                {VISIT_OUTCOME_LABELS[o]}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            <div>
                <Label>
                    What happened at the shop? <span className="text-rose-600">*</span>
                </Label>
                <textarea
                    className="mt-1 min-h-[96px] w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Stock seen, what the dealer asked for, what you agreed"
                />
            </div>

            {dealerOutcomes && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                        <Label>Amount the dealer mentioned (₹){amountMatters ? "" : " — optional"}</Label>
                        <input
                            inputMode="decimal"
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                            placeholder="Reported by you"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            disabled={saving}
                        />
                        <p className="mt-1 text-xs text-gray-500">Never counted as revenue; invoices come only from Vyapar.</p>
                    </div>
                    <div>
                        <Label>
                            Next visit date {!noFollowUp && <span className="text-rose-600">*</span>}
                        </Label>
                        <input
                            type="date"
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
                            min={addDays(today, 1)}
                            max={addDays(today, 90)}
                            value={noFollowUp ? "" : nextDate}
                            onChange={(e) => setNextDate(e.target.value)}
                            disabled={saving || noFollowUp}
                        />
                        <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={noFollowUp}
                                onChange={(e) => setNoFollowUp(e.target.checked)}
                                disabled={saving}
                            />
                            No follow-up needed
                        </label>
                        <p className="mt-1 text-xs text-gray-500">The next visit appears in My visits as booked.</p>
                    </div>
                </div>
            )}

            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => router.push(backHref)} disabled={saving}>
                    Cancel
                </Button>
                <Button type="button" onClick={save} disabled={saving || !capture}>
                    {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Save visit
                </Button>
            </div>
        </div>
    );
}
