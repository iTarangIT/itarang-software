"use client";

// ID 204 — Admin > Settings > EMI messages. On/off, the pilot lender, the send
// hour, and per message: on/off, the day, the Hindi text with fixed fields,
// the WhatsApp template name, the MSG91 Flow template id and the DLT id. A
// changed text is held as pending until "Meta + DLT approved" is ticked.
// Test send: every message to one phone on both channels.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    EMI_FIELDS,
    EMI_KIND_LABEL,
    EMI_MESSAGE_KINDS,
    type EmiMessageKind,
    type EmiMessagesSettings,
} from "@/lib/emi-messages/rules";

type MsgDraft = {
    on: boolean;
    day: number;
    text: string;
    waTemplate: string;
    smsTemplateId: string;
    dltTemplateId: string;
    approved: string | null;
    pending: string | null;
};

type Draft = {
    enabled: boolean;
    pilotNbfcId: string;
    waLanguage: string;
    sendFromHourIst: number;
    messages: Record<EmiMessageKind, MsgDraft>;
    approve: Set<EmiMessageKind>;
};

function toDraft(s: EmiMessagesSettings): Draft {
    const messages = {} as Record<EmiMessageKind, MsgDraft>;
    for (const k of EMI_MESSAGE_KINDS) {
        const m = s.messages[k];
        messages[k] = {
            on: m.on,
            day: m.day,
            text: m.pendingText ?? m.text ?? "",
            waTemplate: m.waTemplate,
            smsTemplateId: m.smsTemplateId,
            dltTemplateId: m.dltTemplateId,
            approved: m.text,
            pending: m.pendingText,
        };
    }
    return {
        enabled: s.enabled,
        pilotNbfcId: s.pilotNbfcId ?? "",
        waLanguage: s.waLanguage,
        sendFromHourIst: s.sendFromHourIst,
        messages,
        approve: new Set(),
    };
}

const INPUT = "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm";

