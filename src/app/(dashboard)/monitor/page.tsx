import { MonitorDashboard } from "@/components/monitor/MonitorDashboard";

// The page is a live view of a database that changes every poll cycle; a cached
// render would show a stale fleet with a fresh "updated just now" beside it.
export const dynamic = "force-dynamic";

export const metadata = {
    title: "Fleet Monitor | iTarang",
};

export default function MonitorPage() {
    return <MonitorDashboard />;
}
