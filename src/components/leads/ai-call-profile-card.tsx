"use client";

// AI dialer list item 3 — what the AI says for this lead. The spoken shop name
// is computed from the listing title (spokenName.ts); a rep can override it
// (E-378) when the rule gets a name wrong. Reads and writes
// /api/inside-sales/lead/[id]/ai-call-profile. Renders nothing until loaded.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mic, Pencil } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";

type SpokenNameView = { computed: string; override: string | null; spoken: string; editable: boolean };
type Profile = { spokenName: SpokenNameView };

export function AiCallProfileCard({ leadId, className = "" }: { leadId: string; className?: string }) {
    const qc = useQueryClient();
    const key = ["lead-ai-call-profile", leadId];
    const { data } = useQuery({
        queryKey: key,
        queryFn: async (): Promise<Profile | null> => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/ai-call-profile`, {
                cache: "no-store",
            });
            if (!res.ok) return null;
            const json = await res.json();
            return (json?.data ?? null) as Profile | null;
        },
        staleTime: 60_000,
    });
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");

    const save = useMutation({
        mutationFn: async (spokenName: string | null) => {
            const res = await fetch(`/api/inside-sales/lead/${encodeURIComponent(leadId)}/ai-call-profile`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ spokenName }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not save");
            return json?.data as Profile;
        },
        onSuccess: (p) => {
            qc.setQueryData(key, p);
            setEditing(false);
            toast.success("Spoken name saved");
        },
        onError: (e: Error) => toast.error(e.message),
    });

    const sn = data?.spokenName;
    if (!sn || (!sn.spoken && !sn.editable)) return null;

    return (
        <div className={`rounded-xl border border-gray-100 bg-white px-4 py-3 text-sm shadow-sm ${className}`}>
            <div className="flex flex-wrap items-center gap-2">
                <Mic className="h-4 w-4 text-violet-500" aria-hidden />
                <span className="text-gray-500">AI says the shop as</span>
                <InfoTip>The short name the AI dialer says when it calls. Worked out from the shop name; change it if it sounds wrong.</InfoTip>
                {!editing && (
                    <>
                        <span className="font-semibold text-gray-900">“{sn.spoken || "—"}”</span>
                        {sn.override && <span className="text-xs text-gray-400">(set by a rep)</span>}
                        {sn.editable && (
                            <button
                                type="button"
                                onClick={() => {
                                    setDraft(sn.spoken);
                                    setEditing(true);
                                }}
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                            >
                                <Pencil className="h-3 w-3" aria-hidden />
                                Change
                            </button>
                        )}
                    </>
                )}
                {editing && (
                    <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save.mutate(draft.trim() === sn.computed ? null : draft);
                        }}
                    >
                        <input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            maxLength={80}
                            autoFocus
                            aria-label="Spoken shop name"
                            className="w-56 rounded-md border border-gray-200 px-2 py-1 text-sm focus:border-violet-400 focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={save.isPending}
                            className="rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                            Save
                        </button>
                        {sn.override && (
                            <button
                                type="button"
                                disabled={save.isPending}
                                onClick={() => save.mutate(null)}
                                className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                            >
                                Use “{sn.computed}”
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setEditing(false)}
                            className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
