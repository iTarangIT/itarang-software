"use client";

// 27 Nov — Settings › File action alerts (/api/admin/settings/file-action-alerts).

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Bell, ChevronDown, Lock, Mail, MessageCircle, RotateCcw, Search } from "lucide-react";

import {
  CHANNELS,
  CHANNEL_LABELS,
  PARTIES,
  PARTY_LABELS,
  suggestedRule,
  type Channel,
  type PartyKey,
  type TypeRule,
} from "@/lib/notifications/party-routing-rules";

type TypeRow = { value: string; label: string; emailLocked: boolean };
type Group = { category: string; types: TypeRow[] };

const CHANNEL_ICON: Record<Channel, typeof Bell> = { bell: Bell, email: Mail, whatsapp: MessageCircle };

function countOn(rule: TypeRule): number {
  return PARTIES.filter((p) => CHANNELS.some((c) => rule[p][c])).length;
}

export default function FileActionAlertsForm() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [rules, setRules] = useState<Record<string, TypeRule>>({});
  const [saved, setSaved] = useState<string>("{}");
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/settings/file-action-alerts", { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (!j?.success) return toast.error(j?.error?.message || "Could not load the settings");
    setGroups(j.data.groups);
    setRules(j.data.rules ?? {});
    setSaved(JSON.stringify(j.data.rules ?? {}));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const dirty = JSON.stringify(rules) !== saved;

  const filtered = useMemo(() => {
    if (!groups) return null;
    const term = q.trim().toLowerCase();
    if (!term) return groups;
    return groups
      .map((g) => ({ ...g, types: g.types.filter((t) => `${t.label} ${g.category}`.toLowerCase().includes(term)) }))
      .filter((g) => g.types.length > 0);
  }, [groups, q]);

  function toggle(type: string, party: PartyKey, ch: Channel) {
    setRules((r) => {
      const rule = r[type];
      if (!rule) return r;
      return { ...r, [type]: { ...rule, [party]: { ...rule[party], [ch]: !rule[party][ch] } } };
    });
  }
  function setColumn(type: string, ch: Channel, on: boolean) {
    setRules((r) => {
      const rule = r[type];
      if (!rule) return r;
      const next = { ...rule };
      for (const p of PARTIES) next[p] = { ...next[p], [ch]: on };
      return { ...r, [type]: next };
    });
  }
  function customise(type: string) {
    setRules((r) => ({ ...r, [type]: suggestedRule() }));
    setOpen(type);
  }
  function reset(type: string) {
    setRules((r) => {
      const next = { ...r };
      delete next[type];
      return next;
    });
  }
  function copyToCategory(type: string, group: Group) {
    const rule = rules[type];
    if (!rule) return;
    setRules((r) => {
      const next = { ...r };
      for (const t of group.types) next[t.value] = JSON.parse(JSON.stringify(rule));
      return next;
    });
    toast.success(`Copied to all ${group.types.length} actions in ${group.category}. Save to apply.`);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/file-action-alerts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Save failed");
      setRules(j.data.rules);
      setSaved(JSON.stringify(j.data.rules));
      toast.success("Saved — applies from the next action.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!filtered) return <p className="text-sm text-ink-muted">Loading…</p>;

  const customCount = Object.keys(rules).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search actions (e.g. sanction, CIBIL, FI)"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100"
          />
        </label>
        <div className="flex items-center gap-3">
          <span className="text-sm text-ink-muted">
            {customCount} customised · the rest use built-in rules
          </span>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg bg-[color:var(--color-brand-navy)] px-5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>
      </div>

      {filtered.map((g) => (
        <section key={g.category} className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-800">
            {g.category} <span className="ml-1 font-normal text-slate-400">{g.types.length}</span>
          </h2>
          <ul className="divide-y divide-slate-100">
            {g.types.map((t) => {
              const rule = rules[t.value];
              const isOpen = open === t.value;
              return (
                <li key={t.value}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : t.value)}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50"
                  >
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-slate-400 transition ${isOpen ? "rotate-180" : ""}`}
                    />
                    <span className="flex-1 text-sm font-medium text-slate-800">{t.label}</span>
                    {rule ? (
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                        Custom · {countOn(rule)} of {PARTIES.length} people
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                        Built-in
                      </span>
                    )}
                  </button>

                  {isOpen ? (
                    <div className="bg-slate-50/60 px-5 pb-5 pt-1">
                      {!rule ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3">
                          <p className="text-sm text-slate-600">
                            This action uses the built-in rules (who gets it is decided in the code today).
                          </p>
                          <button
                            onClick={() => customise(t.value)}
                            className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white"
                          >
                            Choose who gets it
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                            <table className="w-full text-sm">
                              <thead className="bg-slate-50 text-xs text-slate-500">
                                <tr>
                                  <th className="px-4 py-2 text-left font-medium">Person</th>
                                  {CHANNELS.map((c) => {
                                    const Icon = CHANNEL_ICON[c];
                                    const all = PARTIES.every((p) => rule[p][c]);
                                    return (
                                      <th key={c} className="px-4 py-2 text-center font-medium">
                                        <span className="inline-flex items-center gap-1">
                                          <Icon className="h-3.5 w-3.5" /> {CHANNEL_LABELS[c]}
                                        </span>
                                        <button
                                          onClick={() => setColumn(t.value, c, !all)}
                                          className="mt-0.5 block w-full text-[11px] font-normal text-sky-700 hover:underline"
                                        >
                                          {all ? "none" : "all"}
                                        </button>
                                      </th>
                                    );
                                  })}
                                </tr>
                              </thead>
                              <tbody>
                                {PARTIES.map((p) => (
                                  <tr key={p} className="border-t border-slate-100">
                                    <td className="px-4 py-2.5">
                                      <div className="font-medium text-slate-800">{PARTY_LABELS[p].label}</div>
                                      <div className="text-xs text-slate-500">{PARTY_LABELS[p].hint}</div>
                                    </td>
                                    {CHANNELS.map((c) => (
                                      <td key={c} className="px-4 py-2.5 text-center">
                                        <input
                                          type="checkbox"
                                          aria-label={`${PARTY_LABELS[p].label} — ${CHANNEL_LABELS[c]}`}
                                          checked={rule[p][c]}
                                          onChange={() => toggle(t.value, p, c)}
                                          className="h-4 w-4 cursor-pointer accent-[color:var(--color-brand-navy)]"
                                        />
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {t.emailLocked ? (
                            <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-amber-700">
                              <Lock className="h-3.5 w-3.5" /> This action carries a signing / consent link — anyone
                              who already gets it by email keeps that email even if unticked.
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap gap-4 text-sm">
                            <button
                              onClick={() => copyToCategory(t.value, g)}
                              className="font-medium text-sky-700 hover:underline"
                            >
                              Use these ticks for every action in {g.category}
                            </button>
                            <button
                              onClick={() => reset(t.value)}
                              className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Back to built-in
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="text-xs text-ink-muted max-w-4xl">
        Ticked people are added; unticked people stop getting that channel for this action. iTarang Admin, CEO and
        Business Head keep their built-in alerts either way. The &ldquo;Action person&rdquo; column only decides for
        the person who did the action — e.g. an NBFC approver is not alerted about their own approval unless ticked
        there. WhatsApp goes to the phone saved on the login (dealer: the dealer&rsquo;s WhatsApp number).
      </p>
    </div>
  );
}
