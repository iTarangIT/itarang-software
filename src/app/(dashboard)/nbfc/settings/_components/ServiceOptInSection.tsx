"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// BRD Addendum V0.2 §7.4 — Service Opt-In + Document Handling + Track Rules.
// Per-service toggles; opting OUT means the NBFC does that step off-platform.
// Zero services is valid. The read-only callback URL is shown when E-NACH is on.

export interface ServiceConfig {
  fi_enabled: boolean;
  vkyc_enabled: boolean;
  vkyc_mode: "own" | "itarang" | null;
  enach_enabled: boolean;
  enach_handoff_method: "redirect" | "webhook" | "itarang_razorpay" | null;
  enach_endpoint_url: string | null;
  doc_agreement_method: "upload" | "digio" | "api_autofetch" | null;
  store_sanction_letter: boolean;
  store_loan_agreement: boolean;
  track_completion_gate: boolean;
  track_failure_halts: boolean;
}

interface Props {
  initialConfig: ServiceConfig;
  canEdit: boolean;
  /** Origin (e.g. https://app.itarang.com) so the read-only callback URL renders fully. */
  callbackBase: string;
}

export default function ServiceOptInSection({ initialConfig, canEdit, callbackBase }: Props) {
  const router = useRouter();
  const [cfg, setCfg] = useState<ServiceConfig>(initialConfig);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ServiceConfig>(key: K, value: ServiceConfig[K]) {
    setCfg((c) => ({ ...c, [key]: value }));
    setSavedAt(null);
  }

  async function save() {
    // Client-side mirror of the API's "enabled ⇒ config required" guard.
    if (cfg.vkyc_enabled && !cfg.vkyc_mode) {
      setError("Pick a Video KYC mode (Own or iTarang) before saving.");
      return;
    }
    if (cfg.enach_enabled && !cfg.enach_handoff_method) {
      setError("Pick an E-NACH handoff method before saving.");
      return;
    }
    if (
      cfg.enach_enabled &&
      (cfg.enach_handoff_method === "redirect" || cfg.enach_handoff_method === "webhook") &&
      !cfg.enach_endpoint_url
    ) {
      setError("This E-NACH handoff method needs the NBFC endpoint URL before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/settings/service-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
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

  const callbackUrl = `${callbackBase}/api/nbfc/enach/callback`;
  const razorpayWebhookUrl = `${callbackBase}/api/payments/razorpay/emandate-webhook`;
  const isManagedRzp = cfg.enach_handoff_method === "itarang_razorpay";

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">
          Service Opt-In
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Choose which verification steps run through iTarang for this NBFC. Opting out means you
          perform that step off-platform. Changes apply to <strong>new leads only</strong> — leads
          already in flight keep the configuration captured when they bound to you.
        </p>
      </div>

      {/* Field Investigation */}
      <Toggle
        label="Field Investigation"
        desc="iTarang surfaces the FI track in your Acquire workspace."
        checked={cfg.fi_enabled}
        disabled={!canEdit || busy}
        onChange={(v) => set("fi_enabled", v)}
      />

      {/* Active Video KYC */}
      <Toggle
        label="Active Video KYC"
        desc="Active Video Liveness as a Stage-1 verification track."
        checked={cfg.vkyc_enabled}
        disabled={!canEdit || busy}
        onChange={(v) => set("vkyc_enabled", v)}
      >
        {cfg.vkyc_enabled ? (
          <ConfigurePanel>
            <Radio
              name="vkyc_mode"
              legend="Video KYC mode"
              value={cfg.vkyc_mode}
              disabled={!canEdit || busy}
              onChange={(v) => set("vkyc_mode", v as ServiceConfig["vkyc_mode"])}
              options={[
                { value: "own", label: "Own VKYC", hint: "iTarang triggers + records; you run it on your own vendor. No per-run iTarang fee." },
                { value: "itarang", label: "Use iTarang VKYC", hint: "iTarang's Decentro Active Video Liveness. A flat fee per run applies (§8.2)." },
              ]}
            />
          </ConfigurePanel>
        ) : null}
      </Toggle>

      {/* E-NACH */}
      <Toggle
        label="E-NACH (Mandate Registration)"
        desc="Winner-only, Stage 2. You own the mandate lifecycle; iTarang triggers + records."
        checked={cfg.enach_enabled}
        disabled={!canEdit || busy}
        onChange={(v) => set("enach_enabled", v)}
      >
        {cfg.enach_enabled ? (
          <ConfigurePanel>
            <Radio
              name="enach_handoff"
              legend="Handoff method"
              value={cfg.enach_handoff_method}
              disabled={!canEdit || busy}
              onChange={(v) => set("enach_handoff_method", v as ServiceConfig["enach_handoff_method"])}
              options={[
                { value: "itarang_razorpay", label: "iTarang Razorpay (managed)", hint: "iTarang creates + tracks the e-mandate on Razorpay. The customer authorises in-flow; no endpoint of yours is needed." },
                { value: "redirect", label: "Redirect / deep-link", hint: "Hand off to your own app via a deep-link; your app posts the result back." },
                { value: "webhook", label: "Webhook", hint: "iTarang POSTs the handoff to your endpoint; your app posts the result back." },
              ]}
            />
            {!isManagedRzp ? (
              <LabelledInput
                label={cfg.enach_handoff_method === "webhook" ? "Your webhook endpoint" : "Your app URL"}
                placeholder="https://nbfc.example.com/enach"
                value={cfg.enach_endpoint_url ?? ""}
                disabled={!canEdit || busy}
                onChange={(v) => set("enach_endpoint_url", v || null)}
              />
            ) : null}
            {isManagedRzp ? (
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
                  Razorpay webhook URL (read-only)
                </span>
                <code className="block text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 break-all">
                  {razorpayWebhookUrl}
                </code>
                <p className="text-[11px] text-slate-500 mt-1">
                  Register this URL in your Razorpay Dashboard → Webhooks for the
                  events <code>token.confirmed</code>, <code>token.rejected</code>,{" "}
                  <code>order.paid</code>, <code>payment.failed</code>. iTarang
                  verifies the signature and updates the mandate automatically.
                </p>
              </div>
            ) : (
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
                  Result callback URL (read-only)
                </span>
                <code className="block text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 break-all">
                  {callbackUrl}
                </code>
                <p className="text-[11px] text-slate-500 mt-1">
                  Map your provider&apos;s statuses to iTarang&apos;s canonical states and POST here.
                </p>
              </div>
            )}
          </ConfigurePanel>
        ) : null}
      </Toggle>

      {/* Document Handling */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Document Handling
        </h3>
        <Radio
          name="agreement_method"
          legend="Agreement method"
          value={cfg.doc_agreement_method}
          disabled={!canEdit || busy}
          onChange={(v) => set("doc_agreement_method", v as ServiceConfig["doc_agreement_method"])}
          options={[
            { value: "upload", label: "Upload signed copy" },
            { value: "digio", label: "iTarang Digio e-sign" },
            { value: "api_autofetch", label: "API autofetch" },
          ]}
        />
        <Toggle
          label="iTarang may store the sanction letter"
          checked={cfg.store_sanction_letter}
          disabled={!canEdit || busy}
          onChange={(v) => set("store_sanction_letter", v)}
        />
        <Toggle
          label="iTarang may store the loan agreement"
          checked={cfg.store_loan_agreement}
          disabled={!canEdit || busy}
          onChange={(v) => set("store_loan_agreement", v)}
        />
      </div>

      {/* Track Rules */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Track Rules</h3>
        <Toggle
          label="All verification tracks must complete before financing conditions"
          desc="Completion gate."
          checked={cfg.track_completion_gate}
          disabled={!canEdit || busy}
          onChange={(v) => set("track_completion_gate", v)}
        />
        <Toggle
          label="A failed track halts the other tracks"
          desc="Off = the remaining tracks continue."
          checked={cfg.track_failure_halts}
          disabled={!canEdit || busy}
          onChange={(v) => set("track_failure_halts", v)}
        />
      </div>

      {error ? (
        <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>
      ) : null}

      {canEdit ? (
        <div className="flex justify-end items-center gap-3">
          {savedAt ? (
            <span className="text-xs text-emerald-700">Saved at {savedAt.toLocaleTimeString()}</span>
          ) : null}
          <button
            onClick={save}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save configuration"}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">
          Only an NBFC Admin can change this configuration.
        </p>
      )}
    </section>
  );
}

function Toggle({
  label,
  desc,
  checked,
  disabled,
  onChange,
  children,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="text-sm font-medium">{label}</span>
          {desc ? <span className="block text-xs text-slate-500">{desc}</span> : null}
        </span>
      </label>
      {children}
    </div>
  );
}

function ConfigurePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 ml-7 border-l-2 border-slate-200 dark:border-slate-700 pl-4 space-y-3">
      {children}
    </div>
  );
}

function Radio({
  name,
  legend,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  legend: string;
  value: string | null;
  options: { value: string; label: string; hint?: string }[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
        {legend}
      </legend>
      <div className="space-y-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name={name}
              checked={value === o.value}
              disabled={disabled}
              onChange={() => onChange(o.value)}
              className="mt-0.5"
            />
            <span>
              <span className="text-sm">{o.label}</span>
              {o.hint ? <span className="block text-[11px] text-slate-500">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LabelledInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
        {label}
      </label>
      <input
        type="url"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
      />
    </div>
  );
}
