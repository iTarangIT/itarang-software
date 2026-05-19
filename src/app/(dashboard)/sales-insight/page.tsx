import { requireRole } from "@/lib/auth-utils";
import { ConvertedInsightView } from "./_components/ConvertedInsightView";

export const dynamic = "force-dynamic";

export default async function SalesInsightDashboard() {
    const user = await requireRole([
        "sales_insight",
        "sales_manager",
        "sales_head",
        "business_head",
        "ceo",
    ]);

    return (
        <div className="p-8 space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Sales Insight</h1>
                <p className="text-muted-foreground">
                    Welcome back, {user.name}. Every converted lead across the AI dialer and B2B pipelines.
                </p>
            </div>
            <ConvertedInsightView />
        </div>
    );
}
