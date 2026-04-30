import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords, kycVerifications } from '@/lib/db/schema';
import { and, desc, eq, notInArray, notLike } from 'drizzle-orm';

// esign_consent / esign_consent_sync rows in kyc_verifications are raw DigiO
// audit logs written by send-consent and consent/sync. They are not
// user-facing verification checks — the Customer Consent card on the KYC page
// already reflects the live consent state. Hide them from this list and emit
// a single synthesized row only after admin verification.
// 'mobile' rows are also hidden — the mobile-number check was removed from
// the dealer-facing Verification Status table.
const CONSENT_AUDIT_TYPES = ['esign_consent', 'esign_consent_sync'];
const HIDDEN_VERIFICATION_TYPES = [...CONSENT_AUDIT_TYPES, 'mobile'];
const ADMIN_VERIFIED_CONSENT_STATUSES = ['admin_verified', 'manual_verified', 'verified'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const verificationFor = req.nextUrl.searchParams.get('verification_for') || 'customer';
        const applicant = verificationFor === 'borrower' ? 'co_borrower' : 'primary';

        const customerWhere = applicant === 'primary'
            ? and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.applicant, applicant),
                notInArray(kycVerifications.verification_type, HIDDEN_VERIFICATION_TYPES),
                // Defensive: legacy rows where co-borrower verifications were
                // inserted without applicant='co_borrower' would otherwise leak
                // into the customer table. Exclude any coborrower_* types.
                notLike(kycVerifications.verification_type, 'coborrower_%'),
            )
            : and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.applicant, applicant),
                notInArray(kycVerifications.verification_type, HIDDEN_VERIFICATION_TYPES),
            );

        const verifications = await db
            .select()
            .from(kycVerifications)
            .where(customerWhere);

        const PRIMARY_LABELS: Record<string, string> = {
            aadhaar: 'Aadhaar Verification',
            pan: 'PAN Verification',
            bank: 'Bank Verification',
            address: 'Address Proof',
            rc: 'RC Verification',
            mobile: 'Mobile Number',
            cibil: 'CIBIL Score',
            photo: 'Photo Verification',
            esign_consent: 'Customer Consent',
        };

        const COBORROWER_LABELS: Record<string, string> = {
            aadhaar: 'Co-borrower Aadhaar Verification',
            pan: 'Co-borrower PAN Verification',
            bank: 'Co-borrower Bank Verification',
            address: 'Co-borrower Address Proof',
            rc: 'Co-borrower RC Verification',
            mobile: 'Co-borrower Mobile Number',
            cibil: 'Co-borrower CIBIL Score',
            photo: 'Co-borrower Photo Verification',
            esign_consent: 'Co-borrower Consent',
            coborrower_aadhaar: 'Co-borrower Aadhaar Verification',
            coborrower_pan: 'Co-borrower PAN Verification',
            coborrower_bank: 'Co-borrower Bank Verification',
            coborrower_address: 'Co-borrower Address Proof',
            coborrower_mobile: 'Co-borrower Mobile Number',
        };

        const labelFor = (type: string): string => {
            if (applicant === 'co_borrower') {
                return COBORROWER_LABELS[type] || PRIMARY_LABELS[type] || type;
            }
            return PRIMARY_LABELS[type] || type;
        };

        const rawRows = verifications.map(v => ({
            type: v.verification_type,
            label: labelFor(v.verification_type),
            status: v.status,
            last_update: v.updated_at?.toISOString() || null,
            failed_reason: v.failed_reason,
        }));

        // Dedupe by canonical type. The dealer's Step 3 submit writes
        // 'coborrower_*' rows and the admin's case-review writes plain
        // 'aadhaar' / 'pan' / 'bank' / 'rc' / 'cibil' rows with applicant=
        // co_borrower — both render with the same human label after the
        // label remap above, so the dealer sees apparent duplicates.
        // Group by canonical key (strip 'coborrower_' prefix) and keep the
        // most-recently-updated row per group, with status priority as a
        // tiebreaker so a "verified" row beats a same-second "pending" one.
        const canonicalType = (t: string) =>
            t.startsWith('coborrower_') ? t.slice('coborrower_'.length) : t;

        const STATUS_PRIORITY: Record<string, number> = {
            verified: 100, success: 100, admin_verified: 100, manual_verified: 100,
            failed: 80, rejected: 80,
            in_progress: 60,
            initiating: 40,
            pending: 20,
        };

        const dedupedMap = new Map<string, (typeof rawRows)[number]>();
        for (const row of rawRows) {
            const key = canonicalType(row.type);
            const existing = dedupedMap.get(key);
            if (!existing) { dedupedMap.set(key, row); continue; }
            const existingTs = existing.last_update ? new Date(existing.last_update).getTime() : 0;
            const newTs = row.last_update ? new Date(row.last_update).getTime() : 0;
            if (newTs > existingTs) {
                dedupedMap.set(key, row);
            } else if (newTs === existingTs) {
                const ePri = STATUS_PRIORITY[String(existing.status).toLowerCase()] ?? 0;
                const nPri = STATUS_PRIORITY[String(row.status).toLowerCase()] ?? 0;
                if (nPri > ePri) dedupedMap.set(key, row);
            }
        }
        const data = Array.from(dedupedMap.values());

        const [consent] = await db
            .select()
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, applicant),
            ))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (consent && ADMIN_VERIFIED_CONSENT_STATUSES.includes(consent.consent_status ?? '')) {
            // Replace any existing esign_consent row with the synthesized
            // one (carries the friendly label + verified state).
            const idx = data.findIndex(d => canonicalType(d.type) === 'esign_consent');
            const synthesized = {
                type: 'esign_consent',
                label: labelFor('esign_consent'),
                status: 'success',
                last_update: (consent.verified_at ?? consent.updated_at)?.toISOString() || null,
                failed_reason: null,
            };
            if (idx >= 0) data[idx] = synthesized;
            else data.push(synthesized);
        }

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[KYC Verifications] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
