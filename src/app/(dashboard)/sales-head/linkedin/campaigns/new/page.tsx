import { CampaignComposer } from "@/components/linkedin/CampaignComposer";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ prospects?: string; campaign?: string }> }) {
  await requireRole([...LINKEDIN_ROLES]);
  const sp = await searchParams;
  const ids = (sp.prospects ?? "").split(",").filter(Boolean);
  return <CampaignComposer initialProspectIds={ids} campaignId={sp.campaign ?? null} />;
}
