/**
 * E-071 — /admin/nbfc/audit-log page (BRD §6.3.5).
 *
 * Admin Audit Log query view. Mounts the AuditLogTable client component
 * which fetches /api/audit-log with the active filter set. Route protection
 * comes from `src/middleware.ts` (gates `/admin/*` to admin-grade roles).
 */
import AuditLogTable from "@/components/admin/nbfc/AuditLogTable";

export const dynamic = "force-dynamic";

export default function AuditLogPage() {
  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">
        Admin Audit Log
      </h1>
      <p className="mb-4 text-sm text-gray-600">
        Immutable, timestamped record of every privileged action across the
        platform. No record can be deleted or edited.
      </p>
      <AuditLogTable />
    </main>
  );
}
