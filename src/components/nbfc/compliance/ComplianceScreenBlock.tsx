/**
 * ComplianceScreenBlock (E-080 — BRD §6.4.2)
 *
 * Renders the mandatory compliance metadata block on every borrower-impacting
 * screen. Pulls authoritative copy from
 * GET /api/nbfc/compliance/screen-metadata so that lender identity, LSP
 * identity, grievance channel, outstanding amount + restoration steps,
 * reversibility disclosure, DPDPA data-purpose, and the regulatory footer can
 * never be locally muted by a screen author.
 *
 * Server-driven: this component fetches at mount and renders nothing fancy —
 * the BRD demands the text be present, not styled. Pages place this block at
 * the bottom of any borrower-impacting flow.
 */
"use client";

import { useEffect, useState } from "react";

type ScreenKey =
  | "immobilisation_confirm"
  | "collection_sms"
  | "telemetry_view"
  | "portal_footer"
  | "recovery_call"
  | "sms_template";

interface ComplianceMetadata {
  screen: ScreenKey;
  lender_identity: { nbfc_legal_name: string; registration_no: string };
  lsp_identity: { name: string };
  grievance: { url: string; helpline: string };
  outstanding: { amount_inr: number; restoration_steps: string[] } | null;
  reversibility_disclosure: string;
  data_purpose: { text: string; consent_date: string; withdraw_url: string } | null;
  regulatory_footer: string;
}

interface Props {
  screen: ScreenKey;
  leadId?: string;
}

export default function ComplianceScreenBlock({ screen, leadId }: Props) {
  const [data, setData] = useState<ComplianceMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ screen });
    if (leadId) params.set("lead_id", leadId);
    fetch(`/api/nbfc/compliance/screen-metadata?${params.toString()}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ComplianceMetadata;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [screen, leadId]);

  if (error) {
    return (
      <div
        data-testid="compliance-screen-block"
        data-state="error"
        className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      >
        Compliance metadata unavailable. Refresh to retry.
      </div>
    );
  }
  if (!data) {
    return (
      <div
        data-testid="compliance-screen-block"
        data-state="loading"
        className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500"
      >
        Loading compliance details…
      </div>
    );
  }

  return (
    <section
      data-testid="compliance-screen-block"
      data-state="ready"
      data-screen={data.screen}
      className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700"
    >
      <div className="font-medium text-slate-900">
        {data.lender_identity.nbfc_legal_name}
        {data.lender_identity.registration_no
          ? ` · RBI Reg. ${data.lender_identity.registration_no}`
          : null}
      </div>
      <div>LSP: {data.lsp_identity.name}</div>
      <div>
        Grievance: {data.grievance.helpline}
        {data.grievance.url ? (
          <>
            {" · "}
            <a
              className="underline"
              href={data.grievance.url}
              target="_blank"
              rel="noreferrer"
            >
              File a complaint
            </a>
          </>
        ) : null}
      </div>
      {data.outstanding ? (
        <div>
          <div className="font-medium">
            Outstanding: ₹{data.outstanding.amount_inr.toLocaleString("en-IN")}
          </div>
          <ol className="list-decimal pl-5">
            {data.outstanding.restoration_steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      <div>{data.reversibility_disclosure}</div>
      {data.data_purpose ? (
        <div className="italic text-slate-600">{data.data_purpose.text}</div>
      ) : null}
      <div className="text-[11px] text-slate-500">
        {data.regulatory_footer}
      </div>
    </section>
  );
}
