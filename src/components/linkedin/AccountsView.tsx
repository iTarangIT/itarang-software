"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { fmtDate, json, liFetch } from "./api";

type Settings = {
  invites_per_day: number;
  messages_per_day: number;
  gap_min_minutes: number;
  gap_max_minutes: number;
  send_start: string;
  send_end: string;
  send_days: string;
  warmup_week1_invites: number;
  warmup_week2_invites: number;
  poll_interval_minutes: number;
  invite_expiry_days: number;
};
type Account = {
  id: string;
  label: string;
  status: string;
  status_reason: string | null;
  provider_account_id: string | null;
  warmup_started_at: string | null;
  last_polled_at: string | null;
  settings: Settings;
  today: { invites: number; invite_cap: number; messages: number; message_cap: number };
};
type Overview = {
  accounts: Account[];
  log: { id: number; account_id: string | null; action: string; ok: boolean; detail: string | null; at: string }[];
  brightdata_balance: string | null;
  environment: { sends_allowed: boolean; llm_configured: boolean; firecrawl_configured: boolean };
};
type Creds = {
  encryption: boolean;
  items: { slot: string; label: string; source: "db" | "env" | "none"; last4: string | null; updated_at: string | null }[];
};

const STATUS_TONE: Record<string, string> = {
  ok: "bg-green-50 text-green-700",
  pending: "bg-gray-100 text-gray-600",
  paused: "bg-amber-50 text-amber-700",
  challenge: "bg-red-50 text-red-700",
  restricted: "bg-red-50 text-red-700",
};

const SETTING_FIELDS: [keyof Settings, string, "number" | "text"][] = [
  ["invites_per_day", "Invites / day", "number"],
  ["messages_per_day", "Messages / day", "number"],
  ["gap_min_minutes", "Gap min (min)", "number"],
  ["gap_max_minutes", "Gap max (min)", "number"],
  ["send_start", "Send from (IST)", "text"],
  ["send_end", "Send until (IST)", "text"],
  ["send_days", "Days (1=Mon)", "text"],
  ["warmup_week1_invites", "Warm-up wk 1", "number"],
  ["warmup_week2_invites", "Warm-up wk 2", "number"],
  ["poll_interval_minutes", "Poll every (min)", "number"],
  ["invite_expiry_days", "Invite expiry (days)", "number"],
];

