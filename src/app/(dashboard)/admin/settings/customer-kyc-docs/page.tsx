import { requireRole } from "@/lib/auth-utils";
import CustomerKycDocsForm from "./CustomerKycDocsForm";

export const dynamic = "force-dynamic";

// E-392 — Battery Pool diagram 1, part 3: the sales head picks the customer
// (driver) KYC documents asked on WhatsApp and the CRM.
export default async function CustomerKycDocsPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[900px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Customer KYC documents</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Choose which documents the dealer, salesperson or customer is asked for on a finance application.{" "}
          <strong>Aadhaar (front and back), PAN and the mobile number are always mandatory.</strong> Every other document
          you turn on can be skipped — on WhatsApp with a Skip button, on the CRM with a Skip link — but only with a
          reason. The iTarang admin and the NBFC see every skipped document with its reason.
        </p>
      </header>
      <CustomerKycDocsForm />
    </div>
  );
}
