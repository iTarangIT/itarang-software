"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { fmtDate, json, liFetch, STATE_LABEL, StateBadge } from "./api";
import { LI_BASE } from "./LinkedInTabs";

type Detail = {
  campaign: { id: string; name: string; status: string; template: string; invite_note: string | null };
  approval: { approved_at: string; prospect_count: number; voided_at: string | null; void_reason: string | null } | null;
  attachment: { file_name: string } | null;
  counts: Record<string, number>;
  kpis: {
    invited: number;
    accepted: number;
    messaged: number;
    replied: number;
    positive: number;
    acceptance_pct: number | null;
    reply_pct: number | null;
    positive_reply_pct: number | null;
  };
  rows: {
    id: string;
    state: string;
    full_name: string | null;
    company: string | null;
    public_url: string;
    invite_sent_at: string | null;
    accepted_at: string | null;
    message_sent_at: string | null;
    seen_at: string | null;
    replied_at: string | null;
    next_action_at: string | null;
    last_error: string | null;
    missing_fields: string | null;
    stopped_reason: string | null;
  }[];
};

const pct = (v: number | null) => (v == null ? "—" : `${v}%`);

export function CampaignDetailView({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["li-campaign", id],
    queryFn: () => liFetch<Detail>(`/api/linkedin/campaigns/${id}`),
    refetchInterval: 30_000,
  });

  async function control(action: "pause" | "resume" | "stop") {
    if (action === "stop" && !window.confirm("Stop this campaign? Nothing more will be sent from it.")) return;
    setBusy(true);
    try {
      await liFetch(`/api/linkedin/campaigns/${id}/control`, { method: "POST", ...json({ action }) });
      toast.success(`Campaign ${action === "resume" ? "resumed" : action === "pause" ? "paused" : "stopped"}`);
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (q.isError) return <p className="text-sm text-red-600">{(q.error as Error).message}</p>;
  if (!q.data) return <p className="text-sm text-gray-500">Loading…</p>;
  const d = q.data;
  const s = d.campaign.status;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{d.campaign.name}</h2>
          <p className="text-sm text-gray-600">
            Status <strong>{s}</strong>
            {d.approval && !d.approval.voided_at && <> · approved {fmtDate(d.approval.approved_at)} for {d.approval.prospect_count}</>}
            {d.approval?.voided_at && <span className="text-amber-700"> · approval voided ({d.approval.void_reason})</span>}
            {d.attachment && <> · attachment {d.attachment.file_name}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`${LI_BASE}/campaigns/new?campaign=${id}`} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">
            Edit
          </Link>
          {s === "running" && (
            <button disabled={busy} onClick={() => control("pause")} className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-800">
              Pause
            </button>
          )}
          {s === "paused" && (
            <button disabled={busy} onClick={() => control("resume")} className="rounded-md border border-green-300 px-3 py-1.5 text-sm text-green-800">
              Resume
            </button>
          )}
          {s !== "stopped" && s !== "draft" && (
            <button disabled={busy} onClick={() => control("stop")} className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700">
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Invite acceptance", pct(d.kpis.acceptance_pct), `${d.kpis.accepted} of ${d.kpis.invited} invites`],
          ["Reply rate", pct(d.kpis.reply_pct), `${d.kpis.replied} of ${d.kpis.messaged} messaged`],
          ["Positive replies", pct(d.kpis.positive_reply_pct), `${d.kpis.positive} of ${d.kpis.replied} replies`],
          ["In queue", String((d.counts.queued ?? 0) + (d.counts.accepted ?? 0)), "waiting for the paced worker"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="text-xs uppercase text-gray-500">{label}</div>
            <div className="text-2xl font-semibold text-gray-900">{value}</div>
            <div className="text-xs text-gray-500">{sub}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(d.counts).map(([k, v]) => (
          <span key={k} className="rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-700">
            {STATE_LABEL[k] ?? k}: <strong>{v}</strong>
          </span>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Prospect</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Invite sent</th>
              <th className="px-3 py-2">Accepted</th>
              <th className="px-3 py-2">Message sent</th>
              <th className="px-3 py-2">Seen</th>
              <th className="px-3 py-2">Replied</th>
              <th className="px-3 py-2">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <a href={r.public_url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                    {r.full_name ?? r.public_url}
                  </a>
                  <div className="text-xs text-gray-500">{r.company}</div>
                </td>
                <td className="px-3 py-2">
                  <StateBadge state={r.state} />
                </td>
                <td className="px-3 py-2 text-xs">{fmtDate(r.invite_sent_at)}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(r.accepted_at)}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(r.message_sent_at)}</td>
                {/* doc §6.5: "Seen" only when LinkedIn reports it. */}
                <td className="px-3 py-2 text-xs">{r.seen_at ? fmtDate(r.seen_at) : r.message_sent_at ? "Not available" : "—"}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(r.replied_at)}</td>
                <td className="max-w-[280px] px-3 py-2 text-xs text-gray-600">
                  {r.last_error ?? r.stopped_reason ?? r.missing_fields ?? (r.next_action_at && ["queued", "accepted"].includes(r.state) ? `next try ${fmtDate(r.next_action_at)}` : "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
