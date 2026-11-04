"use client";

// ID 204 — Admin / Sales Head > Settings > EMI messages.
//   • Master switch, send hour, WhatsApp language.
//   • Financers (4 Nov): SMS and WhatsApp on / off per financer.
//   • SMS schedule (4 Nov): reminders N days before (each sends the template
//     of the EMI's own due day), the due-day "आज" SMS, overdue daily / every
//     N days / on listed days, up to a limit — with a preview.
//   • SMS templates (4 Nov): 31 day-wise reminders + आज + overdue (total) +
//     received, each with its DLT template id. An SMS without a DLT id is not sent.
//   • WhatsApp messages: per message on/off, day, Hindi text, Meta template
//     name; a changed text is held as pending until "Meta approved" is ticked.
//   • Test send.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    EMI_FIELDS,
    EMI_KIND_LABEL,
    EMI_MESSAGE_KINDS,
    type EmiLenderSwitch,
    type EmiMessageKind,
    type EmiMessagesSettings,
} from "@/lib/emi-messages/rules";
import {
    OVERDUE_MODES,
    cleanDays,
    overdueSendDays,
    toDltText,
    type EmiSmsPlan,
    type EmiSmsTemplate,
    type OverdueMode,
} from "@/lib/emi-messages/sms-plan";

type MsgDraft = {
    on: boolean;
    day: number;
    text: string;
    waTemplate: string;
    smsTemplateId: string;
    dltTemplateId: string;
    smsText: string;
    approved: string | null;
    pending: string | null;
};

type SmsDraft = Omit<EmiSmsPlan, "beforeDays" | "overdue"> & {
    beforeDaysText: string;
    dueToday: boolean;
    overdue: { on: boolean; mode: OverdueMode; every: number; daysText: string; stopAfter: number };
};

type Draft = {
    enabled: boolean;
    waLanguage: string;
    sendFromHourIst: number;
    lenders: Record<string, EmiLenderSwitch>;
    sms: SmsDraft;
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
            smsText: m.smsText,
            approved: m.text,
            pending: m.pendingText,
        };
    }
    return {
        enabled: s.enabled,
        waLanguage: s.waLanguage,
        sendFromHourIst: s.sendFromHourIst,
        lenders: { ...s.lenders },
        sms: {
            ...s.sms,
            beforeDaysText: s.sms.beforeDays.join(", "),
            overdue: { ...s.sms.overdue, daysText: s.sms.overdue.days.join(", ") },
        },
        messages,
        approve: new Set(),
    };
}

/** The draft's SMS plan as the API takes it. */
function planOf(d: SmsDraft): EmiSmsPlan {
    return {
        beforeDays: cleanDays(d.beforeDaysText, 1, 30),
        dueToday: d.dueToday,
        overdue: {
            on: d.overdue.on,
            mode: d.overdue.mode,
            every: d.overdue.every,
            days: cleanDays(d.overdue.daysText, 1, 180).reverse(),
            stopAfter: d.overdue.stopAfter,
        },
        reminders: d.reminders,
        dueTodayTpl: d.dueTodayTpl,
        overdueTpl: d.overdueTpl,
        receivedTpl: d.receivedTpl,
    };
}

const INPUT = "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm";
const MODE_LABEL: Record<OverdueMode, string> = {
    daily: "Every day",
    every: "Every N days",
    days: "Only on these overdue days",
};
const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** "EMI due on the 20th" — the dates each SMS goes, in the current month. */
function PlanPreview({ plan, dueDay }: { plan: EmiSmsPlan; dueDay: number }) {
    const now = new Date();
    const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dueDay));
    const shift = (n: number) => new Date(due.getTime() + n * 86_400_000);
    const od = overdueSendDays(plan);
    return (
        <ul className="mt-2 space-y-1 text-xs text-ink">
            {[...plan.beforeDays].sort((a, b) => b - a).map((n) => (
                <li key={`b${n}`}>
                    <b>{fmt(shift(-n))}</b> ({n} day{n > 1 ? "s" : ""} before) — reminder template &quot;देय तिथि {dueDay} तारीख है&quot;
                </li>
            ))}
            {plan.dueToday && (
                <li>
                    <b>{fmt(due)}</b> (due day) — &quot;आज देय है&quot;
                </li>
            )}
            {od.length > 0 && (
                <li>
                    Overdue (total amount): {od.length > 12 ? `${od.slice(0, 10).map((d) => fmt(shift(d))).join(", ")} … ${fmt(shift(od[od.length - 1]!))}` : od.map((d) => fmt(shift(d))).join(", ")}{" "}
                    — {od.length} SMS, last one {od[od.length - 1]} day(s) overdue
                </li>
            )}
            {!plan.beforeDays.length && !plan.dueToday && !od.length && <li className="text-rose-700">No SMS is scheduled.</li>}
        </ul>
    );
}

