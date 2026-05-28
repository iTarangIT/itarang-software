import { requireRole } from "@/lib/auth-utils";
import { EscalationsView } from "./_components/EscalationsView";

export const dynamic = "force-dynamic";

// BRD §0.6 — admin escalation resolution queue. CEO sees it read-only
// (advisory only; resolution is admin-only).
export default async function AdminEscalationsPage() {
    const user = await requireRole(["admin", "sales_head", "ceo"]);

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1400px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">
                    Escalations
                </h1>
                <p className="mt-1 text-sm text-ink-muted">
                    {user.role === "ceo"
                        ? "Escalations raised by Inside Sales and ASM. Resolution is admin-only — CEO advises."
                        : "Resolve escalations — Reassign, Return with Guidance, or Mark No Action (BRD §0.6)."}
                </p>
            </header>
            <EscalationsView viewerRole={user.role} />
        </div>
    );
}
