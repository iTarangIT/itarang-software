"use client";

// A32 — Admin pastes a NeoDove campaign's Custom Integration URL here; it is
// stored encrypted (E-344) and never shown again — only its last 4
// characters. Replaces "ask a developer to add an env var" for a new campaign.

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2 } from "lucide-react";

type Stored = Partial<Record<"push" | "update", { last4: string; updated_at: string }>>;

export function NeodoveEndpointForm({
    campaignId,
    stored,
    store,
    onSaved,
}: {
    campaignId: string;
    stored?: Stored;
    store?: { ready: boolean; reason: string | null };
    onSaved: () => void;
}) {
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const push = stored?.push;

    async function save() {
        setBusy(true);
        try {
            const r = await fetch(`/api/neodove/campaigns/${encodeURIComponent(campaignId)}/endpoint`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "push", url: url.trim() }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok || !j?.success) {
                throw new Error(r.status === 403 ? "Only an Admin can set a campaign's endpoint." : (j?.error?.message ?? "Could not save the endpoint"));
            }
            setUrl("");
            toast.success(`Endpoint saved (…${j.data.last4}). Leads can now be sent to this campaign.`);
            onSaved();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-gray-900">
                <KeyRound className="h-4 w-4 text-gray-500" />
                NeoDove endpoint (Admin)
            </div>
            <p className="mt-1 text-xs text-gray-500">
                Paste the campaign&apos;s Custom Integration URL from NeoDove. It is stored encrypted and never shown again — the
                URL itself gives write access to the NeoDove campaign.
                {push ? ` Stored: …${push.last4} (since ${new Date(push.updated_at).toLocaleDateString("en-IN")}).` : " None stored yet."}
            </p>
            {store && !store.ready ? (
                <p className="mt-2 text-xs text-amber-700">Not available on this server: {store.reason}</p>
            ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                    <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder={push ? "Paste a new URL to replace it" : "https://…"}
                        aria-label="NeoDove Custom Integration URL"
                        className="min-w-[260px] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm"
                    />
                    <button
                        type="button"
                        onClick={save}
                        disabled={busy || url.trim().length < 10}
                        className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {push ? "Replace endpoint" : "Save endpoint"}
                    </button>
                </div>
            )}
        </div>
    );
}
