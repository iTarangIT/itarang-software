"use client";

// Tracker ID 196 — the two phone forms behind /visits/capture: a visit on a
// lead (the full visit form, done visits verified) and a visit on an existing
// counter (photo + location, outcome, remarks).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useVisitForm, VisitFields, type VisitLeadState } from "@/app/(dashboard)/asm/_components/VisitFields";
import { VerifiedVisitCapture, type CapturedVisit } from "@/components/visits/VerifiedVisitCapture";
import { VISIT_OUTCOME, VISIT_OUTCOME_LABELS, type VisitOutcome } from "@/lib/asm/types";

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

export function AccountVisitCapture({ accountId, name, backHref }: { accountId: string; name: string; backHref: string }) {
    const router = useRouter();
    const [capture, setCapture] = useState<CapturedVisit | null>(null);
    const [outcome, setOutcome] = useState<VisitOutcome>("productive");
    const [remarks, setRemarks] = useState("");
    const [saving, setSaving] = useState(false);

    const save = async () => {
        if (!capture) return toast.error("Read your location and take the shop photo first.");
        if (!remarks.trim()) return toast.error("Visit remarks are required.");
        setSaving(true);
        try {
            const res = await fetch("/api/visits/account", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    account_id: accountId,
                    capture_id: capture.captureId,
                    visit_outcome: outcome,
                    visit_remarks: remarks.trim(),
                }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Could not save the visit");
            toast.success("Visit logged.");
            router.push(backHref);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-gray-600">
                Visit to counter <span className="font-medium text-gray-900">{name}</span> — today
            </p>
            <div>
                <Label>
                    Shop photo and location <span className="text-rose-600">*</span>
                </Label>
                <div className="mt-1">
                    <VerifiedVisitCapture accountId={accountId} value={capture} onChange={setCapture} disabled={saving} />
                </div>
            </div>
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
            <div>
                <Label>
                    Visit remarks <span className="text-rose-600">*</span>
                </Label>
                <textarea
                    className="mt-1 min-h-[96px] w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="What happened at the counter?"
                />
            </div>
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
