"use client";

// Reports › Scheduled email reports (tracker ID 13): every email the CRM sends
// on a schedule — what it holds, when it goes, who gets it, when it last went —
// with "Preview" (nothing is sent) and "Send me a copy". Turning a report on or off and changing who receives
// it stays under Settings; this tab links there.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Eye, Loader2, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Report = {
    id: string;
    label: string;
    description: string;
    enabled: boolean;
    when: string;
    recipients: string[];
    attach_excel: boolean;
    last_sent_at: string | null;
    last_sent_for: string | null;
    settings_href: string | null;
};

export function ScheduledEmailsView() {
    const [sending, setSending] = useState<string | null>(null);
    const [note, setNote] = useState<{ id: string; tone: "ok" | "error"; text: string } | null>(null);

    const query = useQuery<{ reports: Report[]; can_edit_settings: boolean }>({
        queryKey: ["scheduled-emails"],
        queryFn: async () => {
            const res = await fetch("/api/admin/reports/scheduled-emails", { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load");
            return json.data;
        },
    });

    const [previewing, setPreviewing] = useState<string | null>(null);
    const [preview, setPreview] = useState<{ label: string; subject: string; html: string; for_day: string } | null>(null);

    const openPreview = async (id: string, label: string) => {
        setPreviewing(id);
        setNote(null);
        try {
            const res = await fetch("/api/admin/reports/scheduled-emails/preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: id }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not build the preview");
            setPreview({ label, ...json.data });
        } catch (e) {
            setNote({ id, tone: "error", text: (e as Error).message });
        } finally {
            setPreviewing(null);
        }
    };

    const sendCopy = async (id: string) => {
        setSending(id);
        setNote(null);
        try {
            const res = await fetch("/api/admin/reports/scheduled-emails", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: id }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Could not send");
            setNote({ id, tone: "ok", text: `Sent to ${json.data.sent_to}.` });
        } catch (e) {
            setNote({ id, tone: "error", text: (e as Error).message });
        } finally {
            setSending(null);
        }
    };

    if (query.isLoading) {
        return (
            <div className="flex items-center py-12 text-ink-muted">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
            </div>
        );
    }
    if (query.error) return <p className="text-sm text-danger">{(query.error as Error).message}</p>;

    return (
        <>
        {preview && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreview(null)}>
                <div className="flex h-[85vh] w-full max-w-4xl flex-col rounded-xl bg-surface shadow-card" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                        <div>
                            <div className="text-sm font-semibold text-ink">{preview.subject}</div>
                            <p className="text-xs text-ink-muted">
                                Preview of {preview.label} for {preview.for_day}, with the figures as they stand now. Nothing was sent.
                            </p>
                        </div>
                        <button type="button" aria-label="Close preview" onClick={() => setPreview(null)} className="text-ink-muted hover:text-ink">
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                    {/* sandbox with no allowances: the email's HTML can run no script and reach nothing. */}
                    <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="w-full flex-1 rounded-b-xl bg-white" />
                </div>
            </div>
        )}
        <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-card">
            <table className="min-w-full text-sm">
                <thead className="bg-bg text-left text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="px-4 py-2 font-semibold">Report</th>
                        <th className="px-4 py-2 font-semibold">When</th>
                        <th className="px-4 py-2 font-semibold">Who gets it</th>
                        <th className="px-4 py-2 font-semibold">Last sent</th>
                        <th className="px-4 py-2" />
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {(query.data?.reports ?? []).map((r) => (
                        <tr key={r.id} className="align-top">
                            <td className="px-4 py-3">
                                <div className="font-medium text-ink">
                                    {r.label}{" "}
                                    <span
                                        className={`ml-1 rounded-full border px-2 py-0.5 text-[11px] ${
                                            r.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-bg text-ink-muted"
                                        }`}
                                    >
                                        {r.enabled ? "On" : "Off"}
                                    </span>
                                </div>
                                <p className="mt-1 max-w-md text-xs text-ink-muted">{r.description}</p>
                                {r.attach_excel && <p className="mt-1 text-[11px] text-ink-muted">Excel attached.</p>}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-ink">{r.when}</td>
                            <td className="px-4 py-3 text-xs text-ink">
                                {r.recipients.length ? r.recipients.join(", ") : <span className="text-ink-muted">Nobody yet</span>}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-muted">
                                {r.last_sent_at
                                    ? `${new Date(r.last_sent_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
                                    : "Not sent yet"}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="mr-2"
                                    disabled={previewing !== null}
                                    onClick={() => openPreview(r.id, r.label)}
                                >
                                    <Eye className="mr-1 h-3.5 w-3.5" />
                                    {previewing === r.id ? "Building…" : "Preview"}
                                </Button>
                                <Button type="button" size="sm" variant="outline" disabled={sending !== null} onClick={() => sendCopy(r.id)}>
                                    <Mail className="mr-1 h-3.5 w-3.5" />
                                    {sending === r.id ? "Sending…" : "Send me a copy"}
                                </Button>
                                {query.data?.can_edit_settings && r.settings_href && (
                                    <div className="mt-1.5">
                                        <Link href={r.settings_href} className="text-xs text-brand-600 underline">
                                            Settings
                                        </Link>
                                    </div>
                                )}
                                {note?.id === r.id && (
                                    <p className={`mt-1.5 text-xs ${note.tone === "ok" ? "text-emerald-700" : "text-danger"}`}>{note.text}</p>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        </>
    );
}
