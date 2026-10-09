import { Suspense } from "react";
import { requireRole } from "@/lib/auth-utils";
import { REPORTS_PAGE_ROLES } from "@/lib/auth/staffPageRoles";
import { SalesHeadReports } from "@/components/reports/redesign/SalesHeadReports";

export const dynamic = "force-dynamic";

// ID 91 — Reports › Analyses, Data downloads and Scheduled email reports for
// the CEO, Admin and Sales Head (the redesign board's REPORTS menu). The same
// screen as /sales-head/reports, outside any one role's prefix so all three
// reach it. ?section= picks the tab, ?analysis= the analysis.
export default async function ReportsPage() {
    await requireRole([...REPORTS_PAGE_ROLES]);
    return (
        <Suspense fallback={null}>
            <SalesHeadReports />
        </Suspense>
    );
}
