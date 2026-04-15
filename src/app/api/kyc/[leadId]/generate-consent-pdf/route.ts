export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { leads, consentRecords, users, personalDetails } from '@/lib/db/schema';
import { requireRole } from '@/lib/auth-utils';
import { uploadFileToStorage } from '@/lib/storage';
import { generateConsentHtml } from '@/lib/consent/consent-pdf-template';

type RouteContext = { params: Promise<{ leadId: string }> };

// Chromium for serverless (Vercel / Lambda). `@sparticuz/chromium-min` is a
// tiny JS shim that downloads the actual Chromium binary from GitHub at
// cold-start, keeping our function bundle well under Vercel's 50 MB zipped
// limit. The binary URL must match the installed chromium-min version.
const CHROMIUM_REMOTE_PACK =
    'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar';

async function launchBrowser() {
    const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

    if (isServerless) {
        const [{ default: puppeteerCore }, { default: chromium }] = await Promise.all([
            import('puppeteer-core'),
            import('@sparticuz/chromium-min'),
        ]);
        return puppeteerCore.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(CHROMIUM_REMOTE_PACK),
            headless: true,
        });
    }

    const { default: puppeteer } = await import('puppeteer');
    return puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}

async function renderPdfFromHtml(html: string): Promise<Buffer> {
    const browser = await launchBrowser();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
        });
        return Buffer.from(pdf);
    } finally {
        await browser.close();
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
        const consentFor = String(body?.consent_for || 'customer').toLowerCase();
        const dbConsentFor = consentFor === 'customer' ? 'primary' : consentFor;

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

        // Borrower-specific data if generating borrower consent
        let borrowerData: any = null;
        if (consentFor === 'borrower') {
            const personalRows = await db
                .select()
                .from(personalDetails)
                .where(eq(personalDetails.lead_id, leadId))
                .limit(1);
            borrowerData = personalRows[0] || null;
        }

        const personName = lead.full_name || lead.owner_name || '';
        const personFather = borrowerData?.father_husband_name || lead.father_or_husband_name || '';
        const personPhone = lead.phone || '';
        const personAddress = borrowerData?.local_address || lead.current_address || '';
        const personPermanentAddress = lead.permanent_address || personAddress;
        const personDob = borrowerData?.dob || lead.dob;
        const personAadhaar = borrowerData?.aadhaar_no || '';
        const personPan = borrowerData?.pan_no || '';

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const consentId = `CONSENT-${dateStr}-${seq}`;

        const html = generateConsentHtml({
            customerName: personName,
            fatherOrHusbandName: personFather,
            dob: formatDob(personDob),
            phone: personPhone,
            currentAddress: personAddress,
            permanentAddress: personPermanentAddress,
            aadhaarMasked: personAadhaar,
            panNumber: personPan,
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
            consent_for: dbConsentFor,
            consent_type: 'manual',
            consent_status: 'consent_generated',
            generated_pdf_url: uploadResult.url,
            created_at: now,
            updated_at: now,
        });

        await db
            .update(leads)
            .set({ consent_status: 'consent_generated' })
            .where(eq(leads.id, leadId));

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
