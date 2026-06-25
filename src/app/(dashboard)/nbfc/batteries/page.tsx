/**
 * /nbfc/batteries — Battery Monitoring (BRD §6.2).
 *
 * Thin wrapper over the shared `BatteryMonitoringView` (also used by the Risk
 * Head dashboard). The view does the tenant-scoped fleet query + render; this
 * page just fixes the base path for filter/reset links to `/nbfc/batteries`.
 */
import BatteryMonitoringView, {
  type BatteryMonitoringSearchParams,
} from "@/components/nbfc-portal/BatteryMonitoringView";

export const dynamic = "force-dynamic";

export default function BatteriesPage({
  searchParams,
}: {
  searchParams: Promise<BatteryMonitoringSearchParams>;
}) {
  return (
    <BatteryMonitoringView searchParams={searchParams} basePath="/nbfc/batteries" />
  );
}
