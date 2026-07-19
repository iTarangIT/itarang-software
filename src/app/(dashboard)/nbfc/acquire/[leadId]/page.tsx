import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import {
  dealers,
  leads,
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  productSelections,
} from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import { getFiTrack } from "@/lib/nbfc/fi";
import { getVkycTrack } from "@/lib/nbfc/vkyc";
import { evaluateEnachGate } from "@/lib/nbfc/enach";
import { getCustomerDossier } from "@/lib/nbfc/dossier";
import CustomerDossierPanel from "../_components/CustomerDossierPanel";
import EnachTrackPanel from "../_components/EnachTrackPanel";
import AgreementTrackPanel from "../_components/AgreementTrackPanel";
import VkycTrackPanel from "../_components/VkycTrackPanel";
import FiTrackPanel from "../_components/FiTrackPanel";
import OfferPanel from "../_components/OfferPanel";
import GoToStepButton from "../_components/GoToStepButton";
import SanctionPanel from "../_components/SanctionPanel";
import LeadStageStepper, {
  type NextAction,
  type StepperStage,
} from "../_components/LeadStageStepper";

// Acquire lead detail — Addendum V0.2 §6 / §7 / §9 / §10 / §11.
// Guided origination workspace: a stage stepper + next-action banner derived
// server-side from the assignment status and this NBFC's own verification
// tracks, then the live action panels grouped into Stage 1 (parallel, all
// picked NBFCs) and Stage 2 (winner-only: E-NACH + disbursal).

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  offer_submitted: "Offer submitted",
  selected: "Selected",
  not_selected: "Not selected",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

