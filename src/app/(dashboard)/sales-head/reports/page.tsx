import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { SalesHeadReports } from "@/components/reports/redesign/SalesHeadReports";

export const dynamic = "force-dynamic";

// Sales Head › Reports: Analyses, Data downloads and Scheduled email reports
// (design board "Reports · Analyses, data downloads, scheduled emails").
// /admin/reports stays as it was for the other roles.
export default async function SalesHeadReportsPage() {
    await requireRole(["sales_head", "ceo"]);
    return (
        <Suspense fallback={null}>
            <SalesHeadReports />
        </Suspense>
    );
}
