import { EcofyListPage } from "@/components/ecofy/pages";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";

export const dynamic = "force-dynamic";

// E-307 — Ecofy pickup queue: S1 leads nobody owns yet. Hot first, then the
// longest waiting. Select and assign to an ASM or ISR.
export default function EcofyQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    return (
        <EcofyListPage
            roles={[...ECOFY_MANAGER_ROLES]}
            title="Ecofy — Pickup queue"
            subtitle="New leads pushed from Ecofy, not yet assigned. Select leads and assign them to an ASM or ISR."
            hrefBase="/sales-head/ecofy/leads"
            view="queue"
            searchParams={searchParams}
            emptyText="The pickup queue is empty."
        />
    );
}
