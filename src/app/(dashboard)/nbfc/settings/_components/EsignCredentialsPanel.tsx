"use client";

import { useEffect, useState } from "react";

// E-166 — schema-driven e-sign provider picker + credential vault panel. Renders
// the provider list + each provider's credential fields FROM the registry (via
// the GET API), so a new provider appears here automatically. Secrets are
// write-only: the API never returns them, only a "configured" flag.

interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}
interface ProviderInfo {
  id: string;
  label: string;
  description: string | null;
  environments: ("sandbox" | "production")[];
  credentialSchema: CredentialField[];
  configured: boolean;
  environment: "sandbox" | "production";
  label_hint: string | null;
  last_test_ok: boolean | null;
}

export default function EsignCredentialsPanel({
  esignProvider,
  onProviderChange,
  canEdit,
  callbackBase,
}: {
  esignProvider: string | null;
  onProviderChange: (v: string | null) => void;
  canEdit: boolean;
  callbackBase: string;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [vaultEnabled, setVaultEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/nbfc/settings/esign-credentials", { cache: "no-store" });
      const j = await res.json();
      if (j?.ok) {
        setProviders(j.providers ?? []);
        setVaultEnabled(j.vaultEnabled ?? false);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const selected = providers.find((p) => p.id === esignProvider) ?? null;
  // Reset the secret inputs + environment when the selected provider changes.
  useEffect(() => {
    setSecrets({});
    setMsg(null);
    if (selected) setEnvironment(selected.environment);
  }, [esignProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/nbfc/settings/esign-credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_type: selected.id, environment, secrets }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setMsg({
        kind: j?.last_test_ok === false ? "err" : "ok",
        text: j?.last_test_ok === false ? "Saved, but the test connection failed — check the keys." : "Saved & connection verified.",
      });
      setSecrets({});
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/nbfc/settings/esign-credentials/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_type: selected.id }),
      });
      const j = await res.json().catch(() => ({}));
      const t = j?.test;
      setMsg({ kind: t?.ok ? "ok" : "err", text: t?.ok ? "Connection OK." : `Connection failed${t?.detail ? `: ${t.detail}` : ""}.` });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const label = "block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1";

  return (
    <div className="mt-2 ml-7 border-l-2 border-slate-200 dark:border-slate-700 pl-4 space-y-3">
      <div>
        <span className={label}>E-sign provider</span>
        <select
          value={esignProvider ?? ""}
          disabled={!canEdit || busy || loading}
          onChange={(e) => onProviderChange(e.target.value || null)}
          className="w-full border border-slate-300 rounded px-2 py-1 text-sm bg-white dark:bg-slate-900"
        >
          <option value="">iTarang e-sign (iTarang&apos;s account — default)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.configured ? " — configured" : ""}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-500 mt-1">
          Use iTarang&apos;s account, or bring your own provider keys (we call it on your behalf).
        </p>
      </div>

      {selected ? (
        <div className="space-y-3 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
          {!vaultEnabled ? (
            <p className="text-[11px] text-red-600">
              The credential vault is not configured on this server (NBFC_CREDENTIALS_ENC_KEY). Saving keys is disabled.
            </p>
          ) : null}

          {selected.environments.length > 1 ? (
            <div>
              <span className={label}>Environment</span>
              <select
                value={environment}
                disabled={!canEdit || busy}
                onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}
                className="w-full border border-slate-300 rounded px-2 py-1 text-sm bg-white dark:bg-slate-900"
              >
                {selected.environments.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {selected.credentialSchema.map((f) => (
            <div key={f.key}>
              <span className={label}>{f.label}</span>
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={secrets[f.key] ?? ""}
                disabled={!canEdit || busy || !vaultEnabled}
                placeholder={selected.configured ? "•••••• (unchanged)" : f.placeholder ?? f.label}
                onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                className="w-full border border-slate-300 rounded px-2 py-1 text-sm font-mono"
              />
            </div>
          ))}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={!canEdit || busy || !vaultEnabled}
              className="rounded bg-[#1F5C8F] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : selected.configured ? "Update keys" : "Save keys"}
            </button>
            {selected.configured ? (
              <button
                type="button"
                onClick={test}
                disabled={busy}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
              >
                Test connection
              </button>
            ) : null}
            {selected.configured ? (
              <span
                className={`text-[11px] font-semibold ${selected.last_test_ok === false ? "text-red-600" : "text-emerald-600"}`}
              >
                {selected.last_test_ok === false ? "● last test failed" : "● configured"}
              </span>
            ) : null}
          </div>

          {msg ? (
            <p className={`text-[11px] ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>
          ) : null}

          <div>
            <span className={label}>Result webhook URL (read-only)</span>
            <code className="block text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 break-all">
              {`${callbackBase}/api/esign/${selected.id}/webhook`}
            </code>
            <p className="text-[11px] text-slate-500 mt-1">
              Configure this as the signing-status webhook in your {selected.label} account.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
