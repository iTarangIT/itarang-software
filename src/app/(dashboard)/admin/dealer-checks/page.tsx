import { requireRole } from "@/lib/auth-utils";
import DealerChecks from "./DealerChecks";

export const dynamic = "force-dynamic";

// E-390 — Battery Pool diagram 1: the iTarang Admin checks the dealer an
// "uncertain" application was tagged to before it can go to a lender.
export default async function DealerChecksPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dealer checks</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Applications whose dealer was picked by an iTarang salesperson, assigned by iTarang House, or created by a
          dealer&apos;s sales team. Approve the dealer, change it, or reject it with a reason. Until it is approved the
          file cannot be sent to a lender; KYC and consent carry on meanwhile.
        </p>
      </header>
      <DealerChecks />
    </div>
  );
}
