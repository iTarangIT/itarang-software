import { requireRole } from "@/lib/auth-utils";
import FileActionAlertsForm from "./FileActionAlertsForm";

export const dynamic = "force-dynamic";

// 27 Nov — which file action reaches whom, on which channel.
export default async function FileActionAlertsPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1300px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">File action alerts</h1>
        <p className="mt-1 text-sm text-ink-muted max-w-4xl">
          Choose who hears about each action on a customer file — by <strong>CRM bell</strong>,{" "}
          <strong>email</strong> and <strong>WhatsApp</strong>. The people involved are the person who did the action,
          the dealer, the salesperson who sent the file for the dealer, every Sales Head, and the NBFC partner with
          their child users. An action you have not customised keeps working as it does today.
        </p>
      </header>
      <FileActionAlertsForm />
    </div>
  );
}
