"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { fmtDate, json, liFetch, StateBadge } from "./api";
import { LI_BASE } from "./LinkedInTabs";

type Run = {
  id: string;
  keywords: string;
  status: string;
  error: string | null;
  result_count: number;
  created_at: string;
};
type Result = {
  id: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  city: string | null;
  public_url: string;
  fit_score: number | null;
  fit_reason: string | null;
  do_not_contact: boolean;
  lead_id: string | null;
  campaigns: { campaign_id: string; state: string }[];
};

export function SearchView() {
  const qc = useQueryClient();
  const router = useRouter();
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [company, setCompany] = useState("");
  const [limit, setLimit] = useState(25);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const runs = useQuery({ queryKey: ["li-runs"], queryFn: () => liFetch<Run[]>("/api/linkedin/search") });
  useEffect(() => {
    if (!runId && runs.data?.[0]) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  const run = useQuery({
    queryKey: ["li-run", runId],
    enabled: !!runId,
    queryFn: () => liFetch<{ run: Run; results: Result[] }>(`/api/linkedin/search/${runId}`),
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s === "queued" || s === "running" ? 5000 : false;
    },
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await liFetch<Run>("/api/linkedin/search", {
        method: "POST",
        ...json({ keywords, location: location || null, company: company || null, limit }),
      });
      setRunId(r.id);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["li-runs"] });
      toast.success("Search started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  const results = run.data?.results ?? [];
  const selectable = results.filter((r) => !r.do_not_contact);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="grid gap-3 rounded-lg border border-gray-200 bg-white p-4 md:grid-cols-[2fr_1fr_1fr_100px_auto]">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Keywords</span>
          <input
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. EV fleet manager, battery dealer owner"
            className="w-full rounded-md border border-gray-300 px-3 py-2"
            required
            minLength={2}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">City / region</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="optional" className="w-full rounded-md border border-gray-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Company</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="optional" className="w-full rounded-md border border-gray-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Max</span>
          <input
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 25)}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          />
        </label>
        <div className="flex items-end">
          <button disabled={busy} className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? "Starting…" : "Search"}
          </button>
        </div>
      </form>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <aside className="rounded-lg border border-gray-200 bg-white">
          <h2 className="border-b border-gray-100 px-3 py-2 text-sm font-semibold text-gray-800">Recent searches</h2>
          <ul className="max-h-[560px] overflow-y-auto">
            {(runs.data ?? []).map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => {
                    setRunId(r.id);
                    setSelected(new Set());
                  }}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${r.id === runId ? "bg-blue-50" : ""}`}
                >
                  <div className="truncate font-medium text-gray-900">{r.keywords}</div>
                  <div className="text-xs text-gray-500">
                    {fmtDate(r.created_at)} · {r.status} · {r.result_count}
                  </div>
                </button>
              </li>
            ))}
            {runs.data?.length === 0 && <li className="px-3 py-4 text-sm text-gray-500">No searches yet.</li>}
            {runs.isError && <li className="px-3 py-4 text-sm text-red-600">{(runs.error as Error).message}</li>}
          </ul>
        </aside>

        <section className="rounded-lg border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
            <div className="text-sm text-gray-700">
              {run.data ? (
                <>
                  <span className="font-semibold text-gray-900">{run.data.run.keywords}</span> — {run.data.run.status}
                  {run.data.run.status === "running" && " (profiles are saved as they arrive)"}
                  {run.data.run.error && (
                    <span className={`ml-2 ${run.data.run.status === "failed" ? "text-red-600" : "text-amber-700"}`}>{run.data.run.error}</span>
                  )}
                </>
              ) : (
                "Pick or start a search"
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set(selectable.map((r) => r.id)))}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                disabled={!selectable.length}
              >
                Select all
              </button>
              <button
                type="button"
                disabled={!selected.size}
                onClick={() => router.push(`${LI_BASE}/campaigns/new?prospects=${[...selected].join(",")}`)}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Start campaign ({selected.size})
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Headline</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">City</th>
                  <th className="px-3 py-2">Fit</th>
                  <th className="px-3 py-2">Contacted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {results.map((r) => (
                  <tr key={r.id} className={r.do_not_contact ? "opacity-50" : ""}>
                    <td className="px-3 py-2">
                      <input type="checkbox" disabled={r.do_not_contact} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="px-3 py-2">
                      <a href={r.public_url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                        {r.full_name ?? r.public_url}
                      </a>
                      {r.lead_id && <div className="text-xs text-green-700">CRM lead {r.lead_id}</div>}
                    </td>
                    <td className="max-w-[280px] px-3 py-2 text-gray-700">{r.headline ?? "—"}</td>
                    <td className="px-3 py-2">{r.company ?? "—"}</td>
                    <td className="px-3 py-2">{r.city ?? "—"}</td>
                    <td className="max-w-[260px] px-3 py-2">
                      {r.fit_score == null ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <>
                          <span className="font-semibold">{r.fit_score}</span>
                          <div className="text-xs text-gray-500">{r.fit_reason}</div>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.do_not_contact ? (
                        <span className="text-xs text-red-600">Do not contact</span>
                      ) : r.campaigns.length ? (
                        <div className="flex flex-wrap gap-1">
                          {r.campaigns.map((c) => (
                            <StateBadge key={c.campaign_id} state={c.state} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">No</span>
                      )}
                    </td>
                  </tr>
                ))}
                {run.data && results.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      {run.data.run.status === "done" || run.data.run.status === "failed" ? "No profiles found." : "Searching…"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
