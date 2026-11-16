"use client";

// ID 235: in the Reassign windows — when the lead is in a NeoDove campaign and
// the new owner has a campaign of their own (E-237 CRM owner), offer to move
// it there too. NeoDove cannot be told to drop it from the old campaign, so
// the line says to do that by hand.

import { useEffect, useState } from "react";
import { toast } from "sonner";

type Preview = {
    current: { name: string; neodove_name: string | null; push_status: string } | null;
    target: { name: string; neodove_name: string | null } | null;
    offer: boolean;
};

export function NeodoveMoveOption({
    leadId,
    targetUserId,
    checked,
    onChange,
}: {
    leadId: string;
    targetUserId: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}) {
    const [preview, setPreview] = useState<Preview | null>(null);
    useEffect(() => {
        setPreview(null);
        onChange(false);
        if (!targetUserId) return;
        let cancelled = false;
        fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/neodove-move?to=${encodeURIComponent(targetUserId)}`, {
            cache: "no-store",
        })
            .then((r) => r.json())
            .then((j) => {
                if (!cancelled && j?.success) setPreview(j.data as Preview);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [leadId, targetUserId]);

    if (!preview?.current) return null;
    if (!preview.offer) {
        return (
            <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
                NeoDove: this lead is in <b>{preview.current.name}</b>.{" "}
                {preview.target
                    ? "The new owner's campaign is the same one."
                    : "The new owner has no NeoDove campaign of their own, so it stays there — ask NeoDove's admin to move it if needed."}
            </p>
        );
    }
    const oldName = preview.current.neodove_name ?? preview.current.name;
    return (
        <label className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>
                Also move to the new owner&apos;s NeoDove campaign <b>{preview.target!.name}</b>.
                <span className="block text-[11px] text-sky-800">
                    Then remove it from <b>{oldName}</b> in NeoDove by hand, or the old caller keeps calling it.
                </span>
            </span>
        </label>
    );
}

/** After the reassign succeeded: move the NeoDove campaign too. Never throws. */
export async function moveNeodoveCampaign(leadId: string, toUserId: string): Promise<void> {
    try {
        const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/neodove-move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to_user_id: toUserId }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
            toast.error(json?.error?.message ?? "The NeoDove campaign was not moved.");
            return;
        }
        toast.warning(json.data.message, { duration: Infinity, closeButton: true });
    } catch {
        toast.error("The NeoDove campaign was not moved.");
    }
}
