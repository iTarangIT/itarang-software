export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { leads, consentRecords, users, coBorrowers } from '@/lib/db/schema';
import { requireRole } from '@/lib/auth-utils';
import { uploadFileToStorage } from '@/lib/storage';
import { generateConsentHtml } from '@/lib/consent/consent-pdf-template';
import { launchBrowser } from '@/lib/pdf/launch-browser';

type RouteContext = { params: Promise<{ leadId: string }> };

async function renderPdfFromHtml(html: string): Promise<Buffer> {
    // Browser is pooled across requests by launchBrowser(); we only close the
    // per-request Page. The consent HTML has no external resources, so
    // 'domcontentloaded' is sufficient — 'networkidle0' would idle-wait ~500ms
    // for traffic that never arrives.
    const browser = await launchBrowser();
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
        });
        return Buffer.from(pdf);
    } finally {
        await page.close().catch(() => {});
    }
}

function formatDob(value: unknown): string {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value as string);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;
        const body = await req.json().catch(() => ({}));

        // Normalize the applicant the consent is for. Dealer page sends
        // 'customer' for Step 2 and 'borrower' for Step 3. Persist as
        // 'primary' / 'co_borrower' so admin review and status polling match.
        const rawConsentFor = String(body?.consent_for || 'customer').toLowerCase();
        const consentForRole: 'primary' | 'co_borrower' =
            rawConsentFor === 'borrower' || rawConsentFor === 'co_borrower'
                ? 'co_borrower'
                : 'primary';

        const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!leadRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }
        const lead = leadRows[0];

        // Dealer info (for footer)
        let dealerName = '';
        if (user.id) {
            const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
            if (userRows.length) dealerName = userRows[0].name || '';
        }

        // Resolve signer data per role — primary uses lead fields, co-borrower
        // uses the coBorrowers row so the generated PDF carries the
        // co-borrower's actual name, phone, DOB and addresses.
        let signerName: string;
        let signerFatherName: string;
        let signerPhone: string;
        let signerEmail: string;
        let signerCurrentAddress: string;
        let signerPermanentAddress: string;
        let signerDob: unknown;
        let signerAadhaar: string;
        let signerPan: string;

        if (consentForRole === 'co_borrower') {
            const cobRows = await db
                .select()
                .from(coBorrowers)
                .where(eq(coBorrowers.lead_id, leadId))
                .limit(1);
            const cob = cobRows[0];
            if (!cob) {
                return NextResponse.json(
                    { success: false, error: { message: 'Co-borrower not found for this lead' } },
                    { status: 404 },
                );
            }
            signerName = cob.full_name || 'Co-borrower';
            signerFatherName = cob.father_or_husband_name || '';
            signerPhone = cob.phone || '';
            signerEmail = '';
            signerCurrentAddress = cob.current_address || cob.address || '';
            signerPermanentAddress = cob.permanent_address || cob.address || '';
            signerDob = cob.dob;
            signerAadhaar = cob.aadhaar_no || '';
            signerPan = cob.pan_no || '';
        } else {
            signerName = lead.full_name || lead.owner_name || '';
            signerFatherName = lead.father_or_husband_name || '';
            signerPhone = lead.phone || '';
            signerEmail = lead.owner_email || '';
            signerCurrentAddress = lead.current_address || '';
            signerPermanentAddress = lead.permanent_address || lead.current_address || '';
            signerDob = lead.dob;
            signerAadhaar = '';
            signerPan = '';
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const consentId = `CONSENT-${dateStr}-${seq}`;

        const html = generateConsentHtml({
            customerName: signerName,
            fatherOrHusbandName: signerFatherName,
            dob: formatDob(signerDob),
            phone: signerPhone,
            customerEmail: signerEmail,
            currentAddress: signerCurrentAddress,
            permanentAddress: signerPermanentAddress,
            aadhaarMasked: signerAadhaar,
            panNumber: signerPan,
            productName: lead.asset_model || '',
            productCategory: lead.asset_model || '',
            paymentMethod: lead.payment_method || '',
            dealerName,
            dealerCompany: '',
            leadId,
            consentId,
            generatedDate: `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`,
        });

        const pdfBuffer = await renderPdfFromHtml(html);

        const fileName = `consent_${consentId}_${Date.now()}.pdf`;
        const uploadResult = await uploadFileToStorage({
            fileBuffer: pdfBuffer,
            fileName,
            folder: `kyc/${leadId}/consent`,
            contentType: 'application/pdf',
        });

        await db.insert(consentRecords).values({
            id: consentId,
            lead_id: leadId,
            consent_for: consentForRole,
            consent_type: 'manual',
            consent_status: 'consent_generated',
            generated_pdf_url: uploadResult.url,
            created_at: now,
            updated_at: now,
        });

        if (consentForRole === 'co_borrower') {
            await db
                .update(coBorrowers)
                .set({ consent_status: 'consent_generated', updated_at: now })
                .where(eq(coBorrowers.lead_id, leadId));
        } else {
            await db
                .update(leads)
                .set({ consent_status: 'consent_generated' })
                .where(eq(leads.id, leadId));
        }

        return NextResponse.json({
            success: true,
            consentId,
            pdfUrl: uploadResult.url,
            fileName,
            generatedAt: now.toISOString(),
            message: 'Consent PDF generated. Print it, obtain customer signature, and upload the scanned copy.',
        });
    } catch (error) {
        console.error('[Generate Consent PDF] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to generate consent PDF';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
