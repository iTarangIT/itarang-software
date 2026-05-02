"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

// BRD V2 Part E — admin Step 4 product review panel.
// Shows the submitted product selection (read-only) and exposes the four
// admin actions: Loan Sanctioned, Loan Rejected, Download Profile, Back.

interface ParaLine {
  asset_type: string;
  model_type?: string | null;
  product_name?: string | null;
  qty: number;
  unit_gross: number;
  gst_percent: number;
  gst_amount: number;
  unit_net: number;
  line_gross: number;
  line_gst: number;
  line_net: number;
}

interface ProductSelection {
  id: string;
  battery_serial: string | null;
  charger_serial: string | null;
  paraphernalia: Record<string, unknown> | null;
  paraphernalia_lines: ParaLine[] | null;
  category: string | null;
  sub_category: string | null;
  battery_price: string | null;
  charger_price: string | null;
  paraphernalia_cost: string | null;
  dealer_margin: string | null;
  final_price: string | null;
  battery_gross: string | null;
  battery_gst_percent: string | null;
  battery_gst_amount: string | null;
  battery_net: string | null;
  charger_gross: string | null;
  charger_gst_percent: string | null;
  charger_gst_amount: string | null;
  charger_net: string | null;
  gross_subtotal: string | null;
  gst_subtotal: string | null;
  net_subtotal: string | null;
  payment_mode: string | null;
  admin_decision: string | null;
  submitted_at: string | null;
}

interface LoanSanction {
  id: string;
  status: string;
  loan_amount: string | null;
  emi: string | null;
  tenure_months: number | null;
  loan_approved_by: string | null;
  loan_file_number: string | null;
  rejection_reason: string | null;
  sanctioned_at: string | null;
}

interface PanelData {
  leadStatus: string | null;
  paymentMethod: string | null;
  selection: ProductSelection | null;
  battery: Record<string, unknown> | null;
  charger: Record<string, unknown> | null;
  loanSanction: LoanSanction | null;
}

const emptyLoanForm = {
  loanAmount: "",
  downPayment: "",
  fileCharge: "",
  subvention: "0",
  disbursementAmount: "",
  emi: "",
  tenureMonths: "",
  roi: "",
  loanApprovedBy: "",
  loanFileNumber: "",
};

