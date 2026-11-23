/**
 * 23 Nov — email + WhatsApp for the dealer check (point 4).
 *
 *   noticeDealerCheckOpened — a file reached the dealer check: every recipient on
 *                              Settings › Dealer check alerts gets an email and a
 *                              WhatsApp with THEIR OWN signed link to Approve,
 *                              Reject or Change the dealer.
 *   noticeDealerCheckDecided — somebody acted (on the CRM or by a link): the
 *                              other recipients are told "Action taken by <name>"
 *                              and their links stop working (the check is decided).
 *
 * These go only to iTarang people, so the approver's name is shown. Customer- and
 * dealer-facing messages never name the person (point 3).
 *
 * WhatsApp reaches a staff phone only inside its 24h window as free text; with
 * the `lead_action` template approved (WA_TEMPLATES_APPROVED) it always lands.
 * Never throws.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";

import { getDealerCheckSettings, type DealerCheckRecipient } from "./dealer-check-settings";
import { dealerCheckActionUrl, mintDealerCheckToken } from "./dealer-check-token";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function leadFacts(leadId: string) {
  const [l] = await db
    .select({ full_name: leads.full_name, owner_name: leads.owner_name, reference_id: leads.reference_id, city: leads.city, pm: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return {
    customer: l?.full_name || l?.owner_name || "Customer",
    ref: l?.reference_id || leadId,
    city: l?.city && l.city !== "Unknown" ? l.city : null,
    payment: l?.pm ?? null,
  };
}

async function sendWhatsApp(mobile: string, body: string, template: { customer: string; ref: string; what: string }) {
  try {
    const { getAdapter } = await import("@/lib/whatsapp");
    const { logOutbound } = await import("@/lib/whatsapp/notifications");
    const { resolveTemplate } = await import("@/lib/whatsapp/templates");
    const { oneLine } = await import("@/lib/whatsapp/window");
    const to = `91${mobile}`;
    const adapter = getAdapter();
    const tpl = resolveTemplate("lead_action");
    // Free text first (it carries the full message and lands inside an open
    // window); the template is the fallback that reaches a closed window.
    let res = await adapter.sendText(to, body);
    await logOutbound(null, res, { messageType: "text", textBody: body });
    if (!res.ok && tpl) {
      const params = [template.customer, template.ref, template.what].map((p) => oneLine(p, 900));
      res = await adapter.sendTemplate(to, tpl.name, tpl.lang, params);
      await logOutbound(null, res, { messageType: "template", textBody: params.join(" | "), templateName: tpl.name });
    }
    if (!res.ok) console.warn(`[dealer-check-notify] WhatsApp to ••${mobile.slice(-4)} not delivered: ${res.error ?? "unknown"}`);
    return res.ok;
  } catch (err) {
    console.warn("[dealer-check-notify] WhatsApp failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function sendMail(to: string, subject: string, text: string, html: string) {
  try {
    const { sendEmail } = await import("@/lib/email/mailer");
    await sendEmail({ to, subject, text, html });
    return true;
  } catch (err) {
    console.warn("[dealer-check-notify] email failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface OpenedNotice {
  reviewId: string;
  leadId: string;
  dealerName: string;
  reasonLabel: string;
  initiatorName: string | null;
}

/** One summary per send, for logs / tests. */
export interface NoticeReport {
  recipient: string;
  email: boolean | null;
  whatsapp: boolean | null;
}

