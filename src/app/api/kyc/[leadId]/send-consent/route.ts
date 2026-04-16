export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords, leads, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { generateConsentHtml } from "@/lib/consent/consent-pdf-template";
import { createDigioAgreement } from "@/lib/digio/service";
type RouteContext = {
  params: Promise<{ leadId: string }>;
};

const CHROMIUM_REMOTE_PACK =
  "https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar";

async function renderPdfFromHtml(html: string): Promise<Buffer> {
  let browser;
  try {
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const [{ default: puppeteerCore }, { default: chromium }] = await Promise.all([
        import("puppeteer-core"),
        import("@sparticuz/chromium-min"),
      ]);
      browser = await puppeteerCore.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(CHROMIUM_REMOTE_PACK),
        headless: true,
      });
    } else {
      const puppeteerFull = await import("puppeteer").then(m => m.default);
      browser = await puppeteerFull.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const body = await req.json().catch(() => ({}));
    const channel = String(body?.channel || "sms").toLowerCase();

    if (!["sms", "whatsapp"].includes(channel)) {
      return NextResponse.json(
        { success: false, error: { message: "Channel must be sms or whatsapp" } },
        { status: 400 }
      );
    }

    // Fetch lead
    const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = leadRows[0];

    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 }
      );
    }

    const customerPhone = lead.phone || lead.owner_contact;
    const customerName = lead.full_name || lead.owner_name || "Customer";
    const customerEmail = lead.owner_email || "";

    if (!customerPhone) {
      return NextResponse.json(
        { success: false, error: { message: "Customer phone number not available" } },
        { status: 400 }
      );
    }

    // Fetch dealer name
    let dealerName = "";
    if (user.id) {
      const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (userRows.length) dealerName = userRows[0].name || "";
    }

    // Generate consent ID
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
    const consentId = `CONSENT-${dateStr}-${seq}`;

    const generatedDate = `${now.getDate().toString().padStart(2, "0")}/${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getFullYear()}`;

    // Format DOB
    let dobFormatted = "";
    if (lead.dob) {
      const d = new Date(lead.dob);
      dobFormatted = `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getFullYear()}`;
    }

    // 1. Generate consent PDF
    const html = generateConsentHtml({
      customerName,
      fatherOrHusbandName: lead.father_or_husband_name || "",
      dob: dobFormatted,
      phone: customerPhone,
      customerEmail,
      currentAddress: lead.current_address || "",
      permanentAddress: lead.permanent_address || lead.current_address || "",
      productName: lead.asset_model || "",
      productCategory: lead.asset_model || "",
      paymentMethod: lead.payment_method || "",
      dealerName,
      dealerCompany: "",
      leadId,
      consentId,
      generatedDate,
    });

    const pdfBuffer = await renderPdfFromHtml(html);
    const pdfBase64 = pdfBuffer.toString("base64");

    // 2. Upload to Digio for Aadhaar eSign
    // Digio needs 10-digit mobile number
    const cleanPhone = customerPhone.replace(/\D/g, "").slice(-10);

    const digioResponse = await createDigioAgreement({
      fileData: pdfBase64,
      fileName: `consent_${leadId}_${consentId}.pdf`,
      signers: [
        {
          identifier: cleanPhone,
          name: customerName,
          reason: "Customer Consent for KYC & Loan Processing",
          sign_type: "aadhaar",
        },
      ],
      expireInDays: 1,
      sequential: false,
    });

    console.log("[Send Consent] Digio response:", JSON.stringify(digioResponse, null, 2));

    // Extract Digio details
    const digioDocumentId = digioResponse?.id || digioResponse?.document_id || null;
    const signingParties = digioResponse?.signing_parties || [];
    const customerSigningUrl = signingParties[0]?.authentication_url || signingParties[0]?.authenticationUrl || null;

    if (!digioDocumentId) {
      console.error("[Send Consent] Digio did not return document ID:", digioResponse);
      return NextResponse.json(
        { success: false, error: { message: "Failed to create consent document with eSign provider. Check DigiO credentials." } },
        { status: 500 }
      );
    }

    // 3. Insert consent record
    await db.insert(consentRecords).values({
      id: consentId,
      lead_id: leadId,
      consent_for: "primary",
      consent_type: "digital",
      consent_status: "link_sent",
      consent_delivery_channel: channel,
      consent_link_url: customerSigningUrl,
      consent_link_sent_at: now,
      esign_transaction_id: digioDocumentId,
      created_at: now,
      updated_at: now,
    });

    // 4. Update lead consent status
    await db.update(leads)
      .set({ consent_status: "link_sent", updated_at: now })
      .where(eq(leads.id, leadId));

    return NextResponse.json({
      success: true,
      hasDigioIntegration: true,
      data: {
        consentId,
        leadId,
        channel,
        phone: cleanPhone,
        customerSigningUrl,
        digioDocumentId,
        sentAt: now.toISOString(),
        message: `Consent form sent to customer via DigiO. Signing link delivered to ${cleanPhone}.`,
      },
    });
  } catch (error: any) {
    console.error("[Send Consent] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 }
    );
  }
}
