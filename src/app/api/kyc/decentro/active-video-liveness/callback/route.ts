// Public, UN-authenticated callback for Decentro Active Video Liveness.
// Decentro POSTs here (server-to-server) after the customer completes the
// liveness session. We match the inbound payload to the originating
// kyc_verifications row by `decentroTxnId` and flip the row's status to
// `admin_review_pending` so the dealer's status poll picks up next tick
// and the result is fetched via /v2/.../:decentroTxnId.
//
// Decentro does not document an HMAC signature on this product, and our
// DigiLocker callback (a sibling Decentro flow) uses the same no-signature
// approach — we authenticate by the decentroTxnId having to match a row we
// previously created. That ID is opaque and not enumerable.
//
// Decentro may also browser-redirect the customer to /return (sibling route)
// once they finish, but that's a separate UX-only path and is NOT the source
// of truth. This server-to-server callback is.

import { NextRequest, NextResponse } from 'next/server';
import { desc, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';

async function processCallback(decentroTxnId: string | null, status: string | null) {
    if (!decentroTxnId) {
        return { ok: false, code: 400, message: 'Missing decentroTxnId' };
    }

    const rows = await db
        .select()
        .from(kycVerifications)
        .where(sql`${kycVerifications.api_response}->>'decentro_txn_id' = ${decentroTxnId}`)
        .orderBy(desc(kycVerifications.updated_at))
        .limit(1);

    const row = rows[0];
    if (!row) {
        // Unknown txn id — most likely a stale callback for a deleted lead.
        // Return 200 OK so Decentro doesn't retry endlessly, but log.
        console.warn('[Active VKYC callback] No row for decentroTxnId:', decentroTxnId);
        return { ok: true, code: 200, message: 'No matching session' };
    }

    const now = new Date();
    const ar = (row.api_response ?? {}) as Record<string, unknown>;

    await db
        .update(kycVerifications)
        .set({
            // status: 'admin_review_pending' marks the row as ready for the
            // /status route to fetch results from Decentro on the next dealer
            // poll tick. If Decentro reports an explicit FAILURE on the
            // callback itself, we still let the /status fetch resolve the
            // detailed reason from the result payload.
            status: 'admin_review_pending',
            api_response: {
                ...ar,
                callback_received_at: now.toISOString(),
                callback_status: status ?? null,
            } as unknown as Record<string, unknown>,
            updated_at: now,
        })
        .where(sql`${kycVerifications.id} = ${row.id}`);

    return { ok: true, code: 200, message: 'Accepted' };
}

export async function POST(req: NextRequest) {
    try {
        // Decentro might send the txn id either in the JSON body or as a
        // query string — accept both shapes. Sample payload shape per the
        // docs typically includes `decentroTxnId` + `status`.
        const url = new URL(req.url);
        const qTxn = url.searchParams.get('decentroTxnId') || url.searchParams.get('decentro_txn_id');
        const qStatus = url.searchParams.get('status');

        let body: Record<string, unknown> = {};
        try {
            body = (await req.json()) as Record<string, unknown>;
        } catch {
            // Body might be form-encoded or empty — fall through to query.
            body = {};
        }

        const decentroTxnId =
            (typeof body.decentroTxnId === 'string' && body.decentroTxnId) ||
            (typeof body.decentro_txn_id === 'string' && body.decentro_txn_id) ||
            qTxn ||
            null;
        const status =
            (typeof body.status === 'string' && body.status) ||
            (typeof body.responseStatus === 'string' && body.responseStatus) ||
            qStatus ||
            null;

        console.log('[Active VKYC callback POST]', { decentroTxnId, status });

        const result = await processCallback(decentroTxnId, status);
        return new NextResponse(result.message, {
            status: result.code,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    } catch (error) {
        console.error('[Active VKYC callback POST] Error:', error);
        // Still return 200 so Decentro doesn't retry — surface the issue in logs.
        return new NextResponse('Internal error logged', { status: 200 });
    }
}

// Some providers ping the callback URL with a GET (sanity check) before
// committing to using it for POSTs. Honour it cheaply.
export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const decentroTxnId = url.searchParams.get('decentroTxnId') || url.searchParams.get('decentro_txn_id');
    const status = url.searchParams.get('status');
    if (decentroTxnId) {
        const result = await processCallback(decentroTxnId, status);
        return new NextResponse(result.message, {
            status: result.code,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
    return new NextResponse('Active Video Liveness callback endpoint', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}
