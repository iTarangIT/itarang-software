import { requireMonitorPage } from "@/lib/monitor/route-guard";

/**
 * The role gate lives here rather than on the page so a second page added under
 * /monitor later cannot ship unguarded — the same reasoning as
 * (dashboard)/operations/layout.tsx.
 *
 * There is no wrapper markup: LayoutWrapper skips its sidebar and header for
 * /monitor, and MonitorDashboard renders its own full-viewport chrome.
 */
export default async function MonitorLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    await requireMonitorPage();
    return <>{children}</>;
}
