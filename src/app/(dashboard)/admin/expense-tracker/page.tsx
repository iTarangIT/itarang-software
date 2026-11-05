import { InfoTip } from "@/components/ui/info-tip";
import { requireRole } from "@/lib/auth-utils";
import { EXPENSE_ADMIN_ROLES } from "@/lib/auth/requireApiAdmin";
import { ExpenseTrackerView } from "./_components/ExpenseTrackerView";

export const dynamic = "force-dynamic";

// E-106 — AI invoice expense tracker. Admin-only: upload an invoice, AI extracts
// and classifies it, admin reviews + submits, and the amount flows to the CEO
// dashboard expenses total + department/project breakdown.
export default async function AdminExpenseTrackerPage() {
  // ID 166 (18 Oct): Finance and the CEO too — the same list as the API.
  await requireRole([...EXPENSE_ADMIN_ROLES]);

  return (
    <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          AI Expense Tracker
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a vendor invoice or receipt; check what AI read, then submit.
          <InfoTip className="ml-1">
            {"AI reads the amount, vendor and date and suggests a department and project tag. Review, correct, and submit; submitted expenses show on the CEO dashboard at once."}
          </InfoTip>
        </p>
      </header>
      <ExpenseTrackerView />
    </div>
  );
}
