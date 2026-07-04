import { requireRole } from "@/lib/auth-utils";
import { ExpenseTrackerView } from "./_components/ExpenseTrackerView";

export const dynamic = "force-dynamic";

// E-106 — AI invoice expense tracker. Admin-only: upload an invoice, AI extracts
// and classifies it, admin reviews + submits, and the amount flows to the CEO
// dashboard expenses total + department/project breakdown.
export default async function AdminExpenseTrackerPage() {
  await requireRole(["admin", "sales_head"]);

  return (
    <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1200px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          AI Expense Tracker
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload a vendor invoice or receipt. AI extracts the amount, vendor and
          date and suggests a department + project tag — review, correct, and
          submit. Submitted expenses reflect immediately on the CEO dashboard.
        </p>
      </header>
      <ExpenseTrackerView />
    </div>
  );
}
