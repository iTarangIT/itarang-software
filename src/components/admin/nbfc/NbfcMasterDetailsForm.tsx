"use client";

import { useState } from "react";

type Mode = "create" | "edit";

export interface NbfcMasterDetailsFormProps {
  mode: Mode;
  nbfcId?: string;
  initial?: Record<string, unknown>;
}

// Minimal form component to satisfy E-003's surface.components contract.
// Full form layout is covered by E-005 (compliance docs) + E-011 (lifecycle).
// Here we render the 18 BRD fields as plain HTML and POST/PATCH the JSON.
export default function NbfcMasterDetailsForm({
  mode,
  nbfcId,
  initial,
}: NbfcMasterDetailsFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: number; nbfcId: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      legalName: String(fd.get("legalName") || ""),
      shortName: String(fd.get("shortName") || ""),
      rbiRegistrationNo: String(fd.get("rbiRegistrationNo") || ""),
      cin: String(fd.get("cin") || ""),
      gstNumber: String(fd.get("gstNumber") || ""),
      panNumber: String(fd.get("panNumber") || ""),
      nbfcType: String(fd.get("nbfcType") || ""),
      registeredAddress: {
        line1: String(fd.get("addr_line1") || ""),
        line2: String(fd.get("addr_line2") || ""),
        city: String(fd.get("addr_city") || ""),
        district: String(fd.get("addr_district") || ""),
        state: String(fd.get("addr_state") || ""),
        pin: String(fd.get("addr_pin") || ""),
      },
      primaryContactName: String(fd.get("primaryContactName") || ""),
      primaryContactEmail: String(fd.get("primaryContactEmail") || ""),
      primaryContactPhone: String(fd.get("primaryContactPhone") || ""),
      grievanceOfficerName: String(fd.get("grievanceOfficerName") || ""),
      grievanceHelpline: String(fd.get("grievanceHelpline") || ""),
      grievanceUrl: String(fd.get("grievanceUrl") || ""),
      nodalOfficer: String(fd.get("nodalOfficer") || ""),
      partnershipDate: String(fd.get("partnershipDate") || ""),
      fldgTerms: String(fd.get("fldgTerms") || ""),
      activeGeographies: String(fd.get("activeGeographies") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    const url =
      mode === "create" ? "/api/admin/nbfc" : `/api/admin/nbfc/${nbfcId}`;
    const method = mode === "create" ? "POST" : "PATCH";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok || !j.success) {
      setError(j.error || `Request failed (${res.status})`);
      return;
    }
    if (mode === "create") {
      setDone({ id: j.id, nbfcId: j.nbfcId });
    }
  }

  if (done) {
    return (
      <div className="p-4 border rounded">
        <div>NBFC created.</div>
        <div data-testid="nbfc-id">{done.nbfcId}</div>
        <div data-testid="nbfc-pk">{done.id}</div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-4">
      <input name="legalName" placeholder="Legal name" defaultValue={(initial?.legalName as string) || ""} required />
      <input name="shortName" placeholder="Short name" required />
      <input name="rbiRegistrationNo" placeholder="N-XX.XXXXX.XX.XX.XXXX.XXXXX.XX" required />
      <input name="cin" placeholder="CIN" required />
      <input name="gstNumber" placeholder="GST" required />
      <input name="panNumber" placeholder="PAN" required />
      <select name="nbfcType" required defaultValue="nbfc_icc">
        <option value="nbfc_icc">NBFC-ICC</option>
        <option value="nbfc_mfi">NBFC-MFI</option>
        <option value="nbfc_factor">NBFC-Factor</option>
        <option value="hfc">HFC</option>
        <option value="scheduled_bank">Scheduled Commercial Bank</option>
        <option value="cooperative_bank">Cooperative Bank</option>
        <option value="other">Other</option>
      </select>
      <input name="addr_line1" placeholder="Address line 1" required />
      <input name="addr_line2" placeholder="Address line 2" />
      <input name="addr_city" placeholder="City" required />
      <input name="addr_district" placeholder="District" required />
      <input name="addr_state" placeholder="State" required />
      <input name="addr_pin" placeholder="6-digit PIN" required />
      <input name="primaryContactName" placeholder="Primary contact name" required />
      <input name="primaryContactEmail" type="email" placeholder="Primary contact email" required />
      <input name="primaryContactPhone" placeholder="Primary contact phone (10 digits)" required />
      <input name="grievanceOfficerName" placeholder="Grievance officer name" required />
      <input name="grievanceHelpline" placeholder="Grievance helpline" required />
      <input name="grievanceUrl" placeholder="Grievance redressal URL" required />
      <input name="nodalOfficer" placeholder="Nodal officer (optional)" />
      <input name="partnershipDate" type="date" required />
      <textarea name="fldgTerms" placeholder="FLDG / Guarantee terms (optional)" />
      <input name="activeGeographies" placeholder="Active geographies (comma separated states)" required />
      <button type="submit" disabled={submitting}>{submitting ? "Saving…" : mode === "create" ? "Create NBFC" : "Save changes"}</button>
      {error && <div role="alert" className="text-red-600">{error}</div>}
    </form>
  );
}
