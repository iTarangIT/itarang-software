"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  id: string;
  actionType: string;
  tenantName: string;
  reasonCode: string;
  loanApplicationId: string;
  vehicleno: string | null;
  imei: string | null;
  outstandingAmount: string | null;
  currentDpd: number | null;
  initiator: string;
  createdAt: Date | null;
  expiresAt: Date | null;
}

const REASON_LABEL: Record<string, string> = {
  dpd_60: "DPD ≥ 60",
  dpd_90: "DPD ≥ 90",
  fraud_flag: "Fraud flag",
  manual: "Manual",
};

export default function ImmobilisationApprovalCard(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const expiresIn = props.expiresAt
    ? Math.max(0, Math.round((props.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000)))
    : null;

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch(`/api/sales-head/nbfc/approvals/${props.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function reject() {
    if (rejectReason.trim().length < 3) {
      setError("Reason must be at least 3 characters.");
      return;
    }
    setBusy("reject");
    setError(null);
    try {
      const res = await fetch(`/api/sales-head/nbfc/approvals/${props.id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rejection_reason: rejectReason.trim() }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-orange-600">
            {props.actionType.replace(/_/g, " ")}
          </p>
          <h3 className="text-lg font-bold text-gray-900 mt-1">
            {props.tenantName} → loan {props.loanApplicationId}
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Initiated by {props.initiator}
            {props.createdAt ? ` on ${props.createdAt.toLocaleString()}` : ""}
            {expiresIn != null ? ` · expires in ${expiresIn}h` : ""}
          </p>
        </div>
        <span className="px-3 py-1 bg-amber-50 text-amber-700 text-xs font-bold uppercase rounded">
          {REASON_LABEL[props.reasonCode] ?? props.reasonCode}
        </span>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-4 text-sm">
        <Field label="Vehicle" value={props.vehicleno ?? "—"} />
        <Field label="IMEI" value={props.imei ?? "—"} mono />
        <Field
          label="Outstanding"
          value={
            props.outstandingAmount
              ? `₹${Number(props.outstandingAmount).toLocaleString("en-IN")}`
              : "—"
          }
        />
        <Field label="Current DPD" value={props.currentDpd != null ? `${props.currentDpd}d` : "—"} />
      </dl>

      {error ? (
        <div className="mb-3 px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>
      ) : null}

      {showReject ? (
        <div className="flex flex-col gap-2 mb-3">
          <label className="text-xs font-bold uppercase tracking-widest text-gray-500">
            Rejection reason
          </label>
          <textarea
            className="border border-gray-300 rounded p-2 text-sm"
            rows={2}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            disabled={busy !== null}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 justify-end">
        {showReject ? (
          <>
            <button
              onClick={() => {
                setShowReject(false);
                setRejectReason("");
                setError(null);
              }}
              disabled={busy !== null}
              className="px-4 py-2 text-sm font-bold text-gray-600 hover:text-gray-900 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={reject}
              disabled={busy !== null || rejectReason.trim().length < 3}
              className="px-4 py-2 text-sm font-bold rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy === "reject" ? "Rejecting…" : "Confirm reject"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setShowReject(true)}
              disabled={busy !== null}
              className="px-4 py-2 text-sm font-bold rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              onClick={approve}
              disabled={busy !== null}
              className="px-4 py-2 text-sm font-bold rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve immobilisation"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</dt>
      <dd className={`mt-0.5 text-gray-900 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
