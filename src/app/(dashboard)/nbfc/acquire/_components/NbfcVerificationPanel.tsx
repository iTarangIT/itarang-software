"use client";

import { useState } from "react";

import RequestMoreDocsModal from "@/components/kyc/step3/RequestMoreDocsModal";
import type { DocItem } from "@/components/kyc/step3/RequestMoreDocsModal";
import NbfcRequestThread from "./NbfcRequestThread";

// Change 2 & 4 (NBFC side): the NBFC's correction / additional-document /
// co-borrower request loop that routes to the admin, plus the request-history
// thread. The rich per-document KYC verification cards (Aadhaar/PAN/Bank/
// CIBIL/RC) were removed from this surface; only the request loop remains.
//
// EVERY request on this panel now goes to the iTarang admin first.
// The E-240 "Ask Dealer for Documents" button, which wrote straight to the
// dealer's Step-4 card, is gone: the admin is the single gate, and answers by
// either uploading the document himself or forwarding the ask to the
// dealer/customer. Legacy direct threads raised before this still render (and
// can still be replied to) in the history below.

export default function NbfcVerificationPanel({
  leadId,
}: {
  leadId: string;
}) {
  const [docFor, setDocFor] = useState<"primary" | "co_borrower">("primary");
  const [refreshSignal, setRefreshSignal] = useState(0);
  // request composer state: which doc_key is being requested + the mode
  const [composer, setComposer] = useState<{
    docKey: string | null;
    mode:
      | "correction"
      | "additional_docs"
      | "step4_extra_items"
      | "co_borrower";
    comment: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  // Rich "Request Additional Documents" modal (mirrors the admin one).
  const [showDocsModal, setShowDocsModal] = useState(false);

  const submitRequest = async () => {
    if (!composer) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/doc-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_type: composer.mode,
          // A co-borrower ask is about the co-borrower regardless of the current
          // applicant toggle.
          doc_for: composer.mode === "co_borrower" ? "co_borrower" : docFor,
          target_doc_key: composer.docKey,
          comments: composer.comment,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setComposer(null);
        setRefreshSignal((n) => n + 1);
        setBanner("Request sent to the iTarang admin.");
      } else {
        setBanner(json.error ?? "Could not send request");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Rich additional-documents request → routes to the admin. The structured
  // items (label / reason / required) are serialised into the request comments
  // so the admin sees exactly what the NBFC wants before forwarding to the dealer.
  const submitDocsRequest = async ({
    items,
    doc_for,
  }: {
    items: DocItem[];
    doc_for: "primary" | "co_borrower";
  }): Promise<{ success: boolean; error?: string }> => {
    const comments = items
      .map(
        (it, i) =>
          `${i + 1}. ${it.doc_label}${it.is_required ? " (required)" : " (optional)"} — ${it.reason}`,
      )
      .join("\n");
    try {
      const res = await fetch(`/api/nbfc/acquire/${leadId}/doc-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_type: "additional_docs",
          doc_for,
          comments,
          // E-254 — the same items, structured, so an SLA auto-forward can
          // create them without parsing the text above.
          items: items.map((it) => ({
            doc_label: it.doc_label,
            reason: it.reason,
            is_required: it.is_required,
          })),
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setRefreshSignal((n) => n + 1);
        setBanner("Request sent to the admin.");
        return { success: true };
      }
      return { success: false, error: json.error ?? "Could not send request" };
    } catch {
      return { success: false, error: "Network error. Please try again." };
    }
  };

  return (
    <section
      id="nbfc-requests"
      className="scroll-mt-24 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      {/* Premium header — gradient icon badge + applicant toggle */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-gradient-to-br from-slate-50 to-white px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            className="grid h-9 w-9 place-items-center rounded-xl text-white shadow-sm"
            style={{
              backgroundImage:
                "linear-gradient(135deg, var(--color-brand-teal), var(--color-brand-navy))",
            }}
          >
            <svg
              className="h-4.5 w-4.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <div>
            <h2 className="text-sm font-bold tracking-tight text-slate-900">
              NBFC Document Requests
            </h2>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Every request goes to the iTarang admin, who either sends you the
              document straight away or collects it from the dealer/customer.
            </p>
          </div>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs shadow-sm">
          <button
            type="button"
            onClick={() => setDocFor("primary")}
            className={`rounded-md px-3 py-1 font-semibold transition ${
              docFor === "primary"
                ? "bg-[color:var(--color-brand-navy)] text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            Customer
          </button>
          <button
            type="button"
            onClick={() => setDocFor("co_borrower")}
            className={`rounded-md px-3 py-1 font-semibold transition ${
              docFor === "co_borrower"
                ? "bg-[color:var(--color-brand-navy)] text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            Co-borrower
          </button>
        </div>
      </div>

      <div className="p-5">
        {banner ? (
          <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {banner}
          </p>
        ) : null}

        {/* "Request Documents" is the primary ask and leads the row.
            It, and every other button here, raises the request with the iTarang
            admin; the admin either uploads the document himself or forwards the
            ask down to the dealer/customer and returns the reviewed file. */}
        <button
          type="button"
          onClick={() => setShowDocsModal(true)}
          className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
          style={{
            backgroundImage:
              "linear-gradient(135deg, var(--color-brand-teal), var(--color-brand-navy))",
          }}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M12 12v6" />
            <path d="M9 15h6" />
          </svg>
          Request Documents
        </button>

        {/* Change 2 / 4 — document-request loop to the admin. */}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() =>
              setComposer({ docKey: null, mode: "correction", comment: "" })
            }
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 transition hover:bg-amber-100"
          >
            Request Correction
          </button>
          <button
            type="button"
            onClick={() =>
              setComposer({ docKey: null, mode: "co_borrower", comment: "" })
            }
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-semibold text-violet-700 transition hover:bg-violet-100"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Request Co-Borrower
          </button>
        </div>

        {composer ? (
          <div className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
            <p className="mb-1.5 text-xs font-semibold text-slate-700">
              {composer.mode === "correction"
                ? `Request a correction — ${docFor === "primary" ? "Customer" : "Co-borrower"}`
                : composer.mode === "step4_extra_items"
                  ? "Request Step-4 extra items (max 10)"
                  : composer.mode === "co_borrower"
                    ? "Request a co-borrower — the admin will ask the dealer to add one"
                    : `Request additional documents — ${docFor === "primary" ? "Customer" : "Co-borrower"}`}
            </p>
            <p className="mb-1.5 text-[11px] leading-relaxed text-slate-500">
              This goes to the iTarang admin. If they already hold the document
              they will send it to you directly; otherwise they forward the ask
              to the dealer/customer, review what comes back, and push it here.
            </p>
            <textarea
              value={composer.comment}
              onChange={(e) =>
                setComposer((c) => (c ? { ...c, comment: e.target.value } : c))
              }
              rows={3}
              placeholder={
                composer.mode === "co_borrower"
                  ? "Explain why a co-borrower is needed (e.g. primary CIBIL is low / high DTI)…"
                  : "Describe exactly which document you need — e.g. the last 6 months' statement for the CURRENT account, not the savings one."
              }
              className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={submitting || !composer.comment.trim()}
                onClick={submitRequest}
                className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send to admin"}
              </button>
              <button
                type="button"
                onClick={() => setComposer(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-5 border-t border-slate-100 pt-4">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            Request history
          </h3>
          <NbfcRequestThread leadId={leadId} refreshSignal={refreshSignal} />
        </div>
      </div>

      {/* Rich "Request Additional Documents" modal — same UI the admin uses. The
          structured request routes to the admin, who forwards it to the dealer. */}
      <RequestMoreDocsModal
        open={showDocsModal}
        onClose={() => setShowDocsModal(false)}
        leadId={leadId}
        defaultDocFor={docFor}
        submitItems={submitDocsRequest}
        title="Request Additional Documents"
        noteText="This request is sent to the iTarang admin, who reviews it and forwards it to the dealer/customer. You'll see its status in the request history below."
        submitLabel="Send to admin"
      />
    </section>
  );
}
