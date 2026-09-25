"use client";

// Record an eligibility decision from the Eligibility queue (E-307).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ecofyPost } from "./client";
import { Btn, Field, inputCls } from "./ui";

export function EligibilityDecision({ eligibilityId, caseId, caseNo }: { eligibilityId: string; caseId: string; caseNo: string }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [f, setF] = useState({ status: "ELIGIBLE", maxEligibleInr: "", reason: "" });
    const [busy, setBusy] = useState(false);

    async function submit() {
        setBusy(true);
        try {
            await ecofyPost(`/api/ecofy/eligibility/${eligibilityId}/decision`, {
                caseId,
                status: f.status,
                maxEligibleInr: f.status === "ELIGIBLE" ? Number(f.maxEligibleInr) : undefined,
                reason: f.status !== "ELIGIBLE" ? f.reason : undefined,
            });
            toast.success(`${caseNo}: ${f.status.replace("_", " ").toLowerCase()} recorded`);
            setOpen(false);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not record");
        } finally {
            setBusy(false);
        }
    }

    if (!open)
        return (
            <Btn variant="primary" onClick={() => setOpen(true)}>
                Record decision
            </Btn>
        );
    return (
        <div className="grid min-w-[260px] gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-left">
            <Field label="Decision">
                <select className={inputCls} value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))}>
                    <option value="ELIGIBLE">Eligible (maximum amount)</option>
                    <option value="NOT_ELIGIBLE">Not eligible (reason)</option>
                    <option value="INFO_NEEDED">Info needed (note to the caller)</option>
                </select>
            </Field>
            {f.status === "ELIGIBLE" ? (
                <Field label="Maximum eligible amount (₹)" hint="Callers never see this amount.">
                    <input type="number" min={1} className={inputCls} value={f.maxEligibleInr} onChange={(e) => setF((x) => ({ ...x, maxEligibleInr: e.target.value }))} />
                </Field>
            ) : (
                <Field label={f.status === "NOT_ELIGIBLE" ? "Reason" : "Note to the caller"}>
                    <textarea rows={2} className={inputCls} value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} />
                </Field>
            )}
            <div className="flex justify-end gap-2">
                <Btn onClick={() => setOpen(false)}>Cancel</Btn>
                <Btn
                    variant="success"
                    disabled={busy || (f.status === "ELIGIBLE" ? !(Number(f.maxEligibleInr) > 0) : f.reason.trim().length < 3)}
                    onClick={submit}
                >
                    Record
                </Btn>
            </div>
        </div>
    );
}
