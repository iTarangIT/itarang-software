"use client";

/**
 * ID 172 — the quote's deal card on the lead page: onboarding fee, expected
 * batteries and finance files per month. Once locked (the CEO approved a quote
 * or the dealer said yes), the Sales Head alone gets "Change" — POST
 * /api/inside-sales/lead/[id]/deal-card, with a reason.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEAL_CARD_EDIT_ROLES } from "@/lib/leads/dealCardRules";
import type { LeadDetailCommercials } from "@/lib/inside-sales/types";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function DealCardBlock({
    leadId,
    cc,
    viewerRole,
}: {
    leadId: string;
    cc: LeadDetailCommercials;
    viewerRole?: string | null;
}) {
    const card = cc.deal_card ?? null;
    const queryClient = useQueryClient();
    const canEdit = (DEAL_CARD_EDIT_ROLES as readonly string[]).includes(viewerRole ?? "");
    const [editing, setEditing] = useState(false);
    const [fee, setFee] = useState(card ? String(card.onboarding_fee) : "");
    const [waived, setWaived] = useState(card?.fee_waived_reason ?? "");
    const [bat, setBat] = useState(card ? String(card.batteries_per_month) : "");
    const [fin, setFin] = useState(card ? String(card.finance_files_per_month) : "");
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);

    if (!card && !canEdit) return null;

    const save = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/deal-card`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    deal_card: {
                        onboarding_fee: Number(fee),
                        fee_waived_reason: Number(fee) === 0 ? waived.trim() : null,
                        batteries_per_month: Number(bat),
                        finance_files_per_month: Number(fin),
                    },
                    note: note.trim(),
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not change the deal card");
            toast.success("Deal card changed.");
            setEditing(false);
            await queryClient.invalidateQueries();
        } catch (err) {
            toast.error((err as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="col-span-2 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
            <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-gray-500">
                    Deal card
                    {cc.deal_card_locked && (
                        <span className="ml-1.5 normal-case tracking-normal text-amber-700">
                            · locked ({cc.deal_card_locked === "ceo" ? "CEO approved" : "dealer said yes"})
                        </span>
                    )}
                </div>
                {canEdit && !editing && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                        Change
                    </Button>
                )}
            </div>
            {!editing ? (
                card ? (
                    <div className="mt-1.5 grid grid-cols-3 gap-2 text-sm text-gray-900">
                        <div>
                            <div className="text-[10px] text-gray-500">Onboarding fee</div>
                            {card.onboarding_fee > 0 ? inr(card.onboarding_fee) : `Waived${card.fee_waived_reason ? ` — ${card.fee_waived_reason}` : ""}`}
                            {/* Item 5: once the fee invoice is read (Invoice Ledger › Item mapping). */}
                            {cc.fee_invoiced != null && cc.fee_invoiced > 0 && (
                                <div className="text-[11px] text-gray-600">
                                    Fee promised {inr(card.onboarding_fee)} · invoiced {inr(cc.fee_invoiced)}
                                </div>
                            )}
                        </div>
                        <div>
                            <div className="text-[10px] text-gray-500">Batteries / month</div>
                            {card.batteries_per_month}
                        </div>
                        <div>
                            <div className="text-[10px] text-gray-500">Finance files / month</div>
                            {card.finance_files_per_month}
                        </div>
                    </div>
                ) : (
                    <p className="mt-1 text-xs text-gray-500">No deal card on this quote.</p>
                )
            ) : (
                <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                        <Input type="number" min={0} value={fee} onChange={(e) => setFee(e.target.value)} placeholder="Fee ₹" />
                        <Input type="number" min={1} value={bat} onChange={(e) => setBat(e.target.value)} placeholder="Batteries / month" />
                        <Input type="number" min={0} value={fin} onChange={(e) => setFin(e.target.value)} placeholder="Finance files / month" />
                    </div>
                    {fee.trim() !== "" && Number(fee) === 0 && (
                        <Input value={waived} onChange={(e) => setWaived(e.target.value)} placeholder="Why waived?" />
                    )}
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are you changing it? (required)" />
                    <div className="flex justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="button" size="sm" onClick={save} disabled={saving || note.trim().length < 5}>
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
