"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { fmtDate, json, liFetch, STATE_LABEL, StateBadge } from "./api";
import { LI_BASE } from "./LinkedInTabs";

type Row = {
  id: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  city: string | null;
  public_url: string;
  do_not_contact: boolean;
  lead_id: string | null;
  connection_state: string | null;
  created_at: string;
  campaigns: { campaign_id: string; state: string }[];
};

export function ProspectsView() {
  const qc = useQueryClient();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [company, setCompany] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (q) params.set("q", q);
  if (company) params.set("company", company);
  if (city) params.set("city", city);
  if (state) params.set("state", state);

  const list = useQuery({
    queryKey: ["li-prospects", params.toString()],
    queryFn: () => liFetch<{ rows: Row[]; total: number; page: number; pageSize: number }>(`/api/linkedin/prospects?${params}`),
  });

  async function patch(id: string, body: Record<string, unknown>, ok: string) {
    try {
      await liFetch(`/api/linkedin/prospects/${id}`, { method: "PATCH", ...json(body) });
      toast.success(ok);
      await qc.invalidateQueries({ queryKey: ["li-prospects"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  }

  const rows = list.data?.rows ?? [];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        {[
          ["Search", q, setQ, "name, headline, company"],
          ["Company", company, setCompany, ""],
          ["City", city, setCity, ""],
        ].map(([label, value, set, ph]) => (
          <label key={label as string} className="text-sm">
            <span className="mb-1 block font-medium text-gray-700">{label as string}</span>
            <input
              value={value as string}
              placeholder={ph as string}
              onChange={(e) => {
                (set as (v: string) => void)(e.target.value);
                setPage(1);
              }}
              className="rounded-md border border-gray-300 px-3 py-2"
            />
          </label>
        ))}
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">Campaign state</span>
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
            className="rounded-md border border-gray-300 px-3 py-2"
          >
            <option value="">Any</option>
            {Object.entries(STATE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <button
            disabled={!selected.size}
            onClick={() => router.push(`${LI_BASE}/campaigns/new?prospects=${[...selected].join(",")}`)}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Start campaign ({selected.size})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Company</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Campaigns</th>
              <th className="px-3 py-2">CRM lead</th>
              <th className="px-3 py-2">Added</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className={r.do_not_contact ? "bg-red-50/40" : ""}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={r.do_not_contact}
                    checked={selected.has(r.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <a href={r.public_url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">
                    {r.full_name ?? r.public_url}
                  </a>
                  <div className="max-w-[320px] truncate text-xs text-gray-500">{r.headline}</div>
                </td>
                <td className="px-3 py-2">{r.company ?? "—"}</td>
                <td className="px-3 py-2">{r.city ?? "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.campaigns.length ? r.campaigns.map((c) => <StateBadge key={c.campaign_id} state={c.state} />) : <span className="text-xs text-gray-400">—</span>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {r.lead_id ? (
                    <span className="text-xs text-green-700">{r.lead_id}</span>
                  ) : (
                    <button
                      className="text-xs text-blue-700 hover:underline"
                      onClick={() => {
                        const id = window.prompt("CRM lead id to link");
                        if (id?.trim()) void patch(r.id, { lead_id: id.trim() }, "Lead linked");
                      }}
                    >
                      Link
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(r.created_at)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    className={`text-xs ${r.do_not_contact ? "text-gray-600" : "text-red-600"} hover:underline`}
                    onClick={() =>
                      void patch(
                        r.id,
                        { do_not_contact: !r.do_not_contact, do_not_contact_reason: r.do_not_contact ? null : "marked by admin" },
                        r.do_not_contact ? "Contact allowed again" : "Marked do-not-contact; stopped in every campaign",
                      )
                    }
                  >
                    {r.do_not_contact ? "Allow contact" : "Do not contact"}
                  </button>
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  No prospects yet. Run a search first.
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-red-600">
                  {(list.error as Error).message}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>{list.data ? `${list.data.total} prospects` : ""}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-40">
            Prev
          </button>
          <span>
            {page} / {pages}
          </span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 disabled:opacity-40">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
