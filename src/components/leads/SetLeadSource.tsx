"use client";

// Tracker ID 81 — "Found via" on a lead that has none. Leads made before
// source capture show "Not recorded"; the owner (or a manager) can record it
// here once. After that it is locked like every other lead's source.

import { useState } from "react";
import { toast } from "sonner";
import { CampaignPicker } from "@/components/leads/CampaignPicker";
import {
    CAMPAIGN_REQUIRED_MESSAGE,
    LEAD_ORIGIN_LABEL,
    LEAD_ORIGINS,
    campaignRequired,
} from "@/lib/leads/leadSourceVocab";

export function SetLeadSource({
    leadId,
    hasCampaign,
    onSaved,
}: {
    leadId: string;
    /** The lead already carries a campaign (its batch or list) — don't ask again. */
    hasCampaign: boolean;
    onSaved: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [origin, setOrigin] = useState("");
    const [campaignId, setCampaignId] = useState("");
    const [saving, setSaving] = useState(false);

    if (!open) {
        return (
            <span>
                Not recorded{" "}
                <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand-700 hover:underline">
                    Set
                </button>
            </span>
        );
    }

    const save = async () => {
        if (!origin) {
            toast.error("Pick how the dealer was found.");
            return;
        }
        if (!hasCampaign && campaignRequired(origin) && !campaignId) {
            toast.error(CAMPAIGN_REQUIRED_MESSAGE);
            return;
        }
        if (!window.confirm(`Record "${LEAD_ORIGIN_LABEL[origin as keyof typeof LEAD_ORIGIN_LABEL]}"? This cannot be changed afterwards.`)) {
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/source`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ origin, campaign_id: campaignId || null }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not save");
            toast.success("Found via recorded.");
            onSaved();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-2">
            <select
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm"
            >
                <option value="">Select…</option>
                {LEAD_ORIGINS.map((o) => (
                    <option key={o} value={o}>
                        {LEAD_ORIGIN_LABEL[o]}
                    </option>
                ))}
            </select>
            {!hasCampaign && (
                <CampaignPicker
                    origin={origin}
                    value={campaignId}
                    onChange={setCampaignId}
                    labelClassName="block text-xs font-medium text-gray-600"
                    controlClassName="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm"
                />
            )}
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                    {saving ? "Saving…" : "Save"}
                </button>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    disabled={saving}
                    className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
