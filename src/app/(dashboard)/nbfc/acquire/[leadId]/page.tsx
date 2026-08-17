import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import {
  dealers,
  leads,
  nbfc,
  nbfcFinancingOffers,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  productSelections,
} from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import { getFiTrack } from "@/lib/nbfc/fi";
import { getVkycTrack } from "@/lib/nbfc/vkyc";
import { evaluateEnachGate } from "@/lib/nbfc/enach";
import { evaluateAgreementGate } from "@/lib/nbfc/agreement";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";
import { getCustomerDossier } from "@/lib/nbfc/dossier";
import CustomerDossierPanel from "../_components/CustomerDossierPanel";
import EnachTrackPanel from "../_components/EnachTrackPanel";
import AgreementTrackPanel from "../_components/AgreementTrackPanel";
import VkycTrackPanel from "../_components/VkycTrackPanel";
import FiTrackPanel from "../_components/FiTrackPanel";
import OfferPanel from "../_components/OfferPanel";
import GoToStepButton from "../_components/GoToStepButton";
import SanctionPanel from "../_components/SanctionPanel";
import NbfcVerificationPanel from "../_components/NbfcVerificationPanel";
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
  // E-241 — 'withdrawn' has exactly one writer: the dealer's Close deal action.
  // "Withdrawn" reads like an internal state change of unknown origin; this is a
  // customer decision and the panel should say whose it was.
  withdrawn: "Deal closed by customer",
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
  // Which steps run is read LIVE from Settings → Service Opt-In, so switching a
  // service off takes it out of this lead straight away (and switching it back
  // on restores it). The snapshot still governs the mechanics — vkyc_mode,
  // handoff method, storage, Track Rules. See resolveServiceOptIn.
  const optIn = await resolveServiceOptIn(
    tenant.id,
    assignment.service_config_snapshot,
  );
  const status = assignment.status;

  const fiRequired = optIn.fi_enabled;
  const fiRow = fiRequired ? await getFiTrack(leadId, assignment.nbfc_id) : null;
  // FI terminal-pass is status "passed" (E-148; legacy E-136 rows used
  // "completed", backfilled but accepted here to match track-gate.ts).
  const fiComplete =
    !fiRequired || fiRow?.status === "passed" || fiRow?.status === "completed";
  const fiFailed =
    fiRequired && (fiRow?.status === "failed" || fiRow?.outcome === "fail");

  const vkycRequired = optIn.vkyc_enabled;
  const vkycRow = vkycRequired
    ? await getVkycTrack(leadId, assignment.nbfc_id)
    : null;
  const vkycComplete = !vkycRequired || vkycRow?.status === "verified";
  const vkycFailed = vkycRequired && vkycRow?.status === "failed";

  const enachGate = await evaluateEnachGate(leadId);

  // ── Opted-out steps (Addendum V0.3.1 §13.2.3) ───────────────────────────
  // A rail switched off in Settings → Service Opt-In does not run through
  // iTarang. Its stepper node reads "Skipped", its panel carries no actions,
  // and the matching APIs reject. Switching the service back on re-opens the
  // step for this lead too — the toggles are read live (see resolveServiceOptIn).
  //
  // E-NACH's flag comes from `optIn` rather than `enachGate.required` — the
  // gate resolves against the WINNING assignment, so it reports "not required"
  // for every lead that has no winner yet.
  const agreementRequired = optIn.doc_agreement_method != null;
  const enachRequired = optIn.enach_enabled;
  const fivkycSkipped = !fiRequired && !vkycRequired;
  const enachStepSkipped = !enachRequired && !agreementRequired;

  // Advisory agreement state (§11.5 — never a disbursal gate). Needed here so
  // that when E-NACH is opted out and the agreement is the step's only live
  // rail, the node doesn't read "Completed" with an unsigned agreement in it.
  const agreementGate = agreementRequired
    ? await evaluateAgreementGate(
        leadId,
        assignment.nbfc_id,
        optIn.doc_agreement_method,
      )
    : null;

  // Full customer dossier (Steps 1–3 + product selection) for the Verification
  // step. `lead` already exists (guarded above), so this is non-null.
  const dossier = await getCustomerDossier(leadId);

  const offerSubmitted = [
    "offer_submitted",
    "selected",
    "not_selected",
    // E-241 — closing takes the assignment straight from 'offer_submitted' to
    // 'withdrawn'. Without this the Offer step reads "pending · Locked" while
    // the submitted offer sits rendered directly underneath it, and Verification
    // (which keys off the same flag) reverts to "review dossier".
    "withdrawn",
  ].includes(status);
  // E-238 — negotiation state of this NBFC's offer, for the Next banner. The
  // Offer node's own state is unchanged: it stays `active` throughout a
  // negotiation, which is already what offerSubmitted gives it.
  const [offerNegotiation] = await db
    .select({ negotiation_status: nbfcFinancingOffers.negotiation_status })
    .from(nbfcFinancingOffers)
    .where(eq(nbfcFinancingOffers.assignment_id, assignment.id))
    .limit(1);
  const dealerCountered = offerNegotiation?.negotiation_status === "dealer_countered";
  const offerFixed = offerNegotiation?.negotiation_status === "fixed";
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
    // Closed outranks submitted. E-241 made offerSubmitted true for 'withdrawn'
    // — the offer really was submitted, and Verification upstream must stay
    // done — but a green Completed check over a deal the customer walked away
    // from reads as a win. Locked + the red badge is the honest pair.
    if (closed) return "locked";
    if (offerSubmitted) return "done";
    return "active";
  }
  function nodeFivkyc(): StepperStage["state"] {
    // Both rails opted out in Settings — the step never runs here at all, so it
    // outranks the winner gate (it stays skipped whether we win or lose).
    if (fivkycSkipped) return "skipped";
    // FI / Video KYC only run for the winning lead.
    if (!won) return "locked";
    if (verificationFailed) return "failed";
    if (!verificationRequired) return "done";
    return verificationComplete ? "done" : "active";
  }
  function nodeEnach(): StepperStage["state"] {
    if (enachStepSkipped) return "skipped";
    if (!won) return "locked";
    // Both live rails must be settled before the step reads as complete. An
    // opted-out rail reports satisfied, so it drops out of the check.
    const agreementOk = !agreementGate?.applicable || agreementGate.satisfied;
    if (enachGate.satisfied && agreementOk) return "done";
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
      {/* Change 1 & 2 — the NBFC's own per-document verification + the
          correction / additional-document request loop (routes to the admin). */}
      <NbfcVerificationPanel leadId={leadId} />
    </div>
  );

  // Every rail of the step is switched off in Settings → Service Opt-In. The
  // step stays on the rail (§13.2.3 "dimmed but visible") but carries no action
  // surface at all — the track panels are not rendered, so there is nothing to
  // click, and the underlying APIs reject on the same snapshot flags.
  const optedOutContent = (services: string) => (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center">
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
        Skipped — handled off-platform
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
        {services} are switched off in{" "}
        <b className="text-slate-600">Settings → Service Opt-In</b>, so this step
        does not run through iTarang and no action can be taken here. Switch it
        back on in Settings and the step re-opens for this lead.
      </p>
    </div>
  );

  // "Next: …" buttons must hop OVER a skipped step — landing the reviewer on a
  // step they cannot act on would be a dead end.
  const STEP_LABEL: Record<string, string> = {
    fivkyc: "FI & V-KYC",
    enach: "E-NACH & Agreement",
    disburse: "Disbursal",
  };
  const nextLiveStep = (after: "offer" | "fivkyc") => {
    if (after === "offer" && !fivkycSkipped) return "fivkyc";
    return enachStepSkipped ? "disburse" : "enach";
  };

  // FI + Passive Video KYC — their own step ("FI & V-KYC", step 3). They only
  // become interactive once this NBFC wins the offer; until then they are
  // locked behind a notice.
  const fivkycContent = fivkycSkipped ? (
    optedOutContent("Field Investigation and Video KYC")
  ) : (
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
          <p className="text-sm font-semibold tracking-tight text-slate-900">
            {fiRequired && vkycRequired
              ? "Field Investigation & Passive Video KYC"
              : fiRequired
                ? "Field Investigation"
                : "Passive Video KYC"}
          </p>
          <p className="text-[11px] text-slate-400">
            {won
              ? "Stage-1 verification tracks — run these for the winning lead"
              : "Unlock once this NBFC wins the offer"}
          </p>
        </div>
      </div>
      {/* Only the opted-in rails render — an opted-out one has no panel at all,
          so there is no surface to act on. */}
      {!fiRequired || !vkycRequired ? (
        <p className="text-[11px] text-slate-500">
          {fiRequired ? "Video KYC is" : "Field Investigation is"} switched off in
          Settings → Service Opt-In — handled off-platform.
        </p>
      ) : null}
      {won ? (
        <>
          {fiRequired ? <FiTrackPanel leadId={leadId} /> : null}
          {vkycRequired ? <VkycTrackPanel leadId={leadId} /> : null}
          {verificationComplete ? (
            <GoToStepButton
              stepKey={nextLiveStep("fivkyc")}
              label={`Next: ${STEP_LABEL[nextLiveStep("fivkyc")]}`}
            />
          ) : null}
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
          : status === "withdrawn"
            ? "border-red-200 bg-red-50 text-red-800"
            : lost
              ? "border-slate-200 bg-slate-50 text-slate-600"
              : "border-sky-200 bg-sky-50 text-sky-800"
      }`}
    >
      {won
        ? `Selected as the winning lender by the customer — proceed to ${STEP_LABEL[nextLiveStep("offer")]}.`
        : // E-241 — the customer ended this conversation. Distinct from `lost`:
          // nobody outbid you, the deal itself was closed.
          status === "withdrawn"
          ? "Deal closed by the customer — this offer is withdrawn and can no longer be revised or fixed. Their reason is on the offer above."
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
        <GoToStepButton
          stepKey={nextLiveStep("offer")}
          label={`Next: ${STEP_LABEL[nextLiveStep("offer")]}`}
        />
      ) : null}
    </div>
  );

  const enachContent = enachStepSkipped ? (
    optedOutContent("E-NACH and the loan agreement")
  ) : !won ? (
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
      {/* Only the opted-in rails render — an opted-out one has no panel. */}
      {!enachRequired || !agreementRequired ? (
        <p className="text-[11px] text-slate-500">
          {enachRequired ? "The loan agreement is" : "E-NACH is"} switched off in
          Settings → Service Opt-In — handled off-platform.
        </p>
      ) : null}
      {enachRequired ? <EnachTrackPanel leadId={leadId} /> : null}
      {agreementRequired ? <AgreementTrackPanel leadId={leadId} /> : null}
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
          : status === "withdrawn"
            ? "deal closed by customer"
            : offerSubmitted
              ? "submitted · awaiting decision"
              : "pending",
      state: nodeOffer(),
      // E-241 — "Completed" would read as a won deal; this one ended.
      badge:
        status === "withdrawn"
          ? {
              label: "Deal closed by customer",
              cls: "bg-red-50 text-red-700 border-red-200",
            }
          : undefined,
      content: offerContent,
    },
    {
      key: "fivkyc",
      label: "FI & V-KYC",
      sub: fivkycSkipped
        ? "opted out"
        : !won
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
      sub: enachStepSkipped
        ? "opted out"
        : !won
          ? "winner only"
          : !enachRequired
            ? agreementGate?.satisfied
              ? "agreement signed"
              : "agreement pending"
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
    if (status === "withdrawn")
      return {
        tone: "muted",
        text: "Deal closed by the customer — they ended this conversation and the offer is withdrawn. See the reason on the offer above. No further action.",
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
          text: `FI Coordinator & Operations: this NBFC won — complete ${
            fiRequired && vkycRequired
              ? "Field Investigation and Passive Video KYC"
              : fiRequired
                ? "Field Investigation"
                : "Passive Video KYC"
          } (now unlocked in the FI & V-KYC step).`,
        };
      if (enachGate.required && !enachGate.satisfied)
        return {
          tone: "info",
          text: "Operations: register the E-NACH mandate for the winning lead (Stage 2, winner-only).",
        };
      // E-NACH opted out but the agreement rail is still live — that's the
      // outstanding Stage-2 item, so name it rather than the mandate.
      if (agreementGate?.applicable && !agreementGate.satisfied)
        return {
          tone: "info",
          text: "Operations: complete the loan agreement for the winning lead (E-NACH is handled off-platform for this NBFC).",
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
    // E-238 — the customer has come back with an ask; the lead is stalled on us,
    // not on them, so say so before the generic "awaiting decision" line.
    if (dealerCountered)
      return {
        tone: "warning",
        text: "Credit / Underwriting: the customer requested revised terms — revise the offer, or fix the current terms to close the negotiation.",
      };
    if (status === "offer_submitted")
      return {
        tone: "info",
        text: offerFixed
          ? "Terms fixed — awaiting the customer's decision between competing offers."
          : "Offer submitted — awaiting the customer's decision between competing offers.",
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