function fmtInr(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function fmtDate(ts: Date | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type SelectedNbfcPick = { nbfc_id?: string; loan_product_id?: string | number };

export default async function AcquireLeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const tenant = await getCurrentTenant();
  const { leadId } = await params;

  // Assignment-ownership guard: this tenant must own a row for this lead.
  const [assignment] = await db
    .select()
    .from(nbfcLeadAssignments)
    .where(
      and(
        eq(nbfcLeadAssignments.lead_id, leadId),
        eq(nbfcLeadAssignments.tenant_id, tenant.id),
      ),
    )
    .limit(1);
  if (!assignment) notFound();

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) notFound();

  const [ps] = await db
    .select()
    .from(productSelections)
    .where(
      and(
        eq(productSelections.lead_id, leadId),
        eq(productSelections.payment_mode, "finance"),
      ),
    )
    .limit(1);

  const [dealerRow] = lead.dealer_id
    ? await db
        .select({
          dealer_id: dealers.dealer_id,
          company_name: dealers.company_name,
        })
        .from(dealers)
        .where(eq(dealers.dealer_id, lead.dealer_id))
        .limit(1)
    : [];

  // Section G picks — which NBFCs the customer selected, including us.
  const picks =
    (ps?.selected_nbfcs as SelectedNbfcPick[] | null | undefined) ?? [];
  const pickedNbfcIds = picks
    .map((p) => (p?.nbfc_id == null ? NaN : Number(p.nbfc_id)))
    .filter((n) => Number.isFinite(n));

  const pickedNbfcRows = pickedNbfcIds.length
    ? await db
        .select({
          id: nbfc.id,
          short_name: nbfc.short_name,
          legal_name: nbfc.legal_name,
        })
        .from(nbfc)
        .where(inArray(nbfc.id, pickedNbfcIds))
    : [];

  // The current tenant's own nbfc.id — used to highlight "this NBFC" in the
  // Section G list. tenant_id is on nbfc; one tenant -> at most one nbfc row.
  const [myNbfc] = await db
    .select({ id: nbfc.id })
    .from(nbfc)
    .where(eq(nbfc.tenant_id, tenant.id))
    .limit(1);
  const myNbfcId = myNbfc?.id ?? null;

  // Loan product the customer indicated when picking us (if any).
  const [loanProduct] = assignment.loan_product_id
    ? await db
        .select()
        .from(nbfcLoanProducts)
        .where(eq(nbfcLoanProducts.id, assignment.loan_product_id))
        .limit(1)
    : [];

  // ── Lifecycle derivation (Addendum V0.2 §6/§9/§10) ───────────────────────
  // Stage-1 tracks run across EVERY picked NBFC, so read THIS NBFC's own rows
  // (assignment.nbfc_id). E-NACH is winner-only, so its gate is winner-centric.
  const snap = (assignment.service_config_snapshot ?? {}) as {
    fi_enabled?: boolean;
    vkyc_enabled?: boolean;
    enach_enabled?: boolean;
  };
  const status = assignment.status;

  const fiRequired = snap.fi_enabled ?? false;
  const fiRow = fiRequired ? await getFiTrack(leadId, assignment.nbfc_id) : null;
  // FI terminal-pass is status "passed" (E-148; legacy E-136 rows used
  // "completed", backfilled but accepted here to match track-gate.ts).
  const fiComplete =
    !fiRequired || fiRow?.status === "passed" || fiRow?.status === "completed";
  const fiFailed =
    fiRequired && (fiRow?.status === "failed" || fiRow?.outcome === "fail");

  const vkycRequired = snap.vkyc_enabled ?? false;
  const vkycRow = vkycRequired
    ? await getVkycTrack(leadId, assignment.nbfc_id)
    : null;
  const vkycComplete = !vkycRequired || vkycRow?.status === "verified";
  const vkycFailed = vkycRequired && vkycRow?.status === "failed";

  const enachGate = await evaluateEnachGate(leadId);

  // Full customer dossier (Steps 1–3 + product selection) for the Verification
  // step. `lead` already exists (guarded above), so this is non-null.
  const dossier = await getCustomerDossier(leadId);

  const offerSubmitted = ["offer_submitted", "selected", "not_selected"].includes(
    status,
  );
  const won = status === "selected";
  const lost = status === "not_selected";
  const closed = status === "declined" || status === "withdrawn";

  const verificationRequired = fiRequired || vkycRequired;
  const verificationComplete = fiComplete && vkycComplete;
  const verificationFailed = fiFailed || vkycFailed;
  const disbursalReady = won && enachGate.satisfied && verificationComplete;
  // Terminal state of the in-app journey (§14.3 Position X): the Step-5 OTP is
  // the hard gate — on success the lead flips to `sold` (battery sold + warranty
  // active). The disbursement money-transfer itself is PARKED (§19.1), so `sold`
  // is the furthest state iTarang models. `loan_sanctioned` = sanctioned, dealer
  // OTP/dispatch still pending.
  const sanctioned = lead.kyc_status === "loan_sanctioned" || lead.kyc_status === "sold";
  const sold = lead.kyc_status === "sold";

  function nodeOffer(): StepperStage["state"] {
    // FI / Video KYC now live inside the Offer step and only unlock once won, so
    // the Offer step itself is reachable straight after the dossier review.
    if (offerSubmitted) return "done";
    if (closed) return "locked";
    return "active";
  }
  function nodeFivkyc(): StepperStage["state"] {
    // FI / Video KYC only run for the winning lead.
    if (!won) return "locked";
    if (verificationFailed) return "failed";
    if (!verificationRequired) return "done";
    return verificationComplete ? "done" : "active";
  }
  function nodeEnach(): StepperStage["state"] {
    if (!won) return "locked";
    if (enachGate.satisfied) return "done";
    // Gate E-NACH behind FI & V-KYC completion.
    if (!verificationComplete) return "locked";
    return "active";
  }

  // ── Per-step accordion content (Addendum V0.2 §6/§9/§10/§11) ─────────────
  // Each step's action panel is status-aware and self-locks once the step
  // succeeds (FI/VKYC hide inputs on terminal, Offer renders read-only terms,
  // E-NACH hides inputs once registered/waived, Sanction shows "disbursed").
  // So a completed step opens as a read-only summary automatically.
  // The Verification step is the NBFC's review surface: always show the full
  // customer dossier (details + verified documents from Steps 1–3) with a
  // Download (ZIP) + Next → Offer action bar. When FI / Video KYC are opted in
  // for this lead, their live track panels render below the dossier (§7.4).
  // Section G (NBFCs the customer picked) and the Indicated Loan Product lead
  // the Verification step — they frame the offer before the customer dossier.
  const sectionGCard = (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
        Section G — NBFCs the customer picked
      </h2>
      {pickedNbfcRows.length === 0 ? (
        <p className="text-sm text-slate-500">No picks recorded.</p>
      ) : (
        <ul className="space-y-2">
          {pickedNbfcRows.map((n) => {
            const isUs = myNbfcId !== null && n.id === myNbfcId;
            return (
              <li
                key={n.id}
                className={`px-3 py-2.5 rounded-lg border text-sm flex items-center justify-between ${
                  isUs
                    ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/5"
                    : "border-slate-200"
                }`}
              >
                <div>
                  <div className="font-semibold text-slate-800">
                    {n.short_name}
                  </div>
                  <div className="text-xs text-slate-500">{n.legal_name}</div>
                </div>
                {isUs && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-sky)]">
                    This NBFC
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  const loanProductCard = loanProduct ? (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
        Indicated Loan Product
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field k="Product" v={loanProduct.product_name} />
        <Field k="Status" v={loanProduct.status} />
        <Field
          k="Loan amount"
          v={`${fmtInr(loanProduct.loan_amount_min)} – ${fmtInr(loanProduct.loan_amount_max)}`}
        />
        <Field
          k="Tenure (months)"
          v={`${loanProduct.tenure_months_min} – ${loanProduct.tenure_months_max}`}
        />
        <Field
          k="ROI (%)"
          v={`${loanProduct.min_roi_pct} – ${loanProduct.max_roi_pct}`}
        />
        <Field k="Down payment (%)" v={`${loanProduct.down_payment_pct}`} />
        <Field
          k="Disbursement TAT"
          v={
            loanProduct.disbursement_tat_hours != null
              ? `${loanProduct.disbursement_tat_hours}h`
              : null
          }
        />
        <Field k="Credit bureau" v={loanProduct.credit_bureau} />
      </dl>
    </section>
  ) : null;

  const verifyContent = (
    <div className="space-y-4">
      {dossier ? (
        <CustomerDossierPanel
          dossier={dossier}
          leadId={leadId}
          afterHero={
            <>
              {sectionGCard}
              {loanProductCard}
            </>
          }
        />
      ) : null}
    </div>
  );

  // FI + Passive Video KYC — their own step ("FI & V-KYC", step 3). They only
  // become interactive once this NBFC wins the offer; until then they are
  // locked behind a notice.
  const fivkycContent = (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-7 w-7 place-items-center rounded-lg text-white shadow-sm"
          style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-teal), var(--color-brand-navy))" }}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </span>
        <div>
          <p className="text-sm font-semibold tracking-tight text-slate-900">Field Investigation &amp; Passive Video KYC</p>
          <p className="text-[11px] text-slate-400">
            {won
              ? "Stage-1 verification tracks — run these for the winning lead"
              : "Unlock once this NBFC wins the offer"}
          </p>
        </div>
      </div>
      {won ? (
        <>
          <FiTrackPanel leadId={leadId} />
          <VkycTrackPanel leadId={leadId} />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center">
          <svg
            className="mx-auto mb-2 h-5 w-5 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="text-sm font-semibold text-slate-600">
            Field Investigation &amp; Passive Video KYC are locked
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {lost
              ? "This NBFC was not selected — verification tracks do not apply."
              : "They unlock once the customer selects this NBFC as the winning lender."}
          </p>
        </div>
      )}
    </div>
  );

  // Winner outcome — folded into the Offer step (§9.1). Once won, a Next button
  // advances to the FI & V-KYC step.
  const winnerBanner = (
    <div
      className={`rounded-lg border px-3 py-2.5 text-xs font-medium leading-relaxed ${
        won
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : lost
            ? "border-slate-200 bg-slate-50 text-slate-600"
            : "border-sky-200 bg-sky-50 text-sky-800"
      }`}
    >
      {won
        ? "Selected as the winning lender by the customer — proceed to Field Investigation & Passive Video KYC."
        : lost
          ? "Not selected — a competing offer won. No further action."
          : status === "offer_submitted"
            ? "Offer submitted — awaiting the customer's decision between competing offers."
            : "Submit your financing offer first; the customer then picks the winner across competing NBFCs."}
    </div>
  );

  const offerContent = (
    <div className="space-y-4">
      <OfferPanel leadId={leadId} />
      {offerSubmitted ? winnerBanner : null}
      {won ? (
        <GoToStepButton stepKey="fivkyc" label="Next: FI & V-KYC" />
      ) : null}
    </div>
  );

  const enachContent = !won ? (
    <p className="text-sm text-slate-500">
      {lost
        ? "This NBFC was not selected — Stage 2 does not apply."
        : "E-NACH mandate registration and the agreement unlock once the customer selects this NBFC as the winning lender (§9.1)."}
    </p>
  ) : !verificationComplete ? (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center">
      <svg
        className="mx-auto mb-2 h-5 w-5 text-slate-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <p className="text-sm font-semibold text-slate-600">
        E-NACH &amp; Agreement are locked
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Complete Field Investigation &amp; Passive Video KYC (step 3) before
        registering the E-NACH mandate.
      </p>
    </div>
  ) : (
    <div className="space-y-3">
      <EnachTrackPanel leadId={leadId} />
      <AgreementTrackPanel leadId={leadId} />
      <p className="text-[11px] leading-relaxed text-slate-500 border-t border-slate-100 pt-3">
        <b className="text-slate-600">Agreement &amp; documents (§11).</b>{" "}
        iTarang facilitates and files the sanction letter / loan agreement but is
        not a party to them; document storage is optional. The Step-5 OTP —
        captured on the dealer side — is the hard gate for battery-sold,
        disbursal and warranty.
      </p>
    </div>
  );

  const disburseContent = won ? (
    <SanctionPanel leadId={leadId} />
  ) : (
    <p className="text-sm text-slate-500">
      Disbursal unlocks for the winning lead once the E-NACH mandate and
      verification gates are satisfied.
    </p>
  );

  const stages: StepperStage[] = [
    {
      key: "verify",
      // Verification here is the dossier review — FI / Video KYC moved to the
      // Offer step. Done once the offer is submitted (or the lead has moved on);
      // clicking "Next: Offer" also marks it done client-side.
      label: "Verification",
      sub: offerSubmitted || sanctioned ? "reviewed" : "review dossier",
      state: offerSubmitted || sanctioned ? "done" : "active",
      content: verifyContent,
    },
    {
      key: "offer",
      // The winner outcome is folded into the Offer step (§9.1).
      label: "Offer",
      sub: won
        ? "selected"
        : lost
          ? "not selected"
          : offerSubmitted
            ? "submitted · awaiting decision"
            : "pending",
      state: nodeOffer(),
      content: offerContent,
    },
    {
      key: "fivkyc",
      label: "FI & V-KYC",
      sub: !won
        ? "winner only"
        : verificationFailed
          ? "action needed"
          : !verificationRequired
            ? "not required"
            : verificationComplete
              ? "complete"
              : "in progress",
      state: nodeFivkyc(),
      content: fivkycContent,
    },
    {
      key: "enach",
      label: "E-NACH & Agreement",
      sub: !won
        ? "winner only"
        : enachGate.satisfied
          ? enachGate.status === "skipped"
            ? "waived"
            : "registered"
          : !verificationComplete
            ? "awaiting FI & V-KYC"
            : "pending",
      state: nodeEnach(),
      content: enachContent,
    },
    {
      key: "disburse",
      label: "Disbursal",
      sub: sold
        ? "disbursed & dispatched"
        : sanctioned
          ? "sanctioned · awaiting dealer OTP"
          : disbursalReady
            ? "ready"
            : "—",
      // `sold` (post-OTP) is the terminal state we model — disbursement transfer
      // itself is PARKED (§19.1), so we don't gate on a money-movement record.
      state: sold ? "done" : disbursalReady || sanctioned ? "active" : "locked",
      content: disburseContent,
    },
  ];

  function deriveNextAction(): NextAction {
    if (lost)
      return {
        tone: "muted",
        text: "This NBFC was not selected by the customer — a competing offer won. No further action.",
      };
    if (closed)
      return {
        tone: "muted",
        text: `This lead is ${STATUS_LABEL[status] ?? status}. No further action.`,
      };
    if (sold)
      return {
        tone: "success",
        text: "Loan sanctioned and battery dispatched — origination complete. (Disbursement transfer is out of scope, §19.1.)",
      };
    if (sanctioned)
      return {
        tone: "success",
        text: "Loan sanctioned — the dealer can now complete Step 5 (OTP + dispatch).",
      };
    // Winning lead — Field Investigation / Video KYC unlock here, then Stage 2.
    if (won) {
      if (verificationFailed)
        return {
          tone: "danger",
          text: "A verification track failed. Review Field Investigation / Video KYC in the FI & V-KYC step — re-initiate or record the outcome.",
        };
      if (!verificationComplete)
        return {
          tone: "info",
          text: "FI Coordinator & Operations: this NBFC won — complete Field Investigation and Passive Video KYC (now unlocked in the FI & V-KYC step).",
        };
      if (enachGate.required && !enachGate.satisfied)
        return {
          tone: "info",
          text: "Operations: register the E-NACH mandate for the winning lead (Stage 2, winner-only).",
        };
      if (disbursalReady)
        return {
          tone: "success",
          text: "All applicable verification tracks satisfied — ready to sanction & disburse.",
        };
      return {
        tone: "info",
        text: "Winning lead — complete the Stage-2 mandate and disbursal steps below.",
      };
    }
    // Pre-win — submit the offer, then await the customer's decision.
    if (!offerSubmitted)
      return {
        tone: "info",
        text: "Credit / Underwriting: submit the firm financing offer for this lead.",
      };
    if (status === "offer_submitted")
      return {
        tone: "info",
        text: "Offer submitted — awaiting the customer's decision between competing offers.",
      };
    return { tone: "muted", text: "Awaiting the next step." };
  }

  const nextAction = deriveNextAction();

  return (
    <div className="px-6 py-8 space-y-6 max-w-6xl mx-auto">
      <div>
        <Link
          href="/nbfc/acquire"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to pipeline
        </Link>
      </div>

      <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-lg px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <p className="text-xs leading-relaxed">
          Field Investigation and Video KYC are run at this NBFC&apos;s own
          cost. If the customer picks another lender, no per-service refund
          applies.
        </p>
      </div>

      <header className="border border-slate-200 rounded-xl bg-white p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Acquire · Lead
            </p>
            <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
              {lead.full_name ?? lead.owner_name ?? "—"}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              <span className="font-mono">{lead.id}</span>
              {" · "}
              {lead.phone ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Asset price
            </p>
            <p className="text-xl font-bold text-slate-800">
              {fmtInr(ps?.final_price)}
            </p>
            <p className="text-xs text-slate-500 mt-2">
              Assigned {fmtDate(assignment.assigned_at)}
            </p>
          </div>
        </div>
      </header>

      <LeadStageStepper stages={stages} nextAction={nextAction} leadId={leadId} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="border border-slate-200 rounded-xl bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
            Dealer
          </h2>
          <div className="text-sm font-medium text-slate-800">
            {dealerRow?.company_name ?? "—"}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {dealerRow?.dealer_id ?? lead.dealer_id ?? "—"}
          </div>
        </section>

        <section className="border border-slate-200 rounded-xl bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">
            Origination steps
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            Use the progress rail above — click any step to open its panel.
            Stage-1 (FI + Video KYC) runs in parallel and competitively; E-NACH
            and disbursal are winner-only (§9.1). A completed step is locked and
            read-only.
          </p>
        </section>
      </div>
    </div>
  );
}

function Field({
  k,
  v,
  span,
}: {
  k: string;
  v: string | number | null | undefined;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
        {k}
      </dt>
      <dd className="text-sm text-slate-700 mt-0.5">
        {v == null || v === "" ? <span className="text-slate-300">—</span> : v}
      </dd>
    </div>
  );
}

