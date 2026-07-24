/**
 * Notifications + email for the NBFC Acquire request loop (Change 5).
 *
 * Every hop transition fires: (1) an in-app notification and (2) an email.
 * Admin emails carry a tokenised "act from email" link → a confirm page where
 * the admin can forward/push without logging in. All calls are best-effort —
 * a notification failure never breaks the underlying action.
 *
 * THE IN-APP HALF NOW GOES THROUGH THE NOTIFICATION HUB
 * (src/lib/notifications/events.ts). That is what gives these rows their
 * provenance line ("Bajaj Finance → iTarang Admin · NBFC request") and their
 * in-bell actions (Forward / Decline / Push to NBFC), and what lets the same
 * hop also reach the DEALER — who does the actual uploading and previously
 * learned nothing when a request was forwarded to them. The email half is
 * unchanged: it still carries the act-token link, which the in-app row does not
 * need because the recipient is already signed in.
 */
import type { NextRequest } from "next/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcDocRequests, users } from "@/lib/db/schema";
import {
  notifyNbfcRequestForwarded,
  notifyNbfcRequestPushed,
  notifyNbfcRequestRaised,
  notifyNbfcRequestUpload,
} from "@/lib/notifications/events";
import { sendEmail } from "@/lib/email/mailer";
import { generateActToken, actTokenExpiry, buildActLink } from "@/lib/nbfc/act-token";
import { NBFC_DOC_STATUS_LABEL } from "@/lib/nbfc/doc-requests";

export const ADMIN_NOTIFY_ROLES = ["admin", "ceo", "business_head", "sales_head"];

async function adminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        inArray(users.role, ADMIN_NOTIFY_ROLES),
        eq(users.is_active, true),
        isNotNull(users.email),
      ),
    );
  return rows.map((r) => r.email).filter((e): e is string => !!e);
}

/**
 * Mint a fresh act-token, store its hash on the wrapper, and return the confirm
 * page link. Called when we email the admin so the link authenticates the
 * confirm page.
 */
export async function mintActLink(
  requestId: string,
  req?: NextRequest | Request,
): Promise<string | null> {
  try {
    const { rawToken, tokenHash } = generateActToken();
    await db
      .update(nbfcDocRequests)
      .set({ act_token_hash: tokenHash, act_token_expires_at: actTokenExpiry(), updated_at: new Date() })
      .where(eq(nbfcDocRequests.id, requestId));
    return buildActLink(requestId, rawToken, req);
  } catch {
    return null;
  }
}

/** NBFC raised a request → notify + email admins with an act link. */
export async function notifyAdminsOfNbfcRequest(opts: {
  leadId: string;
  requestId: string;
  requestType: string;
  nbfcName: string;
  comments?: string | null;
  req?: NextRequest | Request;
}): Promise<void> {
  const typeLabel =
    opts.requestType === "correction"
      ? "document correction"
      : opts.requestType === "additional_docs"
        ? "additional documents"
        : opts.requestType === "step4_extra_items"
          ? "extra Step-4 items"
          : opts.requestType === "manual_consent"
            ? "manual DPDP consent signing"
            : "message";
  const title = `NBFC request: ${typeLabel}`;
  const message = `${opts.nbfcName} raised a ${typeLabel} request on lead ${opts.leadId}.${
    opts.comments ? ` "${opts.comments}"` : ""
  }`;

  // In-app: lands in the admin bell WITH Review & forward / Decline buttons, so
  // the common case never needs the page.
  await notifyNbfcRequestRaised({
    leadId: opts.leadId,
    requestId: opts.requestId,
    requestType: opts.requestType,
    nbfcName: opts.nbfcName,
    comments: opts.comments,
  });

  try {
    const to = await adminEmails();
    if (to.length === 0) return;
    const link = await mintActLink(opts.requestId, opts.req);
    const actHtml = link
      ? `<p><a href="${link}">Review &amp; action this request →</a></p>`
      : "";
    await sendEmail({
      to,
      subject: `[iTarang] ${title} — lead ${opts.leadId}`,
      text: `${message}\n\n${link ? `Review & action: ${link}` : "Open the admin KYC review to action it."}`,
      html: `<p>${message}</p>${actHtml}`,
    });
  } catch (e) {
    console.error("[nbfc-doc-notify] admin email failed:", e);
  }
}

/** Dealer/customer uploaded a requested doc → notify + email admins. */
export async function notifyAdminsOfUpload(opts: {
  leadId: string;
  requestId: string;
  docLabel: string;
  req?: NextRequest | Request;
}): Promise<void> {
  // Email copy only — the in-app copy is owned by the hub (events.ts), which
  // words it from the recipient's point of view and adds the provenance line.
  const message = `A document ("${opts.docLabel}") for an NBFC request on lead ${opts.leadId} was uploaded and is ready for review.`;

  // In-app: the admin bell gets a "Push to NBFC" button — the whole action at
  // this hop is one click, so it should not require opening the lead.
  await notifyNbfcRequestUpload({
    leadId: opts.leadId,
    requestId: opts.requestId,
    docLabel: opts.docLabel,
  });
  try {
    const to = await adminEmails();
    if (to.length === 0) return;
    const link = await mintActLink(opts.requestId, opts.req);
    await sendEmail({
      to,
      subject: `[iTarang] Upload ready for review — lead ${opts.leadId}`,
      text: `${message}\n\n${link ? `Review & push: ${link}` : ""}`,
      html: `<p>${message}</p>${link ? `<p><a href="${link}">Review &amp; push to NBFC →</a></p>` : ""}`,
    });
  } catch (e) {
    console.error("[nbfc-doc-notify] admin upload email failed:", e);
  }
}

/** Admin pushed the finished docs (or a direct message) up to the NBFC. */
export async function notifyNbfcOfUpdate(opts: {
  tenantId: string;
  leadId: string;
  requestId: string;
  isMessage?: boolean;
}): Promise<void> {
  await notifyNbfcRequestPushed({
    tenantId: opts.tenantId,
    leadId: opts.leadId,
    requestId: opts.requestId,
    isMessage: opts.isMessage,
  });
}

/**
 * Admin forwarded an NBFC's ask down to the dealer — the hop that was missing
 * entirely. The dealer is the one who must upload; before this they only saw a
 * lead-status change and had to work out what was wanted.
 */
export async function notifyDealerOfForward(opts: {
  leadId: string;
  requestId: string;
  docLabels: string[];
  nbfcName?: string | null;
  targetStep?: "kyc" | "borrower-consent";
}): Promise<void> {
  await notifyNbfcRequestForwarded(opts);
}

/** Status label passthrough for callers that want the human string. */
export function statusLabel(status: string): string {
  return NBFC_DOC_STATUS_LABEL[status] ?? status;
}
