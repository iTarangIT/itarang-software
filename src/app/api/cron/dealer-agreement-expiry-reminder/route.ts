/**
 * Daily cron: remind dealer-agreement signers who haven't signed yet that the
 * agreement is about to expire. Runs in the final `windowDays` (default 2) days
 * before expiry. Emails every unsigned signer; for WhatsApp-onboarded dealers it
 * ALSO sends the dealer signer a WhatsApp reminder with the sign link.
 *
 * Daily idempotency: a `dealer_agreement_events` row (event_type
 * 'expiry_reminder') is written per signer per send; we skip a signer if one was
 * written in the last ~20h, so a daily cron sends at most once a day.
 *
 * Auth: trusts the Vercel cron header (`x-vercel-cron`), else a
 * `Bearer CRON_SECRET`, else allows unauthenticated in non-production.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { sendDealerAgreementExpiryReminderEmail } from "@/lib/email/sendDealerAgreementExpiryReminderEmail";
import { getAdapter } from "@/lib/whatsapp";
import { logOutbound } from "@/lib/whatsapp/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const AGREEMENT_LIFETIME_DAYS = 30; // Digio expire_in_days
const DONE_STATUSES = new Set(["signed", "expired", "failed"]);

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

// Best per-signer expiry: prefer Digio's `expire_on` from the signer raw
// response, else the agreement's creation + 30 days.
function signerExpiry(
  rawResponse: unknown,
  signerCreatedAt: Date | null,
): Date | null {
  const raw = (rawResponse || {}) as Record<string, unknown>;
  const expireOn = raw["expire_on"];
  if (typeof expireOn === "string" && expireOn.trim()) {
    const d = new Date(expireOn.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (signerCreatedAt) return new Date(signerCreatedAt.getTime() + AGREEMENT_LIFETIME_DAYS * DAY_MS);
  return null;
}

function signerSignUrl(signer: {
  provider_signing_url: string | null;
  provider_raw_response: unknown;
}, fallback: string | null): string | null {
  if (signer.provider_signing_url) return signer.provider_signing_url;
  const raw = (signer.provider_raw_response || {}) as Record<string, unknown>;
  const authUrl = raw["authentication_url"];
  if (typeof authUrl === "string" && authUrl) return authUrl;
  return fallback;
}

async function run(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const windowDays = Number(req.nextUrl.searchParams.get("windowDays")) || 2;
  const now = Date.now();
  const supportEmail = process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com";
  const supportPhone = process.env.DEALER_SUPPORT_PHONE || "+91-8076841497";

  const apps = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(
      and(
        isNotNull(dealerOnboardingApplications.provider_document_id),
        inArray(dealerOnboardingApplications.agreement_status, [
          "sent_for_signature",
          "partially_signed",
        ]),
      ),
    );

  let emailsSent = 0;
  let whatsappSent = 0;
  let signersConsidered = 0;
  const errors: string[] = [];

  for (const app of apps) {
    const signers = await db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, app.id));

    for (const signer of signers) {
      const status = String(signer.signer_status || "").toLowerCase();
      if (DONE_STATUSES.has(status)) continue;

      const expiry = signerExpiry(signer.provider_raw_response, signer.created_at);
      if (!expiry) continue;
      const daysLeft = Math.ceil((expiry.getTime() - now) / DAY_MS);
      if (!(daysLeft > 0 && daysLeft <= windowDays)) continue;

      signersConsidered++;

      // Daily idempotency — skip if reminded in the last ~20h.
      const cutoff = new Date(now - 20 * 60 * 60 * 1000);
      const [recent] = await db
        .select({ id: dealerAgreementEvents.id })
        .from(dealerAgreementEvents)
        .where(
          and(
            eq(dealerAgreementEvents.application_id, app.id),
            eq(dealerAgreementEvents.event_type, "expiry_reminder"),
            eq(dealerAgreementEvents.signer_role, signer.signer_role),
            gte(dealerAgreementEvents.created_at, cutoff),
          ),
        )
        .limit(1);
      if (recent) continue;

      const signUrl = signerSignUrl(signer, app.provider_signing_url);
      const channels: string[] = [];

      // Email
      if (signer.signer_email) {
        try {
          await sendDealerAgreementExpiryReminderEmail({
            toEmail: signer.signer_email,
            signerName: signer.signer_name || "Signer",
            signerRole: signer.signer_role,
            companyName: app.company_name || "your company",
            daysLeft,
            signUrl,
            supportEmail,
            supportPhone,
          });
          emailsSent++;
          channels.push("email");
        } catch (err: any) {
          errors.push(`email ${app.id}/${signer.signer_role}: ${err?.message || err}`);
        }
      }

      // WhatsApp — only the dealer signer of a WhatsApp-onboarded dealer.
      if (
        (app.source || "web").toLowerCase() === "whatsapp" &&
        app.wa_phone &&
        signer.signer_role === "dealer" &&
        signUrl
      ) {
        try {
          const msg =
            `⏰ *Reminder:* your iTarang dealer agreement for *${app.company_name || "your company"}* ` +
            `expires in ${daysLeft} day${daysLeft > 1 ? "s" : ""}.\n\n` +
            `Please sign it before then:\n${signUrl}\n\nReply here if you need any help.`;
          const res = await getAdapter().sendText(app.wa_phone, msg);
          await logOutbound(app.wa_session_id ?? null, res, {
            messageType: "text",
            textBody: msg,
          });
          if (res.ok) {
            whatsappSent++;
            channels.push("whatsapp");
          }
        } catch (err: any) {
          errors.push(`whatsapp ${app.id}: ${err?.message || err}`);
        }
      }

      if (channels.length > 0) {
        await db.insert(dealerAgreementEvents).values({
          application_id: app.id,
          provider_document_id: app.provider_document_id,
          request_id: app.request_id,
          event_type: "expiry_reminder",
          signer_role: signer.signer_role,
          event_status: "reminded",
          event_payload: { daysLeft, channels, signerEmail: signer.signer_email },
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    applicationsScanned: apps.length,
    signersConsidered,
    emailsSent,
    whatsappSent,
    errors: errors.slice(0, 20),
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
