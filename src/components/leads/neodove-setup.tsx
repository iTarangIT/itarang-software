"use client";

// NeoDove one-time server setup, as the screens see it (26 Oct). Per-campaign
// URLs are pasted on screen; the three values here are set once per server.
// Booleans only — /api/neodove/setup never returns a secret.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, XCircle } from "lucide-react";

export type NeodoveSetup = {
    enabled: boolean;
    webhookSecretSet: boolean;
    endpointStore: { ready: boolean; reason: string | null };
    canManage: boolean;
};

export function useNeodoveSetup() {
    return useQuery<NeodoveSetup>({
        queryKey: ["neodove-setup"],
        staleTime: 60_000,
        queryFn: async () => {
            const r = await fetch("/api/neodove/setup");
            const j = await r.json();
            if (!j?.success) throw new Error(j?.error?.message ?? "Could not load NeoDove setup");
            return j.data;
        },
    });
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
    return (
        <li className="flex items-start gap-2">
            {ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            )}
            <span>
                <span className="font-medium text-gray-800">{label}</span>
                {!ok && <span className="block text-xs text-gray-500">{hint}</span>}
            </span>
        </li>
    );
}

/** The card on the campaigns list: webhook URL to copy + the one-time checks. */
export function NeodoveSetupCard() {
    const { data } = useNeodoveSetup();
    const [copied, setCopied] = useState(false);
    if (!data) return null;

    const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/neodove/webhook` : "/api/neodove/webhook";
    const allOk = data.enabled && data.webhookSecretSet && data.endpointStore.ready;

    return (
        <details open={!allOk} className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-gray-900">
                NeoDove setup {allOk ? <span className="text-emerald-700">· ready</span> : <span className="text-rose-700">· needs attention</span>}
            </summary>
            <div className="mt-3 space-y-3">
                <div>
                    <p className="text-xs font-medium text-gray-700">
                        Webhook URL — paste once in NeoDove → Integrations → Webhook (with the Authorization header your
                        developer gave you)
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-lg bg-gray-50 px-3 py-1.5 font-mono text-xs text-gray-800">
                            {webhookUrl}
                        </code>
                        <button
                            type="button"
                            onClick={() => {
                                void navigator.clipboard?.writeText(webhookUrl).then(() => {
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1500);
                                });
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                            <Copy className="h-3.5 w-3.5" />
                            {copied ? "Copied" : "Copy"}
                        </button>
                    </div>
                </div>
                <ul className="space-y-1.5">
                    <Check ok={data.enabled} label="Sending to NeoDove is switched on" hint="One-time server setting (NEODOVE_ENABLED) — ask a developer once." />
                    <Check ok={data.webhookSecretSet} label="Webhook secret is set" hint="One-time server setting (NEODOVE_WEBHOOK_SECRET) — ask a developer once." />
                    <Check
                        ok={data.endpointStore.ready}
                        label="Campaign URLs can be saved from this screen"
                        hint={data.endpointStore.reason ?? "Not set up on this server."}
                    />
                </ul>
                <p className="text-xs text-gray-500">
                    These are set once per server. Everything per campaign — the NeoDove URL, agent links and team logins — is
                    done from these screens, with no developer and no restart.
                </p>
            </div>
        </details>
    );
}
