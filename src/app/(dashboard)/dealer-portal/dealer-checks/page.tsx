import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth-utils";
import DealerChecks from "@/components/leads/DealerChecks";
import { mayViewHouseDealerChecks } from "@/lib/leads/dealer-assignment";

export const dynamic = "force-dynamic";

// E-390 — Battery Pool diagram 1, 20 Nov: the iTarang House dealer login
// approves, changes or rejects the dealer a sales person tagged a file to.
// After approve / change the file goes to the Admin / Sales Head KYC review.
// Only the main dealer@itarang.com login decides; house team logins see it
// view only. Other dealers are sent back to their leads.
export default async function HouseDealerChecksPage() {
  const user = await requireRole(["dealer"]);
  if (!(await mayViewHouseDealerChecks(user))) redirect("/dealer-portal/leads");
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dealer checks</h1>
        <p className="mt-1 text-sm text-gray-600">
          Files a sales person (CRM or WhatsApp) sent under a dealer. Approve the dealer, change it, or reject it with a
          reason. Approved or changed files go to the iTarang Admin / Sales Head for KYC review; a rejected file goes
          back to the sales person to pick the dealer again. Only the main iTarang House login (dealer@itarang.com)
          can decide.
        </p>
      </header>
      <DealerChecks mode="house" />
    </div>
  );
}
