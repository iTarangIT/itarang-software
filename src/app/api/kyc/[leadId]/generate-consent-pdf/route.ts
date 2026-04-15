export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, consentRecords, users, personalDetails } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { uploadFileToStorage } from '@/lib/storage';
import { generateConsentHtml } from '@/lib/consent/consent-pdf-template';
import puppeteer from 'puppeteer';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

async function renderPdfFromHtml(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '10mm',
                right: '10mm',
                bottom: '10mm',
                left: '10mm',
            },
        });

        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;
        const body = await req.json().catch(() => ({}));
        const consentFor = String(body?.consent_for || 'customer').toLowerCase();
        const dbConsentFor = consentFor === 'customer' ? 'primary' : consentFor;

        // Fetch lead data
        const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!leadRows.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        const lead = leadRows[0];

        // Fetch dealer info
        let dealerName = '';
        let dealerCompany = '';
        if (user.id) {
            const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
            if (userRows.length) {
                dealerName = userRows[0].name || '';
            }
        }

        // For borrower consent, fetch personal_details (borrower-specific data)
        let borrowerData: any = null;
        if (consentFor === 'borrower') {
            const personalRows = await db.select()
                .from(personalDetails)
                .where(eq(personalDetails.lead_id, leadId))
                .limit(1);
            borrowerData = personalRows[0] || null;
        }

        // Resolve person data based on consent type
        const personName = consentFor === 'borrower'
            ? (borrowerData?.father_husband_name ? lead.full_name : lead.full_name) || lead.owner_name || ''
            : lead.full_name || lead.owner_name || '';
        const personFather = consentFor === 'borrower'
            ? (borrowerData?.father_husband_name || lead.father_or_husband_name || '')
            : (lead.father_or_husband_name || '');
        const personPhone = lead.phone || '';
        const personAddress = consentFor === 'borrower'
            ? (borrowerData?.local_address || lead.current_address || '')
            : (lead.current_address || '');
        const personPermanentAddress = lead.permanent_address || personAddress;
        const personDob = consentFor === 'borrower'
            ? (borrowerData?.dob || lead.dob)
            : lead.dob;
        const personAadhaar = consentFor === 'borrower'
            ? (borrowerData?.aadhaar_no || '')
            : '';
        const personPan = consentFor === 'borrower'
            ? (borrowerData?.pan_no || '')
            : '';

        // Format DOB
        let dobFormatted = '';
        if (personDob) {
            const d = new Date(personDob);
            dobFormatted = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
        }

        // Generate consent ID
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const consentId = `CONSENT-${dateStr}-${seq}`;

        const generatedDate = `${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;

        // Generate HTML
        const html = generateConsentHtml({
            customerName: personName,
            fatherOrHusbandName: personFather,
            dob: dobFormatted,
            phone: personPhone,
            currentAddress: personAddress,
            permanentAddress: personPermanentAddress,
            aadhaarMasked: personAadhaar,
            panNumber: personPan,
            productName: lead.asset_model || '',
            productCategory: lead.asset_model || '',
            paymentMethod: lead.payment_method || '',
            dealerName,
            dealerCompany,
            leadId,
            consentId,
            generatedDate,
        });

        // Render PDF
        const pdfBuffer = await renderPdfFromHtml(html);

        // Upload to storage
        const fileName = `consent_${consentId}_${Date.now()}.pdf`;
        const uploadResult = await uploadFileToStorage({
            fileBuffer: pdfBuffer,
            fileName,
            folder: `kyc/${leadId}/consent`,
            contentType: 'application/pdf',
        });

        // Insert consent record
        await db.insert(consentRecords).values({
            id: consentId,
            lead_id: leadId,
            consent_for: dbConsentFor,
            consent_type: 'manual',
            consent_status: 'consent_generated',
            sign_method: 'manual',
            generated_pdf_url: uploadResult.url,
            consent_attempt_count: 1,
            created_at: now,
            updated_at: now,
        });

        // Update lead consent status
        const leadUpdate = consentFor === 'borrower'
            ? { borrower_consent_status: 'consent_generated' }
            : { consent_status: 'consent_generated' };
        await db.update(leads)
            .set(leadUpdate)
            .where(eq(leads.id, leadId));

        return NextResponse.json({
            success: true,
            consentId,
            pdfUrl: uploadResult.url,
            fileName,
            generatedAt: now.toISOString(),
            message: 'Consent PDF generated. Please print, get customer signature, and upload scanned copy.',
        });
    } catch (error) {
        console.error('[Generate Consent PDF] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to generate consent PDF';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
