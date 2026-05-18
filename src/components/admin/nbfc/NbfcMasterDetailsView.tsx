"use client";

/**
 * Read-only display of the NBFC's Step 1 master details for the CEO's
 * review page. The CEO needs to see what the Admin filled before deciding
 * to verify documents — without this card the CEO was only ever shown
 * the file uploads, not the legal entity behind them.
 *
 * E-111 — each field now renders an inline FlagButton from the correction-
 * flag context, so the CEO can flag specific fields for the admin to fix.
 */

import NbfcFlagButton from "./NbfcFlagButton";
import type { MasterFieldKey } from "@/lib/nbfc/admin/correction-catalog";

type AddressShape = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
};

export interface NbfcMasterDetailsViewProps {
  nbfc: {
    nbfcId: string;
    legalName: string;
    shortName: string;
    rbiRegistrationNo: string;
    cin: string;
    gstNumber: string;
    panNumber: string;
    nbfcType: string;
    registeredAddress: unknown;
    activeGeographies: unknown;
    primaryContactName: string;
    primaryContactEmail: string;
    primaryContactPhone: string;
    grievanceOfficerName: string;
    grievanceHelpline: string;
    grievanceUrl: string;
    nodalOfficer: string | null;
    partnershipDate: string | null;
    fldgTerms: string | null;
    corExpiryDate: string | null;
  };
}

function formatAddress(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "—";
  const a = raw as AddressShape;
  const parts = [a.line1, a.line2, a.city, a.state, a.pincode, a.country]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

function formatGeographies(raw: unknown): string {
  if (!Array.isArray(raw)) return "—";
  const items = raw.filter((g): g is string => typeof g === "string" && g.length > 0);
  return items.length ? items.join(", ") : "—";
}

function Field({
  label,
  value,
  mono,
  flagKey,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /** Master-field key in correction-catalog; omit to suppress the flag button. */
  flagKey?: MasterFieldKey;
}) {
  const display = value && value.length > 0 ? value : "—";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)]">
          {label}
        </p>
        {flagKey && (
          <NbfcFlagButton kind="master_field" targetKey={flagKey} />
        )}
      </div>
      <p
        className={`text-sm text-[color:var(--color-ink)] ${mono ? "font-mono text-[13px]" : ""}`}
      >
        {display}
      </p>
    </div>
  );
}

export default function NbfcMasterDetailsView({
  nbfc,
}: NbfcMasterDetailsViewProps) {
  return (
    <section className="card-iTarang p-6 md:p-7 space-y-5">
      <header className="space-y-1">
        <p className="section-label">Step 1 — Master Details</p>
        <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
          NBFC entity submitted by the Admin
        </h2>
        <p className="text-xs text-[color:var(--color-ink-muted)]">
          Review the legal entity before verifying compliance uploads. These
          values were submitted in Step 1 and are read-only here.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
        <Field label="Legal name" value={nbfc.legalName} flagKey="legal_name" />
        <Field label="Short name" value={nbfc.shortName} flagKey="short_name" />
        <Field label="NBFC ID" value={nbfc.nbfcId} mono />
        <Field
          label="RBI registration no."
          value={nbfc.rbiRegistrationNo}
          mono
          flagKey="rbi_registration_no"
        />
        <Field label="CIN" value={nbfc.cin} mono flagKey="cin" />
        <Field label="NBFC type" value={nbfc.nbfcType} flagKey="nbfc_type" />
        <Field
          label="GST number"
          value={nbfc.gstNumber}
          mono
          flagKey="gst_number"
        />
        <Field
          label="PAN number"
          value={nbfc.panNumber}
          mono
          flagKey="pan_number"
        />
        <Field
          label="Partnership date"
          value={nbfc.partnershipDate}
          flagKey="partnership_date"
        />
        <Field
          label="CoR expiry date"
          value={nbfc.corExpiryDate}
          flagKey="cor_expiry_date"
        />
      </div>

      <div className="border-t border-[color:var(--color-border)] pt-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        <Field
          label="Registered address"
          value={formatAddress(nbfc.registeredAddress)}
          flagKey="registered_address"
        />
        <Field
          label="Active geographies"
          value={formatGeographies(nbfc.activeGeographies)}
          flagKey="active_geographies"
        />
      </div>

      <div className="border-t border-[color:var(--color-border)] pt-4 space-y-3">
        <p className="section-label-muted">Primary contact</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
          <Field
            label="Name"
            value={nbfc.primaryContactName}
            flagKey="primary_contact_name"
          />
          <Field
            label="Email"
            value={nbfc.primaryContactEmail}
            flagKey="primary_contact_email"
          />
          <Field
            label="Phone"
            value={nbfc.primaryContactPhone}
            mono
            flagKey="primary_contact_phone"
          />
        </div>
      </div>

      <div className="border-t border-[color:var(--color-border)] pt-4 space-y-3">
        <p className="section-label-muted">Grievance redressal</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
          <Field
            label="Officer"
            value={nbfc.grievanceOfficerName}
            flagKey="grievance_officer_name"
          />
          <Field
            label="Helpline"
            value={nbfc.grievanceHelpline}
            flagKey="grievance_helpline"
          />
          <Field label="URL" value={nbfc.grievanceUrl} flagKey="grievance_url" />
          <Field
            label="Nodal officer"
            value={nbfc.nodalOfficer}
            flagKey="nodal_officer"
          />
        </div>
      </div>

      {nbfc.fldgTerms && (
        <div className="border-t border-[color:var(--color-border)] pt-4">
          <Field label="FLDG terms" value={nbfc.fldgTerms} />
        </div>
      )}
    </section>
  );
}
