import { requireRole } from "@/lib/auth-utils";
import DealerChecks from "@/components/leads/DealerChecks";

export const dynamic = "force-dynamic";

// E-390 — Battery Pool diagram 1. Admin / Sales Head view of the dealer checks.
// 20 Nov: the iTarang House dealer login decides; a file comes to KYC review
// once the house approves or changes its dealer.
export default async function DealerChecksPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dealer checks</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Applications whose dealer was picked by an iTarang sales person, assigned by iTarang House, or created by a
          dealer&apos;s sales team. iTarang House approves, changes or rejects the dealer (from the house dealer login).
          Until then the file is not on KYC review and cannot go to a lender. This page is view only.
        </p>
      </header>
      <DealerChecks mode="admin" />
    </div>
  );
}
