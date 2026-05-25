"use client";

import type { CaseIdentity } from "./types";

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-[color:var(--color-ink)] break-all">
        {value ?? "—"}
      </p>
    </div>
  );
}

export function IdentityCards({ identity }: { identity: CaseIdentity }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Card label="Customer" value={identity.customer} />
      <Card label="Dealer" value={identity.dealer} />
      <Card label="Loan ID" value={identity.loan_id} />
      <Card
        label="Outstanding"
        value={
          identity.outstanding != null
            ? `₹${identity.outstanding.toLocaleString("en-IN")}`
            : null
        }
      />
      <Card
        label="Loan start"
        value={
          identity.loan_start
            ? new Date(identity.loan_start).toLocaleDateString("en-IN")
            : null
        }
      />
      <Card
        label="Tenure"
        value={
          identity.tenure_months != null
            ? `${identity.tenure_months} months`
            : null
        }
      />
      <Card label="Phone" value={identity.phone} />
      <Card label="IMEI" value={identity.imei} />
    </div>
  );
}

export default IdentityCards;
