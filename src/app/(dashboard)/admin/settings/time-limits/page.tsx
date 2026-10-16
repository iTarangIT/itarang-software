import { requireAuth } from "@/lib/auth-utils";
import { TimeLimitsView } from "../_components/TimeLimitsView";

export const dynamic = "force-dynamic";

// ID 85 — every lead-module time limit, dated, with its change log, and the
// office calendar the working days and hours are counted on. Admin edits;
// the CEO sees the same page read-only (decided 10 Oct: "Admin only; every
// change logged; the CEO sees the log").
export default async function TimeLimitsPage() {
    // A plain message for other roles instead of requireRole's throw, which
    // rendered as an "Application error" screen.
    const user = await requireAuth();
    if (user.role !== "admin" && user.role !== "ceo") {
        return (
            <div className="px-6 md:px-8 py-6">
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Time limits</h1>
                <p className="mt-2 text-sm text-ink-muted">Only Admin and the CEO can open this page.</p>
            </div>
        );
    }

    return (
        <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Time limits</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    How long a lead may wait at each step before it is flagged. A change takes effect on the day you
                    choose; earlier days keep the limit they had. Working days are Monday to Saturday and working
                    hours 10:00 to 19:00, minus the holidays below.
                </p>
            </header>
            <TimeLimitsView />
        </div>
    );
}
