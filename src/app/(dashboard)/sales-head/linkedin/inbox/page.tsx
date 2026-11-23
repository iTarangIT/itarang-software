import { InboxView } from "@/components/linkedin/InboxView";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireRole([...LINKEDIN_ROLES]);
  return <InboxView />;
}
