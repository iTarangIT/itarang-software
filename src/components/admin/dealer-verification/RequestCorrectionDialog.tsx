"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock3, FileText, ListChecks, Loader2, X } from "lucide-react";
import {
  CORRECTION_DOCUMENTS,
  CORRECTION_FIELDS,
  type CorrectionDocument,
  type CorrectionField,
} from "@/lib/onboarding/correction-catalog";

type Props = {
  open: boolean;
  onClose: () => void;
  dealerId: string;
  companyName?: string;
  onRequested: () => void;
};

const FIELD_GROUPS: Array<{
  id: CorrectionField["group"];
  label: string;
}> = [
  { id: "company",        label: "Company details" },
  { id: "owner",          label: "Owner details" },
  { id: "bank",           label: "Bank account" },
  { id: "sales_manager",  label: "Sales manager" },
];

const DOCUMENT_GROUPS: Array<{
  id: CorrectionDocument["group"];
  label: string;
}> = [
  { id: "company",     label: "Company documents" },
  { id: "compliance",  label: "Compliance documents" },
  { id: "ownership",   label: "Ownership documents" },
];

export default function RequestCorrectionDialog({
  open,
  onClose,
  dealerId,
  companyName,
  onRequested,
}: Props) {
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [remarks, setRemarks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedFields(new Set());
      setSelectedDocs(new Set());
      setRemarks("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const fieldsByGroup = useMemo(() => {
    const map = new Map<string, CorrectionField[]>();
    for (const f of CORRECTION_FIELDS) {
      const list = map.get(f.group) ?? [];
      list.push(f);
      map.set(f.group, list);
    }
    return map;
  }, []);

  const docsByGroup = useMemo(() => {
    const map = new Map<string, CorrectionDocument[]>();
    for (const d of CORRECTION_DOCUMENTS) {
      const list = map.get(d.group) ?? [];
      list.push(d);
      map.set(d.group, list);
    }
    return map;
  }, []);

  const toggleField = (key: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleDoc = (key: string) => {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const totalSelected = selectedFields.size + selectedDocs.size;
  const canSubmit = totalSelected > 0 && remarks.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/dealer-verifications/${dealerId}/request-correction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            remarks: remarks.trim(),
            requestedFields: Array.from(selectedFields),
            requestedDocuments: Array.from(selectedDocs),
          }),
        },
      );
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !json?.success) {
        setError(json?.message || `Request failed (HTTP ${res.status})`);
        return;
      }
      onRequested();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-8 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-[#E3E8EF] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#E3E8EF] px-6 py-5">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
              <Clock3 className="h-3.5 w-3.5" />
              Correction round
            </div>
            <h2 className="mt-2 text-lg font-semibold text-[#173F63]">
              Request correction from dealer
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Pick the items the dealer must update.{" "}
              {companyName ? <span className="font-medium text-slate-700">{companyName}</span> : null}{" "}
              will receive an email with a secure link to a focused form.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-[#E3E8EF] p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Documents */}
            <section className="rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4">
              <div className="mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-[#1F5C8F]" />
                <h3 className="text-sm font-semibold text-[#173F63]">
                  Documents to re-upload
                </h3>
                <span className="ml-auto text-xs font-medium text-slate-500">
                  {selectedDocs.size} selected
                </span>
              </div>
              <div className="space-y-4">
                {DOCUMENT_GROUPS.map((group) => {
                  const list = docsByGroup.get(group.id) ?? [];
                  if (list.length === 0) return null;
                  return (
                    <div key={group.id}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {group.label}
                      </p>
                      <div className="space-y-1.5">
                        {list.map((doc) => (
                          <label
                            key={doc.key}
                            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${
                              selectedDocs.has(doc.key)
                                ? "border-[#1F5C8F]/40 bg-blue-50 text-[#173F63]"
                                : "border-transparent bg-white text-slate-700 hover:border-[#E3E8EF]"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-300 text-[#1F5C8F] focus:ring-[#1F5C8F]"
                              checked={selectedDocs.has(doc.key)}
                              onChange={() => toggleDoc(doc.key)}
                            />
                            <span className="font-medium">{doc.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Fields */}
            <section className="rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4">
              <div className="mb-3 flex items-center gap-2">
                <ListChecks className="h-4 w-4 text-[#1F5C8F]" />
                <h3 className="text-sm font-semibold text-[#173F63]">
                  Information to update
                </h3>
                <span className="ml-auto text-xs font-medium text-slate-500">
                  {selectedFields.size} selected
                </span>
              </div>
              <div className="space-y-4">
                {FIELD_GROUPS.map((group) => {
                  const list = fieldsByGroup.get(group.id) ?? [];
                  if (list.length === 0) return null;
                  return (
                    <div key={group.id}>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {group.label}
                      </p>
                      <div className="space-y-1.5">
                        {list.map((field) => (
                          <label
                            key={field.key}
                            className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${
                              selectedFields.has(field.key)
                                ? "border-[#1F5C8F]/40 bg-blue-50 text-[#173F63]"
                                : "border-transparent bg-white text-slate-700 hover:border-[#E3E8EF]"
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-300 text-[#1F5C8F] focus:ring-[#1F5C8F]"
                              checked={selectedFields.has(field.key)}
                              onChange={() => toggleField(field.key)}
                            />
                            <span className="font-medium">{field.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Remarks */}
          <section className="mt-5 rounded-2xl border border-[#E3E8EF] bg-white p-4">
            <label className="block text-sm font-semibold text-[#173F63]">
              Reviewer remarks
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Tell the dealer what's wrong and how to fix it. The dealer sees
              this verbatim on the correction form and in the email.
            </p>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="e.g. The PAN card image is blurry — please re-upload a clearer scan. Update the GST number to match the certificate."
              className="mt-3 min-h-[120px] w-full rounded-2xl border border-[#E3E8EF] bg-white p-3 text-sm text-slate-900 outline-none transition focus:border-[#1F5C8F]"
            />
          </section>

          {error ? (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-[#E3E8EF] bg-[#F9FBFD] px-6 py-4">
          <p className="text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{totalSelected}</span> item
            {totalSelected === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-2xl border border-[#E3E8EF] bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-2xl bg-amber-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clock3 className="h-4 w-4" />
              )}
              Send correction request
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
