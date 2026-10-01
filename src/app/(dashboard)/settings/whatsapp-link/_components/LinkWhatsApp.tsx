"use client";

// Link WhatsApp card. Three states:
//   linked   → the linked number and an Unlink button
//   code     → the one-time code, what to send, a countdown; polls until linked
//   neither  → "Get link code"
// The code is shown once (the server keeps only its hash); reloading the page
// while a code is outstanding shows its expiry and offers a new one.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, MessageCircle, Unlink } from "lucide-react";
import { confirmDialog } from "@/components/ui/confirm-dialog";

type LinkState = {
    linked: { waPhone: string; verifiedAt: string | null } | null;
    pendingExpiresAt: string | null;
    assistant_number: string | null;
    configured: boolean;
};

type IssuedCode = { code: string; expires_at: string; message_to_send: string };

const POLL_MS = 4000;

async function api<T>(method: "GET" | "POST" | "DELETE"): Promise<T> {
    const res = await fetch("/api/assistant/link", { method, cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Request failed");
    return json.data as T;
}

function maskPhone(p: string): string {
    return p.length > 7 ? `${p.slice(0, 5)}•••••${p.slice(-3)}` : p;
}

function useCountdown(until: string | null): number {
    const [left, setLeft] = useState(0);
    useEffect(() => {
        if (!until) return;
        const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
        tick();
        const t = setInterval(tick, 1000);
        return () => clearInterval(t);
    }, [until]);
    return until ? left : 0;
}

export function LinkWhatsApp() {
    const [state, setState] = useState<LinkState | null>(null);
    const [issued, setIssued] = useState<IssuedCode | null>(null);
    const [busy, setBusy] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const secondsLeft = useCountdown(issued?.expires_at ?? null);

    const load = useCallback(async () => {
        try {
            const s = await api<LinkState>("GET");
            setState(s);
            setLoadError(null);
            return s;
        } catch (e) {
            setLoadError((e as Error).message);
            return null;
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // While a code is showing, poll until the phone sends it.
    useEffect(() => {
        if (!issued || secondsLeft === 0) return;
        const t = setInterval(async () => {
            const s = await load();
            if (s?.linked) {
                setIssued(null);
                toast.success("WhatsApp linked");
            }
        }, POLL_MS);
        return () => clearInterval(t);
    }, [issued, secondsLeft, load]);

    const getCode = async () => {
        setBusy(true);
        try {
            setIssued(await api<IssuedCode>("POST"));
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        const ok = await confirmDialog({
            title: "Unlink WhatsApp?",
            message: "The Sales Assistant will stop answering this number until you link again.",
            confirmText: "Unlink",
            variant: "danger",
        });
        if (!ok) return;
        setBusy(true);
        try {
            await api("DELETE");
            setIssued(null);
            await load();
            toast.success("WhatsApp unlinked");
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    if (loadError) {
        return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{loadError}</div>;
    }
    if (!state) {
        return (
            <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (!state.configured) {
        return (
            <div className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">
                WhatsApp linking is not available yet. Please check back soon.
            </div>
        );
    }

    const assistant = state.assistant_number ?? "the iTarang Sales Assistant number";

    return (
        <div className="space-y-4">
            {state.linked ? (
                <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-sm font-medium text-emerald-900">Linked</p>
                            <p className="mt-1 text-lg font-semibold text-gray-900">{maskPhone(state.linked.waPhone)}</p>
                            {state.linked.verifiedAt && (
                                <p className="mt-1 text-xs text-gray-600">
                                    Since {new Date(state.linked.verifiedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                                </p>
                            )}
                            <p className="mt-3 text-sm text-gray-700">
                                Message <span className="font-medium">{assistant}</span> from this phone.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={unlink}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                            <Unlink className="h-4 w-4" /> Unlink
                        </button>
                    </div>
                </section>
            ) : null}

            {issued && secondsLeft > 0 ? (
                <section className="rounded-lg border border-blue-200 bg-white p-5">
                    <p className="text-sm text-gray-700">
                        From the phone you want to link, send this message to <span className="font-medium">{assistant}</span>:
                    </p>
                    <div className="mt-3 flex items-center gap-3">
                        <code className="rounded-md bg-gray-100 px-4 py-2 text-2xl font-semibold tracking-widest text-gray-900">
                            {issued.message_to_send}
                        </code>
                        <button
                            type="button"
                            onClick={() => {
                                void navigator.clipboard?.writeText(issued.message_to_send);
                                toast.success("Copied");
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                        >
                            <Copy className="h-4 w-4" /> Copy
                        </button>
                    </div>
                    <p className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Waiting for your message · code expires in {Math.floor(secondsLeft / 60)}:
                        {String(secondsLeft % 60).padStart(2, "0")}
                    </p>
                </section>
            ) : (
                <section className="rounded-lg border border-gray-200 bg-white p-5">
                    <p className="text-sm text-gray-700">
                        {state.linked
                            ? "To move the Assistant to a different phone, get a new code and send it from that phone."
                            : "Get a one-time code, then send it from your phone to link it."}
                    </p>
                    {issued && secondsLeft === 0 && (
                        <p className="mt-2 text-xs text-amber-700">That code expired. Get a new one.</p>
                    )}
                    <button
                        type="button"
                        onClick={getCode}
                        disabled={busy}
                        className="mt-4 inline-flex items-center gap-2 rounded-md bg-[#0047AB] px-4 py-2 text-sm font-medium text-white hover:bg-[#003a8c] disabled:opacity-50"
                    >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                        Get link code
                    </button>
                </section>
            )}

            <p className="text-xs text-gray-500">
                The code works once, for 10 minutes, and only for your account. Five wrong codes from a
                number lock it for an hour.
            </p>
        </div>
    );
}
