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
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leadDealerReviews, leads } from "@/lib/db/schema";

import { dealerCheckKindLabel } from "./dealer-assignment-rules";
import { getDealerCheckSettings, type DealerCheckRecipient } from "./dealer-check-settings";
import { dealerCheckActionUrl, mintDealerCheckToken } from "./dealer-check-token";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The name a WhatsApp lead carries until the customer's PAN / Aadhaar is read
 * (customer-lead.ts PENDING_CUSTOMER_NAME). Not a real name — never put it in
 * an alert.
 */
const PLACEHOLDER_NAMES = new Set(["customer", "draft", ""]);

export function isRealCustomerName(n: string | null | undefined): boolean {
  return !PLACEHOLDER_NAMES.has((n ?? "").trim().toLowerCase());
}

async function leadFacts(leadId: string) {
  const [l] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      reference_id: leads.reference_id,
      city: leads.city,
      pm: leads.payment_method,
      mobile: leads.mobile,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const real = [l?.full_name, l?.owner_name].find((n) => isRealCustomerName(n)) ?? null;
  return {
    /** The customer's real name, or null while only the placeholder is known. */
    name: real,
    // Without a name the mobile is the next best way to recognise the file.
    customer: real ?? (l?.mobile ? `Name not given yet (${l.mobile})` : "Name not given yet"),
    ref: l?.reference_id || leadId,
    city: l?.city && l.city !== "Unknown" ? l.city : null,
    payment: l?.pm ?? null,
  };
}

/** Who to name on the "Salesperson" line — the initiator's role differs by kind. */
function initiatorLine(reasonKind: string | undefined, name: string): string {
  if (reasonKind === "house_push") return `Assigned by: ${name}`;
  if (reasonKind === "dealer_salesperson") return `Dealer's salesperson: ${name}`;
  return `Salesperson: ${name}`;
}

type SendResult = { ok: boolean; error: string | null };

async function sendWhatsApp(mobile: string, body: string, template: { customer: string; ref: string; what: string }) {
  return (await trySendWhatsApp(mobile, body, template)).ok;
}

async function trySendWhatsApp(
  mobile: string,
  body: string,
  template: { customer: string; ref: string; what: string },
): Promise<SendResult> {
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
    return { ok: res.ok, error: res.ok ? null : String(res.error ?? "not delivered") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[dealer-check-notify] WhatsApp failed", msg);
    return { ok: false, error: msg };
  }
}

async function sendMail(to: string, subject: string, text: string, html: string) {
  return (await trySendMail(to, subject, text, html)).ok;
}

async function trySendMail(to: string, subject: string, text: string, html: string): Promise<SendResult> {
  try {
    const { sendEmail } = await import("@/lib/email/mailer");
    await sendEmail({ to, subject, text, html });
    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[dealer-check-notify] email failed", msg);
    return { ok: false, error: msg };
  }
}

export interface OpenedNotice {
  reviewId: string;
  leadId: string;
  dealerName: string;
  reasonLabel: string;
  /** lead_dealer_reviews.reason_kind — picks the wording of the initiator line. */
  reasonKind?: string;
  initiatorName: string | null;
}

/** How long a check waits for the customer's name before alerting without it. */
const NAME_WAIT_MS = 30 * 60 * 1000;

/** One summary per send, for logs / tests. */
export interface NoticeReport {
  recipient: string;
  email: boolean | null;
  whatsapp: boolean | null;
}

/**
 * Called when a check opens. A WhatsApp lead is created before the customer's
 * PAN / Aadhaar is read, so its name is still the "Customer" placeholder: the
 * alert then waits — noticeDealerCheckNameArrived sends it the moment the name
 * lands, and a 30-minute fallback sends it with the mobile if no name ever
 * comes (a warm / cold lead saved without documents).
 */
export async function noticeDealerCheckOpened(n: OpenedNotice): Promise<NoticeReport[]> {
  try {
    const f = await leadFacts(n.leadId);
    if (!f.name) {
      console.log(`[dealer-check-notify] ${n.reviewId}: waiting for the customer's name before alerting`);
      const t = setTimeout(() => {
        void sendIfStillWaiting(n).catch((err) => console.warn("[dealer-check-notify] fallback failed", err));
      }, NAME_WAIT_MS);
      t.unref?.();
      return [];
    }
  } catch (err) {
    console.warn("[dealer-check-notify] name check failed", err instanceof Error ? err.message : String(err));
  }
  return sendOpenedNotice(n);
}