export function AccountsView() {
  const overview = useQuery({ queryKey: ["li-accounts"], queryFn: () => liFetch<Overview>("/api/linkedin/accounts"), refetchInterval: 60_000 });
  const creds = useQuery({ queryKey: ["li-creds"], queryFn: () => liFetch<Creds>("/api/linkedin/credentials") });
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, Settings>>({});

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
      await Promise.all([overview.refetch(), creds.refetch()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function connect(id: string) {
    try {
      const r = await liFetch<{ url: string }>(`/api/linkedin/accounts/${id}/connect`, { method: "POST" });
      window.open(r.url, "_blank", "noopener");
      toast.message("Finish the LinkedIn sign-in in the new tab, then refresh this page.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the connect link");
    }
  }

  const env = overview.data?.environment;
  return (
    <div className="space-y-6">
      {env && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full px-2 py-1 ${env.sends_allowed ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-800"}`}>
            {env.sends_allowed ? "Sending is ON on this site" : "Sending is OFF on this site (sandbox) — set LI_ALLOW_SENDS=1 to test real sends"}
          </span>
          <span className={`rounded-full px-2 py-1 ${env.firecrawl_configured ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
            Profile discovery (Firecrawl): {env.firecrawl_configured ? "ready" : "no Firecrawl key (SCRAPPER_API_KEY / FIRECRAWL_API_KEY)"}
          </span>
          <span className={`rounded-full px-2 py-1 ${env.llm_configured ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-800"}`}>
            Fit scoring + drafts (assistant model): {env.llm_configured ? "ready" : "not configured"}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-700">Bright Data balance: {overview.data?.brightdata_balance ?? "—"}</span>
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-base font-semibold text-gray-900">LinkedIn accounts</h2>
        <div className="space-y-4">
          {(overview.data?.accounts ?? []).map((a) => {
            const s = editing[a.id] ?? a.settings;
            return (
              <div key={a.id} className="rounded-md border border-gray-100 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium text-gray-900">{a.label}</span>{" "}
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[a.status] ?? ""}`}>
                      {a.provider_account_id ? a.status : "not connected"}
                    </span>
                    {a.status_reason && <span className="ml-2 text-xs text-red-700">{a.status_reason}</span>}
                    <div className="text-xs text-gray-500">
                      Today: {a.today.invites}/{a.today.invite_cap} invites · {a.today.messages}/{a.today.message_cap} messages · last checked{" "}
                      {fmtDate(a.last_polled_at)}
                      {a.warmup_started_at && <> · warm-up since {fmtDate(a.warmup_started_at)}</>}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => connect(a.id)} className="rounded-md border border-gray-300 px-3 py-1 text-xs">
                      {a.provider_account_id ? "Reconnect" : "Connect LinkedIn"}
                    </button>
                    {a.provider_account_id && a.status === "ok" && (
                      <button
                        onClick={() => run(() => liFetch(`/api/linkedin/accounts/${a.id}/poll`, { method: "POST" }), "Checked for replies and acceptances")}
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs"
                      >
                        Check now
                      </button>
                    )}
                    {a.status === "ok" ? (
                      <button
                        onClick={() => run(() => liFetch(`/api/linkedin/accounts/${a.id}`, { method: "PATCH", ...json({ action: "pause" }) }), "Account paused")}
                        className="rounded-md border border-amber-300 px-3 py-1 text-xs text-amber-800"
                      >
                        Pause
                      </button>
                    ) : a.provider_account_id ? (
                      <button
                        onClick={() => run(() => liFetch(`/api/linkedin/accounts/${a.id}`, { method: "PATCH", ...json({ action: "resume" }) }), "Account resumed")}
                        className="rounded-md border border-green-300 px-3 py-1 text-xs text-green-800"
                      >
                        Resume
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
                  {SETTING_FIELDS.map(([k, lab, type]) => (
                    <label key={k} className="text-xs">
                      <span className="block text-gray-500">{lab}</span>
                      <input
                        type={type}
                        value={String(s[k])}
                        onChange={(e) =>
                          setEditing((m) => ({ ...m, [a.id]: { ...s, [k]: type === "number" ? Number(e.target.value) : e.target.value } }))
                        }
                        className="w-full rounded border border-gray-300 px-2 py-1"
                      />
                    </label>
                  ))}
                </div>
                {editing[a.id] && (
                  <button
                    onClick={() =>
                      run(async () => {
                        await liFetch(`/api/linkedin/accounts/${a.id}`, { method: "PATCH", ...json({ settings: editing[a.id] }) });
                        setEditing((m) => {
                          const { [a.id]: _drop, ...rest } = m;
                          return rest;
                        });
                      }, "Pacing saved")
                    }
                    className="mt-2 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white"
                  >
                    Save pacing
                  </button>
                )}
              </div>
            );
          })}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await liFetch("/api/linkedin/accounts", { method: "POST", ...json({ label }) });
                setLabel("");
              }, "Account added — now connect it");
            }}
            className="flex gap-2"
          >
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Account name, e.g. Trial – team account"
              required
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <button className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white">Add account</button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">Provider keys</h2>
        <p className="mb-3 text-xs text-gray-500">
          Stored encrypted in this environment&apos;s database (sandbox and production keep their own). Only the last 4 characters are ever shown. The
          assistant model and Firecrawl use the CRM&apos;s existing keys.
        </p>
        {creds.data && !creds.data.encryption && (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
            APP_SECRETS_ENC_KEY is not set on this server, so keys cannot be saved here; set the env vars instead.
          </p>
        )}
        <div className="space-y-2">
          {(creds.data?.items ?? [])
            .filter((c) => c.slot !== "webhook:secret")
            .map((c) => (
              <div key={c.slot} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-72 text-gray-700">{c.label}</span>
                <span className="w-40 text-xs text-gray-500">
                  {c.source === "none" ? "not set" : `${c.source === "db" ? "saved" : "from env"} ••••${c.last4}`}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={values[c.slot] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [c.slot]: e.target.value }))}
                  placeholder="new value"
                  className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <button
                  disabled={!values[c.slot]?.trim()}
                  onClick={() =>
                    run(async () => {
                      await liFetch("/api/linkedin/credentials", { method: "PUT", ...json({ slot: c.slot, value: values[c.slot] }) });
                      setValues((v) => ({ ...v, [c.slot]: "" }));
                    }, "Saved")
                  }
                  className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  Save
                </button>
                {c.source === "db" && (
                  <button
                    onClick={() => run(() => liFetch(`/api/linkedin/credentials?slot=${encodeURIComponent(c.slot)}`, { method: "DELETE" }), "Removed")}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white">
        <h2 className="border-b border-gray-100 px-4 py-2 text-base font-semibold text-gray-900">Action log</h2>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 text-left uppercase text-gray-500">
              <tr>
                <th className="px-3 py-1.5">When</th>
                <th className="px-3 py-1.5">Action</th>
                <th className="px-3 py-1.5">Result</th>
                <th className="px-3 py-1.5">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(overview.data?.log ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-500">{fmtDate(l.at)}</td>
                  <td className="px-3 py-1.5">{l.action}</td>
                  <td className={`px-3 py-1.5 ${l.ok ? "text-green-700" : "text-red-700"}`}>{l.ok ? "ok" : "failed"}</td>
                  <td className="max-w-[600px] truncate px-3 py-1.5 text-gray-600" title={l.detail ?? ""}>
                    {l.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {overview.isError && <p className="text-sm text-red-600">{(overview.error as Error).message}</p>}
    </div>
  );
}
