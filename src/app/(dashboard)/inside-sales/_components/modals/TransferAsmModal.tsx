"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Modal } from "../Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { AsmOption } from "@/lib/inside-sales/types";

type Props = {
    open: boolean;
    onClose: () => void;
    leadId: string;
    state: string | null;
    city: string | null;
    onSuccess: () => void;
};

const REASONS = [
    "Commercials_Finalised",
    "Site_Visit_Needed",
    "Negotiation_Beyond_IS_Authority",
    "Demo_Requested",
    "Other",
] as const;

const VISIT_TYPES = ["Initial_Visit", "Demo", "Negotiation", "Closing"] as const;

export function TransferAsmModal({ open, onClose, leadId, state, city, onSuccess }: Props) {
    const [asmId, setAsmId] = useState("");
    const [reason, setReason] = useState<(typeof REASONS)[number]>("Commercials_Finalised");
    const [visitType, setVisitType] = useState<(typeof VISIT_TYPES)[number]>("Initial_Visit");
    const [suggestedDate, setSuggestedDate] = useState("");
    const [preferredTime, setPreferredTime] = useState("");
    const [handoffNotes, setHandoffNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Simple flow: always list every active ASM, no territory filtering.
    const asmQuery = useQuery<{ success: true; data: { asms: AsmOption[]; total_asms: number } }>({
        queryKey: ["asm-options"],
        enabled: open,
        queryFn: async () => {
            const u = new URL("/api/inside-sales/asm-options", window.location.origin);
            u.searchParams.set("include_out_of_territory", "true");
            const res = await fetch(u.toString(), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load ASMs");
            return res.json();
        },
    });
    const asms = asmQuery.data?.data?.asms ?? [];
    const totalAsms = asmQuery.data?.data?.total_asms ?? 0;

    useEffect(() => {
        if (!open) {
            setAsmId("");
            setSuggestedDate("");
            setPreferredTime("");
            setHandoffNotes("");
        }
    }, [open]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!asmId) {
            toast.error("Pick an ASM.");
            return;
        }
        setSubmitting(true);
        try {
            const body: Record<string, unknown> = {
                asm_id: asmId,
                reason,
                visit_type: visitType,
                handoff_notes: handoffNotes.trim(),
            };
            if (suggestedDate) body.suggested_visit_date = suggestedDate;
            if (preferredTime) body.dealer_preferred_time = preferredTime;
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/transfer-asm`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to transfer");
            toast.success("Transferred to ASM.");
            onSuccess();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={() => !submitting && onClose()}
            title="Transfer to ASM"
            subtitle={[city, state].filter(Boolean).join(", ") || "No region on this lead"}
            width="md"
            closeOnBackdrop={!submitting}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button type="button" onClick={submit} disabled={submitting}>
                        {submitting ? "Transferring…" : "Transfer to ASM"}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <Label>ASM</Label>
                    <select
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                        value={asmId}
                        onChange={(e) => setAsmId(e.target.value)}
                    >
                        <option value="">— select ASM —</option>
                        {asms.map((a) => (
                            <option key={a.user_id} value={a.user_id}>
                                {a.name ?? a.email}
                            </option>
                        ))}
                    </select>
                    {totalAsms === 0 && (
                        <p className="text-[11px] text-gray-500 mt-1">
                            No ASM users found. Run scripts/seed-asm-users.js to add them.
                        </p>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <Label>Reason for transfer</Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={reason}
                            onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
                        >
                            {REASONS.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ")}</option>)}
                        </select>
                    </div>
                    <div>
                        <Label>Visit type</Label>
                        <select
                            className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm bg-white"
                            value={visitType}
                            onChange={(e) => setVisitType(e.target.value as (typeof VISIT_TYPES)[number])}
                        >
                            {VISIT_TYPES.map((v) => <option key={v} value={v}>{v.replaceAll("_", " ")}</option>)}
                        </select>
                    </div>
                    <div>
                        <Label>Suggested visit date (optional)</Label>
                        <Input type="date" value={suggestedDate} onChange={(e) => setSuggestedDate(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                        <Label>Dealer&apos;s preferred time</Label>
                        <Input value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} placeholder="e.g. weekday mornings" className="mt-1" />
                    </div>
                </div>

                <div>
                    <Label>Handoff notes</Label>
                    <textarea
                        className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm min-h-[80px]"
                        value={handoffNotes}
                        onChange={(e) => setHandoffNotes(e.target.value)}
                        placeholder="Context for the ASM — current commitments, dealer preferences, pending items"
                    />
                </div>
            </form>
        </Modal>
    );
}
