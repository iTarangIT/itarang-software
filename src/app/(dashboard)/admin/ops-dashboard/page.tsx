import { redirect } from "next/navigation";

// Tracker ID 88 — the old Operations Dashboard (BRD §0.11) is retired. /admin
// is the Sales dashboard (SalesHeadOpsView), the one screen Admin, Sales Head
// and CEO share; an old bookmark to this route lands there. The APIs the old
// screen read are kept: other screens still use them.
export default function OldOperationsDashboardPage() {
    redirect("/admin");
}
