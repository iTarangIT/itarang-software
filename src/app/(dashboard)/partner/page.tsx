import { requireRole } from "@/lib/auth-utils";
import { PartnerDashboard } from "./_components/PartnerDashboard";

export const dynamic = "force-dynamic";

// The partner's landing page. Composed from endpoints that already exist for
// the three surfaces it fronts — the inside-sales queue counts, the buyback
// notification summary, and the partner's own quotation list — rather than a
// fourth dashboard API that would restate them.
export default async function PartnerDashboardPage() {
    const user = await requireRole(["partner", "admin", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-6 max-w-[1600px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                    Partner Dashboard
                </h1>
                <p className="mt-1 text-sm text-gray-600">
                    Welcome, {user.name}. Your leads, your quotations, and the battery buyback desk in one place.
                </p>
            </header>
            <PartnerDashboard />
        </div>
    );
}
