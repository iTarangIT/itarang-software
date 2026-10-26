import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireRole } from "@/lib/auth-utils";
import { NEODOVE_MANAGE_ROLES } from "@/lib/neodove/roles";
import NeodoveTeamLogins from "./NeodoveTeamLogins";

export const dynamic = "force-dynamic";

// NeoDove → Team logins (26 Oct). Admin / Sales Head create and switch off the
// Inside Sales Rep and ASM logins NeoDove leads are worked by, then link each
// person's NeoDove agent name on the Agents page — no developer needed.
export default async function NeodoveTeamLoginsPage() {
    await requireRole(NEODOVE_MANAGE_ROLES);
    return (
        <div className="max-w-5xl mx-auto py-8 px-6 min-h-screen bg-gray-50 space-y-5">
            <Link
                href="/leads/neodove-campaigns"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
                <ArrowLeft className="w-4 h-4" /> NeoDove campaigns
            </Link>
            <header>
                <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Team logins</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Create a CRM login for each person who calls NeoDove leads, then link their NeoDove agent name on{" "}
                    <Link href="/leads/neodove-campaigns/agents" className="font-medium text-gray-700 underline-offset-2 hover:underline">
                        Agents
                    </Link>
                    . From then on a lead&apos;s CRM owner is the person whose agent called it first.
                </p>
            </header>
            <NeodoveTeamLogins />
        </div>
    );
}
