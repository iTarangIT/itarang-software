import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkCronAuth } from "@/lib/cron-auth";
import { runAsJob } from "@/lib/runtime/liveSite";
import { runDispatchToSold } from "@/lib/sales/dispatchToSold";

// BRD V2 §3.5 — finalise any lead stuck in 'dispatched' once the configurable
// delay (default 1 day) has passed since its inventory was dispatched. Mirrors
// the manual /mark-delivered logic. The logic lives in lib/sales/dispatchToSold;
// on the live server it runs from the in-process daily ticker (ID 220), since
// vercel.json crons do not fire there. This route stays for a manual run.
//
// Auth: Bearer ${CRON_SECRET}, in every environment (ID 130).
// ?dry_run=1 lists the leads that would move without changing anything.

export const GET = withErrorHandler((req: Request) =>
  runAsJob("cron:dispatch-to-sold", async () => {
    const unauth = checkCronAuth(req);
    if (unauth) return unauth;
    const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
    const r = await runDispatchToSold({ dryRun });
    return successResponse({ count: r.leadsProcessed.length, ...r });
  }),
);
