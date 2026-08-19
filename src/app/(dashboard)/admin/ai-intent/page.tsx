import { requireRole } from "@/lib/auth-utils";
import { INTENT_CURATOR_ROLES } from "@/lib/leads/access";
import { IntentLearningConsole } from "./_components/IntentLearningConsole";

export const dynamic = "force-dynamic";

// "Teach the AI" — where corrections become instructions.
//
// Lives under /admin because middleware already admits exactly the right
// audience there (sharedRouteAccess["/admin"] = admin, sales_head, ceo), which
// is the same set as INTENT_CURATOR_ROLES. No middleware change was needed;
// adding a role to INTENT_CURATOR_ROLES that middleware bounces would render a
// console its holder can never open, which is why that list documents the
// constraint.
export default async function AiIntentLearningPage() {
  const user = await requireRole([...INTENT_CURATOR_ROLES]);

  return (
    <div className="px-4 sm:px-6 md:px-8 py-6 space-y-6 max-w-[1400px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          AI Intent Learning
        </h1>
        <p className="mt-1 text-sm text-gray-600 max-w-3xl">
          Welcome, {user.name}. Every band a reviewer corrects is recorded here.
          Promote the most instructive ones and the scoring model reads them on
          every call from then on — no deploy, and reversible at any time.
        </p>
      </header>

      <IntentLearningConsole />
    </div>
  );
}