export default function AdminProductReviewPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.leadId as string;

  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"idle" | "sanction" | "reject">("idle");
  const [loanForm, setLoanForm] = useState(emptyLoanForm);
  const [rejectionReason, setRejectionReason] = useState("");
  const [lenderName, setLenderName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/lead/${leadId}/product-selection`);
        const json = await res.json();
        if (!cancelled) {
          if (json.success) setData(json.data);
          else setError(json.error?.message || "Failed to load");
        }
      } catch (e) {
        if (!cancelled) setError("Failed to load product selection");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  const handleSanction = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        loanAmount: Number(loanForm.loanAmount),
        downPayment: Number(loanForm.downPayment),
        fileCharge: Number(loanForm.fileCharge),
        subvention: Number(loanForm.subvention || 0),
        disbursementAmount: Number(loanForm.disbursementAmount),
        emi: Number(loanForm.emi),
        tenureMonths: Number(loanForm.tenureMonths),
        roi: Number(loanForm.roi),
        loanApprovedBy: loanForm.loanApprovedBy,
        loanFileNumber: loanForm.loanFileNumber,
      };
      const res = await fetch(`/api/admin/lead/${leadId}/sanction-loan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) router.refresh();
      else setError(json.error?.message || "Failed to sanction loan");
    } catch (e) {
      setError("Failed to sanction loan");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (rejectionReason.trim().length < 10) {
      setError("Rejection reason must be at least 10 characters");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/lead/${leadId}/reject-loan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejectionReason, lenderName: lenderName || undefined }),
      });
      const json = await res.json();
      if (json.success) router.refresh();
      else setError(json.error?.message || "Failed to reject loan");
    } catch (e) {
      setError("Failed to reject loan");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Loading…</div>;
  if (!data) return <div className="p-8 text-red-600">{error || "No data"}</div>;

  const { selection, battery, charger, loanSanction, leadStatus } = data;

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Product Selection Review</h1>
          <p className="text-sm text-gray-500">Lead {leadId}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-800 text-xs font-bold">
            {leadStatus || "—"}
          </span>
          <Link
            href={`/admin/kyc-review/${leadId}`}
            className="text-sm text-blue-600 hover:underline"
          >
            View KYC
          </Link>
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {!selection && (
        <div className="bg-yellow-50 border border-yellow-200 p-4 rounded">
          No product selection submitted yet.
        </div>
      )}

      {selection && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold text-lg">Selected Product</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Payment Mode" value={selection.payment_mode} />
            <Field label="Admin Decision" value={selection.admin_decision} />
            <Field label="Category" value={selection.category} />
            <Field label="Sub-Category" value={selection.sub_category} />
            <Field label="Battery Serial" value={selection.battery_serial} />
            <Field label="Battery Model" value={battery?.model_type as string} />
            <Field label="Charger Serial" value={selection.charger_serial} />
            <Field label="Charger Model" value={charger?.model_type as string} />
            <Field label="Submitted" value={selection.submitted_at} />
          </div>

          <div className="pt-4 border-t">
            <h3 className="font-bold text-sm mb-3">Bill Breakdown</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border border-gray-200 rounded">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-right">Gross</th>
                    <th className="px-3 py-2 text-right">GST %</th>
                    <th className="px-3 py-2 text-right">GST ₹</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  <BillRow
                    label="Battery"
                    gross={selection.battery_gross}
                    gstPct={selection.battery_gst_percent}
                    gstAmt={selection.battery_gst_amount}
                    net={selection.battery_net ?? selection.battery_price}
                    qty={1}
                  />
                  <BillRow
                    label="Charger"
                    gross={selection.charger_gross}
                    gstPct={selection.charger_gst_percent}
                    gstAmt={selection.charger_gst_amount}
                    net={selection.charger_net ?? selection.charger_price}
                    qty={1}
                  />
                  {(selection.paraphernalia_lines || []).map((line, idx) => (
                    <BillRow
                      key={`${line.asset_type}-${idx}`}
                      label={
                        line.product_name ||
                        `${line.asset_type}${line.model_type ? ` ${line.model_type}` : ""}`
                      }
                      gross={String(line.unit_gross)}
                      gstPct={String(line.gst_percent)}
                      gstAmt={String(line.gst_amount)}
                      net={String(line.unit_net)}
                      qty={line.qty}
                    />
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-bold">
                  <tr>
                    <td className="px-3 py-2">Subtotal</td>
                    <td className="px-3 py-2 text-right">
                      ₹{Number(selection.gross_subtotal ?? 0).toLocaleString("en-IN")}
                    </td>
                    <td colSpan={2} className="px-3 py-2 text-right">
                      GST ₹{Number(selection.gst_subtotal ?? 0).toLocaleString("en-IN")}
                    </td>
                    <td className="px-3 py-2 text-right">—</td>
                    <td className="px-3 py-2 text-right">
                      ₹{Number(selection.net_subtotal ?? 0).toLocaleString("en-IN")}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm pt-4 border-t">
            <Field label="Dealer Margin" value={`₹${selection.dealer_margin ?? 0}`} />
            <Field
              label="Final Price"
              value={<span className="font-bold">₹{selection.final_price ?? 0}</span>}
            />
          </div>
        </section>
      )}

      {loanSanction && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold text-lg">Loan Decision</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Status" value={loanSanction.status} />
            <Field label="Lender" value={loanSanction.loan_approved_by} />
            {loanSanction.status === "sanctioned" && (
              <>
                <Field label="Loan Amount" value={`₹${loanSanction.loan_amount}`} />
                <Field label="EMI" value={`₹${loanSanction.emi}`} />
                <Field label="Tenure" value={`${loanSanction.tenure_months} months`} />
                <Field label="File Number" value={loanSanction.loan_file_number} />
              </>
            )}
            {loanSanction.status === "rejected" && (
              <Field label="Rejection Reason" value={loanSanction.rejection_reason} />
            )}
          </div>
        </section>
      )}

      {selection && leadStatus === "pending_final_approval" && mode === "idle" && (
        <div className="flex gap-3">
          <button
            onClick={() => setMode("sanction")}
            className="px-5 py-2 bg-emerald-600 text-white rounded font-bold hover:bg-emerald-700"
          >
            Loan Sanctioned
          </button>
          <button
            onClick={() => setMode("reject")}
            className="px-5 py-2 bg-red-600 text-white rounded font-bold hover:bg-red-700"
          >
            Loan Rejected
          </button>
        </div>
      )}

      {mode === "sanction" && (
        <section className="bg-white border border-emerald-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold text-lg">Sanction Loan</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <NumberInput label="Loan Amount (₹)" value={loanForm.loanAmount} onChange={(v) => setLoanForm((f) => ({ ...f, loanAmount: v }))} />
            <NumberInput label="Down Payment (₹)" value={loanForm.downPayment} onChange={(v) => setLoanForm((f) => ({ ...f, downPayment: v }))} />
            <NumberInput label="File Charge (₹)" value={loanForm.fileCharge} onChange={(v) => setLoanForm((f) => ({ ...f, fileCharge: v }))} />
            <NumberInput label="Subvention (₹)" value={loanForm.subvention} onChange={(v) => setLoanForm((f) => ({ ...f, subvention: v }))} />
            <NumberInput label="Disbursement Amount (₹)" value={loanForm.disbursementAmount} onChange={(v) => setLoanForm((f) => ({ ...f, disbursementAmount: v }))} />
            <NumberInput label="EMI (₹)" value={loanForm.emi} onChange={(v) => setLoanForm((f) => ({ ...f, emi: v }))} />
            <NumberInput label="Tenure (months)" value={loanForm.tenureMonths} onChange={(v) => setLoanForm((f) => ({ ...f, tenureMonths: v }))} />
            <NumberInput label="Rate of Interest (%)" value={loanForm.roi} onChange={(v) => setLoanForm((f) => ({ ...f, roi: v }))} step="0.01" />
            <TextInput label="Loan Approved By (lender)" value={loanForm.loanApprovedBy} onChange={(v) => setLoanForm((f) => ({ ...f, loanApprovedBy: v }))} />
            <TextInput label="Loan File Number" value={loanForm.loanFileNumber} onChange={(v) => setLoanForm((f) => ({ ...f, loanFileNumber: v }))} />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSanction}
              disabled={submitting}
              className="px-5 py-2 bg-emerald-600 text-white rounded font-bold hover:bg-emerald-700 disabled:opacity-50"
            >
              {submitting ? "Sanctioning…" : "Submit Sanction"}
            </button>
            <button
              onClick={() => {
                setMode("idle");
                setLoanForm(emptyLoanForm);
              }}
              className="px-5 py-2 bg-gray-200 rounded"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {mode === "reject" && (
        <section className="bg-white border border-red-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold text-lg">Reject Loan</h2>
          <TextInput label="Lender Name (optional)" value={lenderName} onChange={setLenderName} />
          <div>
            <label className="block text-sm font-bold mb-1">Rejection Reason *</label>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded p-2 text-sm"
              placeholder="Minimum 10 characters. Visible to dealer."
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleReject}
              disabled={submitting}
              className="px-5 py-2 bg-red-600 text-white rounded font-bold hover:bg-red-700 disabled:opacity-50"
            >
              {submitting ? "Rejecting…" : "Submit Rejection"}
            </button>
            <button onClick={() => setMode("idle")} className="px-5 py-2 bg-gray-200 rounded">
              Cancel
            </button>
          </div>
        </section>
      )}

      <div className="pt-4">
        <a
          href={`/api/admin/lead/${leadId}/download-profile`}
          className="text-sm text-blue-600 hover:underline"
        >
          Download Customer Profile (summary JSON)
        </a>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode | string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="font-medium text-gray-900">{value ?? "—"}</div>
    </div>
  );
}

function BillRow({
  label,
  gross,
  gstPct,
  gstAmt,
  net,
  qty,
}: {
  label: string;
  gross?: string | null;
  gstPct?: string | null;
  gstAmt?: string | null;
  net?: string | null;
  qty: number;
}) {
  const fmt = (v: string | null | undefined) =>
    `₹${Number(v ?? 0).toLocaleString("en-IN")}`;
  const pct = (v: string | null | undefined) => {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n) || n === 0) return "0%";
    return `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
  };
  const lineNet = Number(net ?? 0) * qty;
  return (
    <tr className="border-t border-gray-100">
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmt(gross)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{pct(gstPct)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmt(gstAmt)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{qty}</td>
      <td className="px-3 py-2 text-right tabular-nums font-bold">
        ₹{lineNet.toLocaleString("en-IN")}
      </td>
    </tr>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
      />
    </div>
  );
}

function NumberInput({ label, value, onChange, step = "1" }: { label: string; value: string; onChange: (v: string) => void; step?: string }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
      />
    </div>
  );
}
