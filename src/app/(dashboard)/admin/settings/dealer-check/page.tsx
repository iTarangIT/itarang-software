import { requireRole } from "@/lib/auth-utils";
import DealerCheckAlertsForm from "./DealerCheckAlertsForm";

export const dynamic = "force-dynamic";

// 23 Nov (point 4) — who is told when a file reaches the dealer check.
export default async function DealerCheckAlertsPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1000px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dealer check alerts</h1>
        <p className="mt-1 text-sm text-ink-muted">
          When a customer file reaches the <strong>dealer check</strong>, everyone below gets an email and a WhatsApp
          message with their own link to <strong>approve, reject or change the dealer</strong>. The first person to act
          decides; everyone else is then told <em>&ldquo;Action taken by &lt;name&gt;&rdquo;</em> and their link stops
          working. The decision is recorded against that person on the file&rsquo;s KYC history. Dealers and customers
          never see the name.
        </p>
      </header>
      <DealerCheckAlertsForm />
    </div>
  );
}
