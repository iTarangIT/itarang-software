"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  initialPrefs: Record<string, unknown>;
}

interface PrefRow {
  key: string;
  label: string;
  description: string;
}

const EVENT_PREFS: PrefRow[] = [
  { key: "alerts_critical", label: "Critical battery alerts", description: "Offline > 24h, BMS fault, geo-shift > 100 km, high temperature" },
  { key: "alerts_warning", label: "Warning battery alerts", description: "Usage drop, SOH decline" },
  { key: "recovery_stage_change", label: "Recovery stage changes", description: "Borrower moves through inspection / refurb / auction lanes" },
  { key: "immobilisation_status", label: "Immobilisation request status", description: "Approved, rejected, executed, remobilised" },
  { key: "weekly_digest", label: "Weekly portfolio digest", description: "Saturday summary of CDS distribution + recovery activity" },
];

const CHANNELS = ["email", "in_app"] as const;
type Channel = (typeof CHANNELS)[number];

function read(prefs: Record<string, unknown>, key: string, channel: Channel): boolean {
  const row = prefs[key];
  if (!row || typeof row !== "object") return channel === "in_app"; // sensible default
  const v = (row as Record<string, unknown>)[channel];
  return typeof v === "boolean" ? v : channel === "in_app";
}

export default function NotificationPrefsSection({ initialPrefs }: Props) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Record<string, Record<Channel, boolean>>>(() => {
    const out: Record<string, Record<Channel, boolean>> = {};
    for (const row of EVENT_PREFS) {
      out[row.key] = {
        email: read(initialPrefs, row.key, "email"),
        in_app: read(initialPrefs, row.key, "in_app"),
      };
    }
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string, channel: Channel) {
    setPrefs((p) => ({ ...p, [key]: { ...p[key], [channel]: !p[key][channel] } }));
    setSavedAt(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/users/notification-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefs }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSavedAt(new Date());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">
          My notification preferences
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Email + in-app delivery per event. Saved per user, not per tenant.
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-bold">Event</th>
            <th className="px-3 py-2 text-center font-bold">Email</th>
            <th className="px-3 py-2 text-center font-bold">In-app</th>
          </tr>
        </thead>
        <tbody>
          {EVENT_PREFS.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-2">
                <div className="font-medium">{row.label}</div>
                <div className="text-xs text-slate-500">{row.description}</div>
              </td>
              {CHANNELS.map((ch) => (
                <td key={ch} className="px-3 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={prefs[row.key]?.[ch] ?? false}
                    onChange={() => toggle(row.key, ch)}
                    disabled={busy}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {error ? (
        <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>
      ) : null}

      <div className="flex justify-end items-center gap-3">
        {savedAt ? (
          <span className="text-xs text-emerald-700">
            Saved at {savedAt.toLocaleTimeString()}
          </span>
        ) : null}
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </section>
  );
}
