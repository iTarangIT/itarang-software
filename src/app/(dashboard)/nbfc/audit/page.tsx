/**
 * /nbfc/audit — NBFC Portal Audit Log (BRD §6.3.5)
 *
 * Server component shell that resolves the tenant and hands off to the
 * client-rendered <AuditLogPage />. All filtering, pagination, and CSV
 * export are driven client-side against GET /api/nbfc/audit-log.
 */
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import AuditLogPage from "@/components/nbfc-portal/audit-log/AuditLogPage";

export const dynamic = "force-dynamic";

interface SearchParams {
  entityId?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  const params = (await searchParams) ?? {};

  return (
    <AuditLogPage
      tenantName={tenant.display_name}
      initialEntityId={params.entityId}
    />
  );
}