export async function noticeDealerCheckOpened(n: OpenedNotice): Promise<NoticeReport[]> {
  const out: NoticeReport[] = [];
  try {
    const { recipients } = await getDealerCheckSettings();
    if (!recipients.length) return out;
    const f = await leadFacts(n.leadId);
    for (const r of recipients) {
      const url = dealerCheckActionUrl(mintDealerCheckToken(n.reviewId, r.userId));
      const lines = [
        `Customer: ${f.customer} (${f.ref})${f.city ? ` · ${f.city}` : ""}`,
        `Proposed dealer: ${n.dealerName}`,
        `Why it needs a check: ${n.reasonLabel}${n.initiatorName ? ` — ${n.initiatorName}` : ""}`,
      ];
      const report: NoticeReport = { recipient: r.name, email: null, whatsapp: null };
      if (r.emailOn && r.email) {
        report.email = await sendMail(
          r.email,
          `[iTarang] Dealer check: ${f.customer} (${f.ref})`,
          `Hi ${r.name},\n\nA customer file is waiting for the dealer check.\n\n${lines.join("\n")}\n\nApprove, reject or change the dealer here:\n${url}\n\nThe first person to act decides — everyone else is told who acted.\n\niTarang`,
          `<p>Hi ${esc(r.name)},</p><p>A customer file is waiting for the <b>dealer check</b>.</p>` +
            `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` +
            `<p><a href="${esc(url)}" style="display:inline-block;background:#0047AB;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Approve · Reject · Change dealer</a></p>` +
            `<p style="color:#666;font-size:12px">The first person to act decides — everyone else is told who acted. This link is for you only.</p><p>iTarang</p>`,
        );
      }
      if (r.whatsappOn && r.whatsapp) {
        report.whatsapp = await sendWhatsApp(
          r.whatsapp,
          `🔎 *Dealer check waiting*\n\n${lines.join("\n")}\n\nApprove, reject or change the dealer:\n${url}\n\n_The first person to act decides._`,
          { customer: f.customer, ref: f.ref, what: `dealer check for ${n.dealerName} — approve, reject or change: ${url}` },
        );
      }
      out.push(report);
    }
  } catch (err) {
    console.warn("[dealer-check-notify] opened notice failed", err instanceof Error ? err.message : String(err));
  }
  console.log(`[dealer-check-notify] opened ${n.reviewId}: ${JSON.stringify(out)}`);
  return out;
}

export interface DecidedNotice {
  leadId: string;
  actorUserId: string | null;
  actorName: string;
  /** "approved the dealer X" etc. — see decisionPhrase. */
  phrase: string;
  reason: string | null;
}

export async function noticeDealerCheckDecided(n: DecidedNotice): Promise<NoticeReport[]> {
  const out: NoticeReport[] = [];
  try {
    const { recipients } = await getDealerCheckSettings();
    const others = recipients.filter((r: DealerCheckRecipient) => r.userId !== n.actorUserId);
    if (!others.length) return out;
    const f = await leadFacts(n.leadId);
    const line = `${n.actorName} ${n.phrase} for ${f.customer} (${f.ref})${n.reason ? ` — "${n.reason}"` : ""}.`;
    for (const r of others) {
      const report: NoticeReport = { recipient: r.name, email: null, whatsapp: null };
      if (r.emailOn && r.email) {
        report.email = await sendMail(
          r.email,
          `[iTarang] Dealer check done by ${n.actorName}: ${f.customer} (${f.ref})`,
          `Hi ${r.name},\n\nAction taken by ${n.actorName}: ${line}\n\nNo action is needed from you — the earlier link no longer works.\n\niTarang`,
          `<p>Hi ${esc(r.name)},</p><p><b>Action taken by ${esc(n.actorName)}</b>: ${esc(line)}</p><p>No action is needed from you — the earlier link no longer works.</p><p>iTarang</p>`,
        );
      }
      if (r.whatsappOn && r.whatsapp) {
        report.whatsapp = await sendWhatsApp(
          r.whatsapp,
          `✅ *Dealer check — action taken by ${n.actorName}*\n\n${line}\n\n_No action needed from you; the earlier link no longer works._`,
          { customer: f.customer, ref: f.ref, what: `dealer check done by ${n.actorName} — no action needed` },
        );
      }
      out.push(report);
    }
  } catch (err) {
    console.warn("[dealer-check-notify] decided notice failed", err instanceof Error ? err.message : String(err));
  }
  console.log(`[dealer-check-notify] decided ${n.leadId}: ${JSON.stringify(out)}`);
  return out;
}