/** Fallback: still pending and still no name after the wait → alert with the mobile. */
async function sendIfStillWaiting(n: OpenedNotice) {
  const f = await leadFacts(n.leadId);
  if (f.name) return; // the name arrived — noticeDealerCheckNameArrived already sent it
  const [rev] = await db
    .select({ status: leadDealerReviews.status })
    .from(leadDealerReviews)
    .where(eq(leadDealerReviews.id, n.reviewId))
    .limit(1);
  if (rev?.status !== "pending") return;
  await sendOpenedNotice(n);
}

/**
 * The customer's name has just been written onto the lead for the first time
 * (placeholder → real name). Send the alert of every check still open on it.
 * Callers must only call this on that transition, so it goes out once.
 * Never throws.
 */
export async function noticeDealerCheckNameArrived(leadId: string): Promise<void> {
  try {
    const open = await db
      .select({
        id: leadDealerReviews.id,
        dealerId: leadDealerReviews.dealer_id,
        reasonKind: leadDealerReviews.reason_kind,
        initiatorName: leadDealerReviews.initiated_by_name,
      })
      .from(leadDealerReviews)
      .where(and(eq(leadDealerReviews.lead_id, leadId), eq(leadDealerReviews.status, "pending")));
    if (!open.length) return;
    const { dealerDisplayNames } = await import("./pushGuards");
    const names = await dealerDisplayNames(open.map((o) => o.dealerId));
    for (const o of open) {
      await sendOpenedNotice({
        reviewId: o.id,
        leadId,
        dealerName: names.get(o.dealerId) ?? o.dealerId,
        reasonLabel: dealerCheckKindLabel(o.reasonKind),
        reasonKind: o.reasonKind,
        initiatorName: o.initiatorName,
      });
    }
  } catch (err) {
    console.warn("[dealer-check-notify] name-arrived notice failed", err instanceof Error ? err.message : String(err));
  }
}

async function sendOpenedNotice(n: OpenedNotice): Promise<NoticeReport[]> {
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
        ...(n.initiatorName ? [initiatorLine(n.reasonKind, n.initiatorName)] : []),
        `Why it needs a check: ${n.reasonLabel}`,
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

// ── Test send (Settings › Dealer check alerts) ───────────────────────────────

export interface TestRecipient {
  name: string;
  email: string | null;
  whatsapp: string | null;
  emailOn: boolean;
  whatsappOn: boolean;
}

export interface TestReport {
  email: SendResult | null;
  whatsapp: SendResult | null;
}

/**
 * A sample dealer-check alert, so Admin / Sales Head can see that a person on
 * the list really receives it. Same layout as the real alert, marked TEST, with
 * sample customer / dealer and the tester as salesperson. The button opens the
 * Dealer checks page — there is no review behind a test, so no act-on-it token
 * is minted and nothing can be approved from it.
 */
export async function sendDealerCheckTest(r: TestRecipient, testerName: string): Promise<TestReport> {
  const { appBaseUrl } = await import("./dealer-check-token");
  const url = `${appBaseUrl()}/admin/dealer-checks`;
  const lines = [
    "Customer: Test Customer (#IT-TEST)",
    "Proposed dealer: Sample Dealer",
    initiatorLine("multi_pick", testerName),
    `Why it needs a check: ${dealerCheckKindLabel("multi_pick")}`,
  ];
  const note = `This is a TEST sent by ${testerName} from Settings › Dealer check alerts. No file is waiting — nothing to do.`;
  const report: TestReport = { email: null, whatsapp: null };

  if (r.emailOn && r.email) {
    report.email = await trySendMail(
      r.email,
      "[iTarang] TEST — Dealer check: Test Customer (#IT-TEST)",
      `Hi ${r.name},\n\n${note}\n\nThis is how a real alert looks:\n\n${lines.join("\n")}\n\nDealer checks: ${url}\n\niTarang`,
      `<p>Hi ${esc(r.name)},</p><p style="background:#FFF7E6;border:1px solid #F5C26B;padding:8px 12px;border-radius:6px"><b>TEST</b> — ${esc(note)}</p>` +
        `<p>This is how a real alert looks:</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` +
        `<p><a href="${esc(url)}" style="display:inline-block;background:#0047AB;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open Dealer checks</a></p><p>iTarang</p>`,
    );
  }
  if (r.whatsappOn && r.whatsapp) {
    const mobile = r.whatsapp.replace(/\D/g, "").slice(-10);
    report.whatsapp = mobile.length === 10
      ? await trySendWhatsApp(
          mobile,
          `🧪 *TEST — Dealer check alert*\n\n${lines.join("\n")}\n\n_${note}_`,
          { customer: "Test Customer", ref: "#IT-TEST", what: `TEST alert from ${testerName} — nothing to do` },
        )
      : { ok: false, error: "Not a 10-digit mobile" };
  }
  console.log(`[dealer-check-notify] test to ${r.name} by ${testerName}: ${JSON.stringify(report)}`);
  return report;
}