function TplRow({
    label,
    tpl,
    onChange,
}: {
    label: string;
    tpl: EmiSmsTemplate;
    onChange: (t: EmiSmsTemplate) => void;
}) {
    return (
        <tr className="border-t border-border align-top">
            <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-ink">{label}</td>
            <td className="px-2 py-2">
                <input
                    value={tpl.dltTemplateId}
                    onChange={(e) => onChange({ ...tpl, dltTemplateId: e.target.value })}
                    placeholder="DLT template id"
                    className="w-44 rounded border border-border px-1.5 py-1 text-xs"
                />
            </td>
            <td className="px-2 py-2">
                <textarea
                    value={tpl.text}
                    onChange={(e) => onChange({ ...tpl, text: e.target.value })}
                    rows={2}
                    className="w-full rounded border border-border px-1.5 py-1 text-xs"
                />
                <p className="mt-0.5 text-[11px] text-ink-muted">DLT: {toDltText(tpl.text)}</p>
            </td>
        </tr>
    );
}

export function EmiMessagesForm() {
    const qc = useQueryClient();
    const { data, isLoading } = useQuery({
        queryKey: ["emi-messages-settings"],
        queryFn: async () => {
            const r = await fetch("/api/admin/settings/emi-messages", { cache: "no-store" });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not load");
            return j.data as {
                settings: EmiMessagesSettings;
                lenders: Array<{ id: string; name: string }>;
                ready: boolean;
                smsReady: boolean;
            };
        },
    });
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saving, setSaving] = useState(false);
    const [previewDay, setPreviewDay] = useState(20);
    const [testPhone, setTestPhone] = useState("");
    const [testDay, setTestDay] = useState(20);
    const [testWhatsapp, setTestWhatsapp] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResults, setTestResults] = useState<Array<{ kind: string; channel: string; status: string; error: string | null }>>([]);

    useEffect(() => {
        if (data) setDraft(toDraft(data.settings));
    }, [data]);

    const plan = useMemo(() => (draft ? planOf(draft.sms) : null), [draft]);

    if (isLoading || !draft || !data || !plan) return <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />;

    const setMsg = (k: EmiMessageKind, patch: Partial<MsgDraft>) =>
        setDraft((d) => (d ? { ...d, messages: { ...d.messages, [k]: { ...d.messages[k], ...patch } } } : d));
    const setSms = (patch: Partial<SmsDraft>) => setDraft((d) => (d ? { ...d, sms: { ...d.sms, ...patch } } : d));
    const setOverdue = (patch: Partial<SmsDraft["overdue"]>) =>
        setDraft((d) => (d ? { ...d, sms: { ...d.sms, overdue: { ...d.sms.overdue, ...patch } } } : d));
    const setLender = (id: string, patch: Partial<EmiLenderSwitch>) =>
        setDraft((d) => {
            if (!d) return d;
            const cur = d.lenders[id] ?? { sms: false, whatsapp: false };
            return { ...d, lenders: { ...d.lenders, [id]: { ...cur, ...patch } } };
        });
    const setReminder = (i: number, t: EmiSmsTemplate) =>
        setSms({ reminders: draft.sms.reminders.map((r, j) => (j === i ? t : r)) });

    const allTpls = [...draft.sms.reminders, draft.sms.dueTodayTpl, draft.sms.overdueTpl, draft.sms.receivedTpl];
    const withDlt = allTpls.filter((t) => t.dltTemplateId.trim()).length;

    const save = async () => {
        setSaving(true);
        try {
            const messages = Object.fromEntries(
                EMI_MESSAGE_KINDS.map((k) => {
                    const m = draft.messages[k];
                    return [k, { on: m.on, day: m.day, text: m.text, waTemplate: m.waTemplate, smsTemplateId: m.smsTemplateId, dltTemplateId: m.dltTemplateId, smsText: m.smsText }];
                }),
            );
            const r = await fetch("/api/admin/settings/emi-messages", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    enabled: draft.enabled,
                    lenders: draft.lenders,
                    sms: plan,
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
                body: JSON.stringify({ phone: testPhone, sms: true, smsDay: testDay, whatsapp: testWhatsapp }),
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
            {data.ready && !data.smsReady && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    The SMS schedule needs migration E-371 on this server. Until it is applied no scheduled SMS goes (WhatsApp is not affected).
                </p>
            )}

            {/* General */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <label className="flex items-center gap-2 text-sm font-medium text-ink">
                    <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                        className="h-4 w-4"
                    />
                    EMI messages on (master switch)
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

            {/* Financers */}
            <section className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold text-ink">Financers</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    Customers of a financer get EMI messages only on the channels switched on here.
                </p>
                <table className="mt-3 w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-ink-muted">
                            <th className="px-2 py-1 font-medium">Financer</th>
                            <th className="px-2 py-1 font-medium">SMS</th>
                            <th className="px-2 py-1 font-medium">WhatsApp</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.lenders.map((l) => {
                            const sw = draft.lenders[l.id] ?? { sms: false, whatsapp: false };
                            return (
                                <tr key={l.id} className="border-t border-border">
                                    <td className="px-2 py-1.5 text-ink">{l.name}</td>
                                    <td className="px-2 py-1.5">
                                        <input type="checkbox" checked={sw.sms} onChange={(e) => setLender(l.id, { sms: e.target.checked })} className="h-4 w-4" aria-label={`SMS for ${l.name}`} />
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <input type="checkbox" checked={sw.whatsapp} onChange={(e) => setLender(l.id, { whatsapp: e.target.checked })} className="h-4 w-4" aria-label={`WhatsApp for ${l.name}`} />
                                    </td>
                                </tr>
                            );
                        })}
                        {data.lenders.length === 0 && (
                            <tr>
                                <td colSpan={3} className="px-2 py-2 text-xs text-ink-muted">No active financers.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </section>

            {/* SMS schedule */}
            <section className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold text-ink">SMS schedule</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    Each step goes once per EMI, only while it is unpaid. A reminder uses the template of the EMI&apos;s own due day.
                    The overdue SMS carries the loan&apos;s total unpaid and goes once a day per loan at most.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <label className="text-sm text-ink">
                        Reminder: days before the due date
                        <input
                            value={draft.sms.beforeDaysText}
                            onChange={(e) => setSms({ beforeDaysText: e.target.value })}
                            placeholder="e.g. 7, 5, 1"
                            className={`mt-1 ${INPUT}`}
                        />
                        <span className="text-[11px] text-ink-muted">Comma-separated, 1–30. Empty = no reminders before.</span>
                    </label>
                    <label className="flex items-center gap-2 self-start pt-6 text-sm text-ink">
                        <input type="checkbox" checked={draft.sms.dueToday} onChange={(e) => setSms({ dueToday: e.target.checked })} className="h-4 w-4" />
                        On the due day, send &quot;आज देय है&quot;
                    </label>
                </div>
                <div className="mt-4 rounded-md bg-surface-muted/40 p-3">
                    <label className="flex items-center gap-2 text-sm font-medium text-ink">
                        <input type="checkbox" checked={draft.sms.overdue.on} onChange={(e) => setOverdue({ on: e.target.checked })} className="h-4 w-4" />
                        Overdue SMS (total amount)
                    </label>
                    {draft.sms.overdue.on && (
                        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
                            <label className="text-xs text-ink-muted">
                                How often
                                <select
                                    value={draft.sms.overdue.mode}
                                    onChange={(e) => setOverdue({ mode: e.target.value as OverdueMode })}
                                    className={INPUT}
                                >
                                    {OVERDUE_MODES.map((m) => (
                                        <option key={m} value={m}>
                                            {MODE_LABEL[m]}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {draft.sms.overdue.mode === "every" && (
                                <label className="text-xs text-ink-muted">
                                    Every N days (from day 1 overdue)
                                    <input
                                        type="number"
                                        min={2}
                                        max={30}
                                        value={draft.sms.overdue.every}
                                        onChange={(e) => setOverdue({ every: Number(e.target.value) })}
                                        className={INPUT}
                                    />
                                </label>
                            )}
                            {draft.sms.overdue.mode === "days" && (
                                <label className="text-xs text-ink-muted">
                                    Overdue days
                                    <input
                                        value={draft.sms.overdue.daysText}
                                        onChange={(e) => setOverdue({ daysText: e.target.value })}
                                        placeholder="e.g. 1, 3, 7, 15, 30"
                                        className={INPUT}
                                    />
                                </label>
                            )}
                            <label className="text-xs text-ink-muted">
                                Stop after (days overdue)
                                <input
                                    type="number"
                                    min={1}
                                    max={180}
                                    value={draft.sms.overdue.stopAfter}
                                    onChange={(e) => setOverdue({ stopAfter: Number(e.target.value) })}
                                    className={INPUT}
                                />
                            </label>
                        </div>
                    )}
                </div>
                <div className="mt-4">
                    <label className="text-xs text-ink-muted">
                        Preview for an EMI due on the{" "}
                        <select value={previewDay} onChange={(e) => setPreviewDay(Number(e.target.value))} className="rounded border border-border px-1 py-0.5 text-xs">
                            {Array.from({ length: 31 }, (_, i) => (
                                <option key={i + 1} value={i + 1}>
                                    {i + 1}
                                </option>
                            ))}
                        </select>
                    </label>
                    <PlanPreview plan={plan} dueDay={previewDay} />
                </div>
            </section>

            {/* SMS templates */}
            <details className="rounded-lg border border-border p-4">
                <summary className="cursor-pointer text-sm font-semibold text-ink">
                    SMS templates (DLT) — {withDlt} of {allTpls.length} have a DLT template id
                </summary>
                <p className="mt-2 text-xs text-ink-muted">
                    Register each text on DLT exactly as shown under it, then enter its DLT template id. An SMS without a DLT id
                    is not sent. Fields: {"{lender}"} → {"{#var#}"} (up to 30 characters), {"{amount}"} / {"{total_due}"} →{" "}
                    {"{#numeric#}"}, {"{paid_date}"} → {"{#alphanumeric#}"}.
                </p>
                <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[720px]">
                        <thead>
                            <tr className="text-left text-xs text-ink-muted">
                                <th className="px-2 py-1 font-medium">Template</th>
                                <th className="px-2 py-1 font-medium">DLT template id</th>
                                <th className="px-2 py-1 font-medium">Text</th>
                            </tr>
                        </thead>
                        <tbody>
                            {draft.sms.reminders.map((t, i) => (
                                <TplRow key={i} label={`Reminder — day ${i + 1}`} tpl={t} onChange={(n) => setReminder(i, n)} />
                            ))}
                            <TplRow label="Due today (आज)" tpl={draft.sms.dueTodayTpl} onChange={(n) => setSms({ dueTodayTpl: n })} />
                            <TplRow label="Overdue (total)" tpl={draft.sms.overdueTpl} onChange={(n) => setSms({ overdueTpl: n })} />
                            <TplRow label="Payment received" tpl={draft.sms.receivedTpl} onChange={(n) => setSms({ receivedTpl: n })} />
                        </tbody>
                    </table>
                </div>
            </details>

            {/* WhatsApp */}
            <details className="rounded-lg border border-border p-4">
                <summary className="cursor-pointer text-sm font-semibold text-ink">WhatsApp messages</summary>
                <p className="mt-2 text-xs text-ink-muted">
                    Fields a text may use: {EMI_FIELDS.map((f) => `{${f}}`).join(" ")}. The WhatsApp template&apos;s body must
                    have the same fields in the same order. SMS do not use these texts — they follow the SMS schedule above.
                </p>
                <div className="mt-3 space-y-4">
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
                                <textarea value={m.text} onChange={(e) => setMsg(k, { text: e.target.value })} rows={2} className={`mt-2 ${INPUT}`} />
                                {m.approved && changed && <p className="mt-1 text-xs text-ink-muted">Sent now: {m.approved}</p>}
                                <label className="mt-2 block text-xs text-ink-muted">
                                    WhatsApp template name
                                    <input value={m.waTemplate} onChange={(e) => setMsg(k, { waTemplate: e.target.value })} className={INPUT} />
                                </label>
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
                                        Meta has approved this exact text — start sending it
                                    </label>
                                )}
                            </section>
                        );
                    })}
                </div>
            </details>

            <div className="flex justify-end">
                <Button type="button" onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    Save
                </Button>
            </div>

            <div className="rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold text-ink">Test send</h3>
                <p className="mt-1 text-xs text-ink-muted">
                    Sends 4 SMS with sample values — the reminder of the chosen due day, &quot;आज&quot;, overdue and received — and,
                    if ticked, every WhatsApp message. Save first.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                        value={testPhone}
                        onChange={(e) => setTestPhone(e.target.value)}
                        placeholder="10-digit mobile"
                        className="w-48 rounded-md border border-border px-2 py-1.5 text-sm"
                    />
                    <label className="text-xs text-ink-muted">
                        Reminder day{" "}
                        <select value={testDay} onChange={(e) => setTestDay(Number(e.target.value))} className="rounded border border-border px-1 py-1 text-xs">
                            {Array.from({ length: 31 }, (_, i) => (
                                <option key={i + 1} value={i + 1}>
                                    {i + 1}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 text-xs text-ink">
                        <input type="checkbox" checked={testWhatsapp} onChange={(e) => setTestWhatsapp(e.target.checked)} className="h-4 w-4" />
                        Also WhatsApp
                    </label>
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
