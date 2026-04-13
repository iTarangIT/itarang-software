import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords, leads } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { fetchAndStoreSignedConsent } from '@/lib/digio/fetch-signed-consent';

type RouteContext = { params: Promise<{ leadId: string }> };

const WAITING_STATUSES = ['link_sent', 'link_opened', 'esign_in_progress'];

function cleanEnv(value?: string) {
    return (value || '').trim().replace(/^["']|["']$/g, '');
}

function basicAuthHeader(clientId: string, clientSecret: string) {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function fetchDigioDocument(baseUrl: string, auth: string, documentId: string) {
    const urls = [
        `${baseUrl}/v2/client/document/${encodeURIComponent(documentId)}`,
        `${baseUrl}/v2/client/document/status/${encodeURIComponent(documentId)}`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { Authorization: auth, Accept: 'application/json' },
                cache: 'no-store',
            });
            if (!res.ok) continue;
            const text = await res.text();
            if (!text) continue;
            return JSON.parse(text);
        } catch (e) {
            console.error('[Consent Sync] Digio fetch error:', e);
        }
    }
    return null;
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
    try {
        await requireRole(['dealer', 'admin', 'ceo', 'business_head', 'sales_head']);
        const { leadId } = await params;

        const [record] = await db
            .select()
            .from(consentRecords)
            .where(and(eq(consentRecords.lead_id, leadId), eq(consentRecords.consent_for, 'primary')))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (!record) {
            return NextResponse.json({ success: true, data: { synced: false, reason: 'no_record' } });
        }

        if (!WAITING_STATUSES.includes(record.consent_status)) {
            return NextResponse.json({ success: true, data: { synced: false, reason: 'not_waiting', consent_status: record.consent_status } });
        }

        if (!record.esign_transaction_id) {
            return NextResponse.json({ success: true, data: { synced: false, reason: 'no_transaction_id' } });
        }

        const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
        const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
        const baseUrl = cleanEnv(process.env.DIGIO_BASE_URL) || 'https://ext.digio.in:444';

        if (!clientId || !clientSecret) {
            return NextResponse.json({ success: false, error: { message: 'Digio credentials missing' } }, { status: 500 });
        }

        const auth = basicAuthHeader(clientId, clientSecret);
        const parsed = await fetchDigioDocument(baseUrl, auth, record.esign_transaction_id);

        if (!parsed) {
            return NextResponse.json({ success: true, data: { synced: false, reason: 'digio_fetch_failed' } });
        }

        const signingParties = Array.isArray(parsed?.signing_parties) ? parsed.signing_parties : [];
        const firstParty = signingParties[0] || {};
        const rawStatus = String(parsed?.agreement_status || parsed?.status || firstParty?.status || '').toLowerCase();

        const signedStatuses = ['signed', 'completed', 'executed', 'success'];
        const viewedStatuses = ['viewed'];
        const expiredStatuses = ['expired'];
        const failedStatuses = ['failed', 'rejected', 'declined', 'cancelled', 'error'];

        const now = new Date();
        let newStatus: string | null = null;
        const updates: any = { updated_at: now };

        if (signedStatuses.includes(rawStatus)) {
            newStatus = 'esign_completed';
            updates.consent_status = newStatus;
            updates.signed_at = now;
            updates.signer_aadhaar_masked = firstParty?.aadhaar_masked || firstParty?.signer_aadhaar || record.signer_aadhaar_masked;

            // Fetch signed PDF bytes from Digio and upload to Supabase storage.
            // This is the pull-based equivalent of the auto-upload branch in the Digio webhook.
            if (!record.signed_consent_url) {
                const stored = await fetchAndStoreSignedConsent(record.esign_transaction_id, leadId);
                if (stored?.publicUrl) {
                    updates.signed_consent_url = stored.publicUrl;
                }
            }
        } else if (viewedStatuses.includes(rawStatus)) {
            newStatus = 'link_opened';
            if (newStatus !== record.consent_status) updates.consent_status = newStatus;
        } else if (expiredStatuses.includes(rawStatus)) {
            newStatus = 'expired';
            updates.consent_status = newStatus;
        } else if (failedStatuses.includes(rawStatus)) {
            const retryCount = (record.esign_retry_count || 0) + 1;
            newStatus = retryCount >= 3 ? 'esign_blocked' : 'esign_failed';
            updates.consent_status = newStatus;
            updates.esign_retry_count = retryCount;
            updates.esign_error_message = parsed?.failure_reason || parsed?.message || 'eSign failed';
        }

        const statusChanged = newStatus && newStatus !== record.consent_status;
        const backfillingPdf = newStatus === 'esign_completed' && updates.signed_consent_url && !record.signed_consent_url;

        if (statusChanged || backfillingPdf) {
            await db.update(consentRecords).set(updates).where(eq(consentRecords.id, record.id));
            if (statusChanged) {
                await db.update(leads).set({ consent_status: newStatus, updated_at: now }).where(eq(leads.id, leadId));
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                synced: true,
                raw_digio_status: rawStatus,
                consent_status: newStatus || record.consent_status,
                changed: Boolean(newStatus && newStatus !== record.consent_status),
            },
        });
    } catch (error) {
        console.error('[Consent Sync] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to sync consent status';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
