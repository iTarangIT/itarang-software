import { requireRole } from "@/lib/auth-utils";
import HouseTeamLogins from "./HouseTeamLogins";

export const dynamic = "force-dynamic";

// ID 182: one login per iTarang team member under the house dealer, so every
// push and every step on a customer file is recorded under the person — not
// the shared dealer@itarang.com. Admin and Sales Head.
export default async function HouseTeamLoginsPage() {
  await requireRole(["admin", "sales_head"]);
  return (
    <div className="px-6 md:px-8 py-6 space-y-5 max-w-[1100px]">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">House team logins</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Give each iTarang team member their own login under the iTarang house dealer. They sign in to the dealer
          portal like the shared house login, and every push or step they take is recorded with their own name.
        </p>
      </header>
      <HouseTeamLogins />
    </div>
  );
}
