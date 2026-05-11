/**
 * /loop-test/borrower-notice-preview — worktree-local fixture for E-033.
 *
 * Mounts <BorrowerNoticePreview/> on a public, middleware-unprotected path
 * so the loop's Playwright UI test can render the component without a real
 * Supabase session. Gated behind NODE_ENV !== 'production' (returns 404 in
 * production) — must never be reachable in prod.
 */
import { notFound } from "next/navigation";
import BorrowerNoticePreview from "@/components/nbfc-portal/BorrowerNoticePreview";

export const dynamic = "force-dynamic";

export default function BorrowerNoticePreviewFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">
        E-033 borrower notice preview fixture
      </h1>
      <BorrowerNoticePreview
        notice={{
          lender_legal_name: "Acme NBFC Limited",
          outstanding_amount: 18500,
          restoration_steps:
            "Settle the outstanding EMI via UPI. Battery is re-mobilised within 2-4 hours of settlement reference.",
          grievance_url: "https://acme-nbfc.example.com/grievance",
          helpline: "1800-200-3300",
        }}
      />
    </div>
  );
}
