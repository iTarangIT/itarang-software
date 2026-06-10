"use client";

/**
 * Notification Channels settings block (BRD Addendum V0.3.1 §15.5). The NBFC
 * connects its own Email (SMTP) / SMS / WhatsApp gateways; leaving a channel on
 * "iTarang default" routes through the platform gateway (the resolver's
 * fallback). Secrets are write-only — the API returns only a "configured" flag,
 * and a blank secret field on save keeps the stored value.
 */
import { useCallback, useEffect, useState } from "react";

const KEEP = "__UNCHANGED__";

type Config = {
  email_mode: "itarang_default" | "own_smtp";
  email_from: string | null;
  email_from_name: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_set: boolean;
  smtp_secure: boolean;
  sms_provider: "itarang_default" | "gupshup" | "decentro";
  sms_source: string | null;
  sms_dlt_template_id: string | null;
  sms_api_key_set: boolean;
  whatsapp_enabled: boolean;
  whatsapp_provider: string | null;
  whatsapp_waba_id: string | null;
  whatsapp_from: string | null;
  whatsapp_api_key_set: boolean;
};

export default function NotificationChannelsSection() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Secret inputs (blank = keep existing when *_set is true).
  const [smtpPass, setSmtpPass] = useState("");
  const [smsKey, setSmsKey] = useState("");
  const [waKey, setWaKey] = useState("");
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nbfc/settings/notification-channels");
      const j = (await res.json()) as { ok: boolean; canEdit?: boolean; config?: Config; error?: string };
      if (!j.ok) throw new Error(j.error ?? "Failed to load");
      setCfg(j.config ?? null);
      setCanEdit(j.canEdit ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof Config>(k: K, v: Config[K]) {
    setCfg((c) => (c ? { ...c, [k]: v } : c));
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const body = {
        email_mode: cfg.email_mode,
        email_from: cfg.email_from,
        email_from_name: cfg.email_from_name,
        smtp_host: cfg.smtp_host,
        smtp_port: cfg.smtp_port,
        smtp_user: cfg.smtp_user,
        smtp_pass: smtpPass || (cfg.smtp_pass_set ? KEEP : null),
        smtp_secure: cfg.smtp_secure,
        sms_provider: cfg.sms_provider,
        sms_api_key: smsKey || (cfg.sms_api_key_set ? KEEP : null),
        sms_source: cfg.sms_source,
        sms_dlt_template_id: cfg.sms_dlt_template_id,
        whatsapp_enabled: cfg.whatsapp_enabled,
        whatsapp_provider: cfg.whatsapp_provider,
        whatsapp_waba_id: cfg.whatsapp_waba_id,
        whatsapp_api_key: waKey || (cfg.whatsapp_api_key_set ? KEEP : null),
        whatsapp_from: cfg.whatsapp_from,
      };
      const res = await fetch("/api/nbfc/settings/notification-channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSmtpPass("");
      setSmsKey("");
      setWaKey("");
      setNote("Saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function test(channel: "email" | "sms") {
    if (!testTo.trim()) {
      setError("Enter a destination to test.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/nbfc/settings/notification-channels/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, to: testTo.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; via?: string; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNote(`Test ${channel} sent${j.via ? ` (via ${j.via})` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Notification Channels</h2>
        {error ? <p className="text-xs text-red-600 mt-2">{error}</p> : <p className="text-xs text-slate-400 mt-2">Loading…</p>}
      </section>
    );
  }

  const dis = !canEdit || busy;
  const input = "mt-1 w-full text-sm border border-slate-200 rounded-md px-2 py-1.5";

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">Notification Channels</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Connect your own gateways, or leave a channel on iTarang default to use the platform gateway.
        </p>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {note && <p className="text-xs text-emerald-600">{note}</p>}

      {/* Email */}
      <div className="rounded-lg border border-slate-200 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Email</h3>
        <div className="flex gap-4 text-sm">
          {(["itarang_default", "own_smtp"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="email_mode" checked={cfg.email_mode === m} disabled={dis} onChange={() => set("email_mode", m)} />
              {m === "itarang_default" ? "iTarang default" : "Own SMTP"}
            </label>
          ))}
        </div>
        {cfg.email_mode === "own_smtp" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-slate-500 font-semibold">From address<input value={cfg.email_from ?? ""} disabled={dis} onChange={(e) => set("email_from", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">From name<input value={cfg.email_from_name ?? ""} disabled={dis} onChange={(e) => set("email_from_name", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">SMTP host<input value={cfg.smtp_host ?? ""} disabled={dis} onChange={(e) => set("smtp_host", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">SMTP port<input type="number" value={cfg.smtp_port ?? ""} disabled={dis} onChange={(e) => set("smtp_port", e.target.value === "" ? null : Number(e.target.value))} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">SMTP user<input value={cfg.smtp_user ?? ""} disabled={dis} onChange={(e) => set("smtp_user", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">SMTP password<input type="password" placeholder={cfg.smtp_pass_set ? "configured — leave blank to keep" : ""} value={smtpPass} disabled={dis} onChange={(e) => setSmtpPass(e.target.value)} className={input} /></label>
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={cfg.smtp_secure} disabled={dis} onChange={(e) => set("smtp_secure", e.target.checked)} />TLS (port 465)</label>
          </div>
        )}
      </div>

      {/* SMS */}
      <div className="rounded-lg border border-slate-200 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">SMS</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[11px] text-slate-500 font-semibold">Provider
            <select value={cfg.sms_provider} disabled={dis} onChange={(e) => set("sms_provider", e.target.value as Config["sms_provider"])} className={input}>
              <option value="itarang_default">iTarang default</option>
              <option value="gupshup">Gupshup</option>
              <option value="decentro">Decentro</option>
            </select>
          </label>
          {cfg.sms_provider !== "itarang_default" && (
            <>
              <label className="text-[11px] text-slate-500 font-semibold">Sender ID / source<input value={cfg.sms_source ?? ""} disabled={dis} onChange={(e) => set("sms_source", e.target.value)} className={input} /></label>
              <label className="text-[11px] text-slate-500 font-semibold">API key<input type="password" placeholder={cfg.sms_api_key_set ? "configured — leave blank to keep" : ""} value={smsKey} disabled={dis} onChange={(e) => setSmsKey(e.target.value)} className={input} /></label>
              <label className="text-[11px] text-slate-500 font-semibold">DLT template id<input value={cfg.sms_dlt_template_id ?? ""} disabled={dis} onChange={(e) => set("sms_dlt_template_id", e.target.value)} className={input} /></label>
            </>
          )}
        </div>
      </div>

      {/* WhatsApp */}
      <div className="rounded-lg border border-slate-200 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">WhatsApp</h3>
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700"><input type="checkbox" checked={cfg.whatsapp_enabled} disabled={dis} onChange={(e) => set("whatsapp_enabled", e.target.checked)} />Enable WhatsApp</label>
        {cfg.whatsapp_enabled && (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[11px] text-slate-500 font-semibold">Provider / BSP<input value={cfg.whatsapp_provider ?? ""} disabled={dis} onChange={(e) => set("whatsapp_provider", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">WABA id<input value={cfg.whatsapp_waba_id ?? ""} disabled={dis} onChange={(e) => set("whatsapp_waba_id", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">Display / from<input value={cfg.whatsapp_from ?? ""} disabled={dis} onChange={(e) => set("whatsapp_from", e.target.value)} className={input} /></label>
            <label className="text-[11px] text-slate-500 font-semibold">API key<input type="password" placeholder={cfg.whatsapp_api_key_set ? "configured — leave blank to keep" : ""} value={waKey} disabled={dis} onChange={(e) => setWaKey(e.target.value)} className={input} /></label>
          </div>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50">
            {busy ? "Saving…" : "Save channels"}
          </button>
          <div className="flex items-end gap-2">
            <label className="text-[11px] text-slate-500 font-semibold">Test to (email / phone)
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)} className={input} placeholder="you@nbfc.com or 98xxxxxxxx" />
            </label>
            <button onClick={() => test("email")} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50">Test email</button>
            <button onClick={() => test("sms")} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50">Test SMS</button>
          </div>
        </div>
      )}
    </section>
  );
}
