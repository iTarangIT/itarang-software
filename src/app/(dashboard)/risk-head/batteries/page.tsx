/**
 * /risk-head/batteries — Battery Monitoring for the Risk Head.
 *
 * Same tenant-scoped fleet view the Risk Manager sees, so the Risk Head can
 * inspect a battery's telemetry and risk before deciding on an immobilisation
 * request. Filter/reset links stay on /risk-head/batteries.
 */
import BatteryMonitoringView, {
  type BatteryMonitoringSearchParams,
} from "@/components/nbfc-portal/BatteryMonitoringView";

export const dynamic = "force-dynamic";

export default function RiskHeadBatteriesPage({
  searchParams,
}: {
  searchParams: Promise<BatteryMonitoringSearchParams>;
}) {
  return (
    <BatteryMonitoringView
      searchParams={searchParams}
      basePath="/risk-head/batteries"
    />
  );
}
