// Tracker ID 118 — who may call a cron route.
//
// Vercel sets `x-vercel-cron` on the requests its scheduler makes and strips it
// from anything arriving from outside, so ON VERCEL the header is proof. Off
// Vercel it is just a header: the sandbox and production run on a VPS behind
// nginx, where anyone can send `x-vercel-cron: 1` — and every cron route used
// to accept that as authorisation (EMI auto-debit, digests, Zoho sync, …).
//
// The VPS's own crontab calls these routes with `Authorization: Bearer
// $CRON_SECRET` (docs/DEPLOY_RUNBOOK.md), which each route checks itself, so
// nothing legitimate depends on the header there.

type HasHeaders = { headers: { get(name: string): string | null } };

/** True only for a request Vercel's own scheduler made. */
export function fromVercelCron(req: HasHeaders): boolean {
    return process.env.VERCEL === "1" && !!req.headers.get("x-vercel-cron");
}
