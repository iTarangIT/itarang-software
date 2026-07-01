"use client";

// Editable wrapper around InterestChip (BRD §0.7). Owner / ASM / admin can
// override a lead's temperature (hot/warm/cold) with an optional reason. When
// not editable it renders the plain chip. PATCHes
// /api/inside-sales/lead/[id]/interest-level and calls onUpdated() so the
// parent's react-query bundle refetches.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { InterestChip } from "./InterestChip";

const LEVELS = [
    { key: "hot", label: "Hot" },
    { key: "warm", label: "Warm" },
    { key: "cold", label: "Cold" },
] as const;

type Props = {
    leadId: string;
    value: string | null | undefined;
    editable: boolean;
    onUpdated?: () => void;
};

export function InterestLevelEditor({ leadId, value, editable, onUpdated }: Props) {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    if (!editable) return <InterestChip level={value} />;

    const save = async (next: string) => {
        if (next === (value ?? "")) {
            setOpen(false);
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(
                `/api/inside-sales/lead/${encodeURIComponent(leadId)}/interest-level`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        interest_level: next,
                        reason: reason.trim() || undefined,
                    }),
                },
            );
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Failed to update temperature");
            toast.success("Lead temperature updated");
            setOpen(false);
            setReason("");
            onUpdated?.();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <span ref={ref} className="relative inline-flex items-center">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title="Change temperature"
                className="group/edit inline-flex items-center gap-1"
            >
                {value ? (
                    <InterestChip level={value} />
                ) : (
                    <span className="inline-flex items-center rounded-md border border-dashed border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                        Set temperature
                    </span>
                )}
                <Pencil className="h-3 w-3 text-gray-400 opacity-0 transition-opacity group-hover/edit:opacity-100" />
            </button>

            {open && (
                <div className="absolute left-0 top-7 z-50 w-56 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                        Set temperature
                    </p>
                    <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason (optional)"
                        className="mb-2 w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-gray-400 focus:outline-none"
                    />
                    <div className="flex gap-1">
                        {LEVELS.map((l) => (
                            <button
                                key={l.key}
                                type="button"
                                disabled={saving}
                                onClick={() => save(l.key)}
                                className={`flex-1 rounded-md border px-2 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                                    (value ?? "").toLowerCase() === l.key
                                        ? "border-gray-900 bg-gray-900 text-white"
                                        : "border-gray-200 text-gray-700 hover:bg-gray-50"
                                }`}
                            >
                                {l.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </span>
    );
}
