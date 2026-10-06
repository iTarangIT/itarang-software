"use client";

// Reports › Scheduled email reports, in the design's grid: every email the CRM
// sends on its own, what it holds, when it goes, who gets it and when it last
// went, with Preview (nothing is sent) and "Send me a copy". Same data as the
// admin Reports page: /api/admin/reports/scheduled-emails (digest settings +
// digest_runs). Turning a report on or off stays under its Settings page.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Eye, Mail } from "lucide-react";
import { EmailPreviewModal, type EmailPreview } from "@/components/reports/EmailPreviewModal";
import { BTN_SMALL, C, CARD, ErrorLine, Loading, TH, getJson } from "./ui";

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

const GRID = "grid grid-cols-[1.4fr_1.6fr_1.2fr_1fr_0.9fr_220px] gap-3";

function lastSent(r: Report): string {
    if (!r.enabled) return "Off";
    if (!r.last_sent_at) return "Not sent yet";
    return new Date(r.last_sent_at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function EmailsTab() {
    const query = useQuery<{ reports: Report[]; can_edit_settings: boolean }>({
        queryKey: ["scheduled-emails"],
        queryFn: () => getJson("/api/admin/reports/scheduled-emails"),
    });
    const [previewing, setPreviewing] = useState<string | null>(null);
    const [preview, setPreview] = useState<EmailPreview | null>(null);
    const [sending, setSending] = useState<string | null>(null);
    const [note, setNote] = useState<{ id: string; ok: boolean; text: string } | null>(null);

    const post = async (url: string, id: string) => {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: id }) });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Request failed");
        return json.data;
    };

    const openPreview = async (r: Report) => {
        setPreviewing(r.id);
        setNote(null);
        try {
            setPreview({ label: r.label, ...(await post("/api/admin/reports/scheduled-emails/preview", r.id)) });
        } catch (e) {
            setNote({ id: r.id, ok: false, text: (e as Error).message });
        } finally {
            setPreviewing(null);
        }
    };
    const sendCopy = async (r: Report) => {
        setSending(r.id);
        setNote(null);
        try {
            const data = await post("/api/admin/reports/scheduled-emails", r.id);
            setNote({ id: r.id, ok: true, text: `Sent to ${data.sent_to}.` });
        } catch (e) {
            setNote({ id: r.id, ok: false, text: (e as Error).message });
        } finally {
            setSending(null);
        }
    };

    return (
        <>
            {preview && <EmailPreviewModal preview={preview} onClose={() => setPreview(null)} />}
            <div className={`${CARD} flex flex-col gap-3.5 px-4 py-5 md:px-6 md:py-[22px]`}>
                <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-4">
                    <h2 className={`m-0 text-[20px] font-bold ${C.ink}`}>Scheduled email reports</h2>
                    <span className={`text-[13px] ${C.muted}`}>
                        Turn on or off, and change recipients, in each report&apos;s Settings
                        {query.data?.can_edit_settings ? " (link on each row)" : " (Admin and Sales Head)"}.
                    </span>
                </div>

                {query.isLoading && <Loading />}
                {query.error && <ErrorLine message={(query.error as Error).message} />}

                {query.data && (
                    <div className="overflow-x-auto">
                        <div className="flex min-w-[1000px] flex-col">
                            <div className={`${GRID} border-b border-[#e3e8ef] pb-2 ${TH}`}>
                                <span>Report</span>
                                <span>What it holds</span>
                                <span>When</span>
                                <span>Who gets it</span>
                                <span>Last sent</span>
                                <span />
                            </div>
                            {query.data.reports.map((r) => (
                                <div key={r.id} className={`${GRID} min-h-[58px] items-center border-b border-[#f1f4f7] py-2 text-[13px]`}>
                                    <span className="flex items-center gap-2">
                                        <span
                                            aria-label={r.enabled ? "On" : "Off"}
                                            className={`h-2 w-2 shrink-0 rounded-full ${r.enabled && r.last_sent_at ? "bg-[#1e7e34]" : r.enabled ? "bg-[#d97706]" : "bg-[#8a96a3]"}`}
                                        />
                                        <span className="flex flex-col">
                                            <span className="font-semibold">{r.label}</span>
                                            {r.attach_excel && <span className={`text-[11px] ${C.muted}`}>Excel attached</span>}
                                        </span>
                                    </span>
                                    <span className={`leading-[1.4] ${C.muted}`}>{r.description}</span>
                                    <span>{r.when}</span>
                                    <span className="break-words text-[12.5px]">
                                        {r.recipients.length ? r.recipients.join(", ") : <span className={C.muted}>Nobody yet</span>}
                                    </span>
                                    <span className={C.muted}>{lastSent(r)}</span>
                                    <span className="flex flex-col items-end gap-1">
                                        <span className="flex gap-2">
                                            <button type="button" className={BTN_SMALL} disabled={previewing !== null} onClick={() => openPreview(r)}>
                                                <Eye className="h-3.5 w-3.5" /> {previewing === r.id ? "Building…" : "Preview"}
                                            </button>
                                            <button type="button" className={BTN_SMALL} disabled={sending !== null} onClick={() => sendCopy(r)}>
                                                <Mail className="h-3.5 w-3.5" /> {sending === r.id ? "Sending…" : "Send me a copy"}
                                            </button>
                                        </span>
                                        {query.data.can_edit_settings && r.settings_href && (
                                            <Link href={r.settings_href} className="text-[12px] font-semibold text-[#138fc6]">
                                                Settings
                                            </Link>
                                        )}
                                        {note?.id === r.id && (
                                            <span className={`text-[12px] ${note.ok ? "text-[#1e7e34]" : "text-[#b42318]"}`}>{note.text}</span>
                                        )}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <span className={`text-[12px] ${C.muted}`}>
                    Green: on and sent. Amber: on, not sent yet. Grey: off. &quot;Send me a copy&quot; mails today&apos;s real report to you only and never
                    replaces the scheduled send.
                </span>
            </div>
        </>
    );
}
