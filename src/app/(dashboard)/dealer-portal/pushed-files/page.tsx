import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth-utils";
import PushedFilesList from "@/components/leads/PushedFilesList";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { isHouseLogin } from "@/lib/leads/pushToDealer";

export const dynamic = "force-dynamic";

// ID 183 Phase 1: the iTarang house logins' "Pushed files" — the files the
// house pushed to dealers (they are the dealer's now and no longer on the
// house's own lead list or counts). Other dealers are sent back to their leads.
export default async function HousePushedFilesPage() {
  const user = await requireRole(["dealer"]);
  if (!isHouseLogin({ role: user.role, dealerId: user.dealer_id, houseDealerCode: await houseDealerCode() })) {
    redirect("/dealer-portal/leads");
  }
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pushed files</h1>
        <p className="mt-1 text-sm text-gray-600">
          Files iTarang pushed to a dealer, until disbursed or closed. Each file belongs to its dealer; dispatch (Step 5)
          is the dealer&apos;s alone.
        </p>
      </header>
      <PushedFilesList hrefFor="dealer" />
    </div>
  );
}
