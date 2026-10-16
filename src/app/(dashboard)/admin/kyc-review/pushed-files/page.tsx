import { requireRole } from "@/lib/auth-utils";
import PushedFilesList from "@/components/leads/PushedFilesList";

export const dynamic = "force-dynamic";

// ID 183 Phase 1: the CRM "Pushed files" list for Admin and Sales Head. Open a
// file to act for its dealer (the "Act for dealer" panel on the file).
export default async function PushedFilesPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Pushed files</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Customer files iTarang pushed to a dealer, until the loan is disbursed or the file is closed. The dealer owns
          these files and they count under the dealer. Open one to act for the dealer.
        </p>
      </header>
      <PushedFilesList hrefFor="crm" />
    </div>
  );
}