export function EmiMessagesForm() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ["emi-messages-settings"],
        queryFn: async () => {
            const r = await fetch("/api/admin/settings/emi-messages", { cache: "no-store" });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load");
            return j.data as { settings: EmiMessagesSettings; lenders: Array<{ id: string; name: string }>; ready: boolean };
        },
    });
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saving, setSaving] = useState(false);
    const [testPhone, setTestPhone] = useState("");
    const [testing, setTesting] = useState(false);
    const [testResults, setTestResults] = useState<Array<{ kind: string; channel: string; status: string; error: string | null }>>([]);

    useEffect(() => {
        if (data) setDraft(toDraft(data.settings));
    }, [data]);

    if (isLoading || !draft || !data) return <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />;

    const setMsg = (k: EmiMessageKind, patch: Partial<MsgDraft>) =>
        setDraft((d) => (d ? { ...d, messages: { ...d.messages, [k]: { ...d.messages[k], ...patch } } } : d));

    const save = async () => {
        setSaving(true);
        try {
            const messages = Object.fromEntries(
                EMI_MESSAGE_KINDS.map((k) => {
                    const m = draft.messages[k];
                    return [k, { on: m.on, day: m.day, text: m.text, waTemplate: m.waTemplate, smsTemplateId: m.smsTemplateId, dltTemplateId: m.dltTemplateId }];
                }),
            );
            const r = await fetch("/api/admin/settings/emi-messages", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    enabled: draft.enabled,
                    pilotNbfcId: draft.pilotNbfcId || null,
                    waLanguage: draft.waLanguage,
                    sendFromHourIst: draft.sendFromHourIst,
                    messages,
                    approve: [...draft.approve],
                }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not save");
            toast.success("EMI message settings saved.");
            qc.invalidateQueries({ queryKey: ["emi-messages-settings"] });
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const test = async () => {
        setTesting(true);
        setTestResults([]);
        try {
            const r = await fetch("/api/admin/settings/emi-messages/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: testPhone }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Test send failed");
            setTestResults(j.data.results);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setTesting(false);
        }
    };

    return (
        <div className="space-y-6">
            {!data.ready && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    Not set up on this server yet (migration E-365). Settings can be saved; nothing is sent until it is applied.
                </p>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <label className="flex items-center gap-2 text-sm font-medium text-ink">
                    <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                        className="h-4 w-4"
                    />
                    EMI messages on
                </label>
                <label className="text-sm text-ink">
                    Pilot lender
                    <select
                        value={draft.pilotNbfcId}
                        onChange={(e) => setDraft({ ...draft, pilotNbfcId: e.target.value })}
                        className={`mt-1 ${INPUT}`}
                    >
                        <option value="">Not picked (nothing scheduled is sent)</option>
                        {data.lenders.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="text-sm text-ink">
                    Send from (IST hour)
                    <input
                        type="number"
                        min={0}
                        max={20}
                        value={draft.sendFromHourIst}
                        onChange={(e) => setDraft({ ...draft, sendFromHourIst: Number(e.target.value) })}
                        className={`mt-1 ${INPUT}`}
                    />
                </label>
                <label className="text-sm text-ink">
                    WhatsApp template language
                    <input
                        value={draft.waLanguage}
                        onChange={(e) => setDraft({ ...draft, waLanguage: e.target.value })}
                        className={`mt-1 ${INPUT}`}
                    />
                </label>
            </div>

            <p className="text-xs text-ink-muted">
                Fields a text may use: {EMI_FIELDS.map((f) => `{${f}}`).join(" ")}. The WhatsApp template&apos;s body must
                have the same fields in the same order; the MSG91 Flow template names its variables the same (##name## …).
            </p>

            <div className="space-y-4">
                {EMI_MESSAGE_KINDS.map((k) => {
                    const m = draft.messages[k];
                    const changed = m.text.trim() !== (m.approved ?? "");
                    return (
                        <section key={k} className="rounded-lg border border-border p-4">
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                                    <input type="checkbox" checked={m.on} onChange={(e) => setMsg(k, { on: e.target.checked })} className="h-4 w-4" />
                                    {EMI_KIND_LABEL[k]}
                                </label>
                                {k !== "received" ? (
                                    <label className="flex items-center gap-1 text-xs text-ink-muted">
                                        Day
                                        <input
                                            type="number"
                                            value={m.day}
                                            min={-30}
                                            max={90}
                                            onChange={(e) => setMsg(k, { day: Number(e.target.value) })}
                                            className="w-16 rounded border border-border px-1 py-0.5 text-xs"
                                        />
                                        <span>
                                            {m.day < 0 ? `${-m.day} day(s) before the due date` : m.day === 0 ? "on the due date" : `${m.day} day(s) overdue`}
                                        </span>
                                    </label>
                                ) : (
                                    <span className="text-xs text-ink-muted">On every recorded payment</span>
                                )}
                                <span
                                    className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                        m.approved && !changed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                                    }`}
                                >
                                    {m.approved && !changed ? "Approved — sending this text" : m.approved ? "Changed — waiting for approval" : "Not approved — not sent"}
                                </span>
                            </div>
                            <textarea
                                value={m.text}
                                onChange={(e) => setMsg(k, { text: e.target.value })}
                                rows={2}
                                className={`mt-2 ${INPUT}`}
                            />
                            {m.approved && changed && (
                                <p className="mt-1 text-xs text-ink-muted">Sent now: {m.approved}</p>
                            )}
                            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                                <label className="text-xs text-ink-muted">
                                    WhatsApp template name
                                    <input value={m.waTemplate} onChange={(e) => setMsg(k, { waTemplate: e.target.value })} className={INPUT} />
                                </label>
                                <label className="text-xs text-ink-muted">
                                    MSG91 Flow template id
                                    <input value={m.smsTemplateId} onChange={(e) => setMsg(k, { smsTemplateId: e.target.value })} className={INPUT} />
                                </label>
                                <label className="text-xs text-ink-muted">
                                    DLT template id
                                    <input value={m.dltTemplateId} onChange={(e) => setMsg(k, { dltTemplateId: e.target.value })} className={INPUT} />
                                </label>
                            </div>
                            {changed && m.text.trim() && (
                                <label className="mt-2 flex items-center gap-2 text-xs text-ink">
                                    <input
                                        type="checkbox"
                                        checked={draft.approve.has(k)}
                                        onChange={(e) => {
                                            const next = new Set(draft.approve);
                                            if (e.target.checked) next.add(k);
                                            else next.delete(k);
                                            setDraft({ ...draft, approve: next });
                                        }}
                                        className="h-4 w-4"
                                    />
                                    Meta and DLT have approved this exact text — start sending it
                                </label>
                            )}
                        </section>
                    );
                })}
            </div>

            <div className="flex justify-end">
                <Button type="button" onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Save
                </Button>
            </div>

            <div className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold text-ink">Test send</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    Sends every message (the pending text where there is one) to this phone on WhatsApp and SMS, with
                    sample values. Save first.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                        value={testPhone}
                        onChange={(e) => setTestPhone(e.target.value)}
                        placeholder="10-digit mobile"
                        className="w-48 rounded-md border border-border px-2 py-1.5 text-sm"
                    />
                    <Button type="button" variant="outline" onClick={test} disabled={testing || !testPhone.trim()}>
                        {testing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                        Send test messages
                    </Button>
                </div>
                {testResults.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs">
                        {testResults.map((r, i) => (
                            <li key={i} className={r.status === "sent" ? "text-emerald-700" : "text-rose-700"}>
                                {EMI_KIND_LABEL[r.kind as EmiMessageKind] ?? r.kind} · {r.channel === "sms" ? "SMS" : "WhatsApp"}: {r.status}
                                {r.error ? ` — ${r.error}` : ""}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
