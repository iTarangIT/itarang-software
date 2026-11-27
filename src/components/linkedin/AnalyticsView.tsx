"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import { LI_CATEGORIES, UNCATEGORISED } from "@/lib/linkedin/categories";

import { DownloadButtons, liFetch } from "./api";
import { LI_BASE } from "./LinkedInTabs";

type Funnel = {
  selected: number;
  approached: number;
  invited: number;
  accepted: number;
  replied: number;
  meetings: number;
  positive: number;
};
type CategoryRow = Funnel & { category: string; campaigns: number };
type CampaignRow = Funnel & { campaign_id: string; name: string; status: string; category: string; account_id: string; created_at: string };
type Data = { categories: CategoryRow[]; total: CategoryRow; campaigns: CampaignRow[]; extras_ready: boolean };
type Account = { id: string; label: string };

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "—");

const STAGES: { key: keyof Funnel; label: string; tone: string }[] = [
  { key: "approached", label: "Approached", tone: "bg-slate-500" },
  { key: "accepted", label: "Invite accepted", tone: "bg-blue-500" },
  { key: "replied", label: "Replied", tone: "bg-teal-500" },
  { key: "meetings", label: "Meeting scheduled", tone: "bg-indigo-600" },
];

function istDate(offsetDays: number): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Horizontal funnel: each stage's bar is its share of Approached. */
function FunnelBars({ f }: { f: Funnel }) {
  return (
    <div className="space-y-2">
      {STAGES.map((s) => {
        const v = f[s.key];
        const w = f.approached > 0 ? Math.max((v / f.approached) * 100, v > 0 ? 1.5 : 0) : 0;
        return (
          <div key={s.key} className="grid grid-cols-[140px_1fr_110px] items-center gap-3 text-sm">
            <span className="text-gray-700">{s.label}</span>
            <div className="h-5 rounded bg-gray-100">
              <div className={`h-5 rounded ${s.tone}`} style={{ width: `${w}%` }} />
            </div>
            <span className="text-right tabular-nums text-gray-900">
              <strong>{v}</strong>
              {s.key !== "approached" && <span className="ml-1 text-xs text-gray-500">{pct(v, f.approached)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AnalyticsView() {
  const [from, setFrom] = useState(istDate(-29));
  const [to, setTo] = useState(istDate(0));
  const [category, setCategory] = useState("");
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState("");

  const params = useMemo(
    () => ({ from, to, category, account_id: accountId, status }),
    [from, to, category, accountId, status],
  );
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();

  const accounts = useQuery({ queryKey: ["li-accounts"], queryFn: () => liFetch<{ accounts: Account[] }>("/api/linkedin/accounts") });
  const q = useQuery({ queryKey: ["li-analytics", qs], queryFn: () => liFetch<Data>(`/api/linkedin/analytics?${qs}`) });
  const d = q.data;

  const field = "rounded-md border border-gray-300 px-2 py-1.5 text-sm";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">From (first contact)</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        <div className="flex gap-1 pb-0.5">
          {[
            ["7 days", -6],
            ["30 days", -29],
            ["90 days", -89],
          ].map(([label, off]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setFrom(istDate(off as number));
                setTo(istDate(0));
              }}
              className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            All time
          </button>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
            <option value="">All</option>
            {[...LI_CATEGORIES, UNCATEGORISED].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">Account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={field}>
            <option value="">All</option>
            {(accounts.data?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-600">Campaign status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
            <option value="">All</option>
            {["running", "paused", "stopped", "done", "draft"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex flex-wrap gap-3">
          <DownloadButtons type="analytics" params={params} label="Download summary" />
          <DownloadButtons type="campaign_rows" params={params} label="Download prospects" />
        </div>
      </div>

      {d && !d.extras_ready && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Categories and meetings are not switched on yet on this server (database migration E-398). Every campaign shows as
          Uncategorised and meetings as 0 until it is applied.
        </p>
      )}
      {q.isError && <p className="text-sm text-red-600">{(q.error as Error).message}</p>}
      {!d && !q.isError && <p className="text-sm text-gray-500">Loading…</p>}

      {d && (
        <>
          <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-1 text-sm font-semibold text-gray-900">
                {category || "All categories"} — {d.total.campaigns} campaign{d.total.campaigns === 1 ? "" : "s"}
              </h2>
              <p className="mb-3 text-xs text-gray-500">
                Approached = invite sent, or a direct message to an existing connection. Percentages are of Approached. Meetings count
                only what was marked in the Inbox.
              </p>
              <FunnelBars f={d.total} />
            </section>

            <section className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Campaigns</th>
                    <th className="px-3 py-2 text-right">Approached</th>
                    <th className="px-3 py-2 text-right">Accepted</th>
                    <th className="px-3 py-2 text-right">Replied</th>
                    <th className="px-3 py-2 text-right">Meetings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {d.categories.map((c) => (
                    <tr
                      key={c.category}
                      onClick={() => setCategory(category === c.category ? "" : c.category)}
                      className={`cursor-pointer hover:bg-gray-50 ${category === c.category ? "bg-blue-50" : ""}`}
                      title="Click to filter by this category"
                    >
                      <td className="px-3 py-2 font-medium text-gray-900">{c.category}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.campaigns}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.approached}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {c.accepted} <span className="text-xs text-gray-500">{pct(c.accepted, c.approached)}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {c.replied} <span className="text-xs text-gray-500">{pct(c.replied, c.approached)}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {c.meetings} <span className="text-xs text-gray-500">{pct(c.meetings, c.approached)}</span>
                      </td>
                    </tr>
                  ))}
                  {d.categories.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No campaign activity in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
                {d.categories.length > 1 && (
                  <tfoot className="border-t border-gray-200 bg-gray-50 font-semibold">
                    <tr>
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.total.campaigns}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.total.approached}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.total.accepted}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.total.replied}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.total.meetings}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </section>
          </div>

          <section className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-100 px-4 py-2 text-sm font-semibold text-gray-900">By campaign</h2>
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Campaign</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Approached</th>
                  <th className="px-3 py-2 text-right">Accepted</th>
                  <th className="px-3 py-2 text-right">Replied</th>
                  <th className="px-3 py-2 text-right">Meetings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {d.campaigns.map((c) => (
                  <tr key={c.campaign_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <Link href={`${LI_BASE}/campaigns/${c.campaign_id}`} className="font-medium text-blue-700 hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">{c.category}</td>
                    <td className="px-3 py-2 text-xs text-gray-700">{c.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.approached}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.accepted} <span className="text-xs text-gray-500">{pct(c.accepted, c.approached)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.replied} <span className="text-xs text-gray-500">{pct(c.replied, c.approached)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.meetings}</td>
                  </tr>
                ))}
                {d.campaigns.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      No campaigns match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
