/**
 * The notification dispatcher (M20).
 *
 * Sprint 1 recorded every state change as a `buyback_notification_events` row
 * and NOTHING drained them. That was the right half to build first — the durable
 * half — but it means no message has ever actually left the building. This is the
 * consumer.
 *
 * WHY NOT BULLMQ, WHICH BRD §6/§7 SPECIFY:
 * BullMQ is dead code in this repo. `ecosystem.prod.config.js` declares one app
 * (the web server) and no worker; the sandbox declares `sandbox-worker` with
 * `autorestart: false` and no ENABLE_CALL_WORKER, so it logs "disabled" and
 * exits in under a second. `callQueue.add()` is never invoked anywhere. And the
 * 16 crons in vercel.json do not fire on the pm2 VPS. The one mechanism that
 * demonstrably runs in sandbox AND production is an in-process ticker in
 * src/instrumentation-node.ts — which is how the dialer and the Zoho sync
 * actually run today. So that is what this uses. Moving to a real queue later is
 * a change of caller, not of logic: dispatchPending() is the unit of work.
 *
 * DELIVERY SEMANTICS: at-least-once, and honestly so. A row is LEASED (attempts
 * incremented, next_attempt_at pushed out) in one transaction, then sent, then
 * marked. If the process dies mid-send, the lease expires and the row is retried
 * — which can duplicate a message. Exactly-once is not achievable against an
 * external mail API, so we do not pretend: retries are bounded, and every send
 * records its provider message id.
 *
 * E-192-D (scale pack): the claim batch is 50 (was 20 — see the 30s ticker in
 * instrumentation-node.ts, so this raises the throughput ceiling from ~2,400/hr
 * to ~6,000/hr). The claimed batch sends in PARALLEL CHUNKS of 5
 * (`Promise.allSettled`, not `Promise.all` — one recipient's bounce or a
 * provider timeout must never abort its four batch-mates, and allSettled is
 * what guarantees that). Per-event try/catch semantics are otherwise
 * unchanged: each event still gets its own SENT/PENDING/FAILED write. An
 * `attachment_s3_key` shared by more than one claimed event (the same
 * quotation PDF going to several vendor-thread events in one tick) is fetched
 * from S3 exactly once via a `Map<key, Promise<Buffer | null>>` scoped to
 * THIS call — a fresh Map every `dispatchPending()` invocation, never reused
 * across ticks, so a since-replaced attachment is never served stale.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email/mailer";
import { notifyRoles } from "@/lib/notifications/notify";
import { getObject } from "@/lib/storage/s3";
import { getAdapter } from "@/lib/whatsapp";

import { BUYBACK_ADMIN_ROLES } from "./auth";
import { inr } from "./format";
import { BUYBACK_BUCKET } from "./storage";

/** Give up after this many tries and mark the event FAILED for a human to see. */
const MAX_ATTEMPTS = 6;

/** 1m, 5m, 15m, 45m, 2h15 — exponential, capped. */
const BACKOFF_SECONDS = [60, 300, 900, 2700, 8100, 8100];

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
  exhausted: number;
}

interface DueEvent {
  id: string;
  deal_id: string | null;
  request_id: string;
  event_type: string;
  recipient_party: "DEALER" | "ADMIN" | "VENDOR";
  channel: "WHATSAPP" | "EMAIL" | "PORTAL";
  recipient_ref: string | null;
  attachment_s3_key: string | null;
  /** E-198 — extra files (the battery photos). Null/empty for most events. */
  attachment_s3_keys: string[] | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Claim up to `limit` due events, send them, and mark the outcome.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run from more than one
 * process: two dispatchers claim disjoint sets rather than both grabbing the
 * same row and double-sending. Today only one runs — but the day someone adds a
 * second web instance, this must not start emailing vendors twice.
 */
export async function dispatchPending(limit = 50): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, failed: 0, exhausted: 0 };

  // --- 1. Lease. One short transaction: claim and push the retry time out, so
  //        nobody else picks these up while we are talking to the network.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      WITH due AS (
        SELECT id
        FROM buyback_notification_events
        WHERE delivery_status = 'PENDING'
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE buyback_notification_events e
      SET attempts        = e.attempts + 1,
          next_attempt_at = now() + (
            (ARRAY[${sql.raw(BACKOFF_SECONDS.join(","))}])[LEAST(e.attempts + 1, ${BACKOFF_SECONDS.length})]
            || ' seconds'
          )::interval
      FROM due
      WHERE e.id = due.id
      RETURNING e.id, e.deal_id, e.request_id, e.event_type, e.recipient_party,
                e.channel, e.recipient_ref, e.attachment_s3_key,
                e.attachment_s3_keys, e.payload, e.attempts
    `);

    return rows as unknown as DueEvent[];
  });

  summary.claimed = claimed.length;
  if (claimed.length === 0) return summary;

  // --- 2. Send. Outside the transaction: a mail API call must never hold a DB
  //        lock, and a slow provider must not stall the whole batch. Fresh per
  //        call, never reused across ticks — see file docblock.
  const attachmentCache = new Map<string, Promise<Buffer | null>>();

  const sendOne = async (event: DueEvent): Promise<void> => {
    try {
      const messageId = await deliver(event, attachmentCache);

      await db.execute(sql`
        UPDATE buyback_notification_events
        SET delivery_status = 'SENT', sent_at = now(), error = NULL
        WHERE id = ${event.id}
      `);

      // U6 — log the provider's message id against the vendor thread, so a reply
      // in the inbox can be tied back to the quotation it answers.
      const threadId = event.payload?.thread_id;
      if (messageId && typeof threadId === "string") {
        await db.execute(sql`
          UPDATE vendor_threads
          SET email_message_id = ${messageId}, sent_at = COALESCE(sent_at, now())
          WHERE id = ${threadId}::uuid
        `);
      }

      summary.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = event.attempts >= MAX_ATTEMPTS;

      // A permanently-failed event stays visible: it is not deleted and not
      // silently retried forever. Someone has to look at it.
      await db.execute(sql`
        UPDATE buyback_notification_events
        SET delivery_status = ${exhausted ? "FAILED" : "PENDING"},
            error = ${message.slice(0, 500)}
        WHERE id = ${event.id}
      `);

      if (exhausted) summary.exhausted += 1;
      summary.failed += 1;

      console.error(
        `[buyback:dispatch] ${event.event_type} → ${event.channel} failed ` +
          `(attempt ${event.attempts}/${MAX_ATTEMPTS})${exhausted ? " — GIVING UP" : ""}: ${message}`,
      );
    }
  };

  // Parallel chunks of 5 — allSettled so one rejection can never affect its
  // chunk-mates (each event already has its own try/catch above; this is
  // belt-and-braces against sendOne itself ever throwing synchronously).
  for (const chunk of chunkArray(claimed, 5)) {
    await Promise.allSettled(chunk.map(sendOne));
  }

  return summary;
}

/** Splits `arr` into consecutive chunks of at most `size`. */
/**
 * Content type from an S3 key's extension.
 *
 * The keys are server-derived (uploadKeyFor picks the extension from a
 * content-type we already validated against ALLOWED_UPLOAD_TYPES), so the
 * extension is trustworthy here in a way a client filename would not be.
 * Falling back to octet-stream makes a mail client offer a download rather
 * than render a broken image.
 */
function mimeForKey(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Route one event to its channel. Returns the provider's message id, if any. */
async function deliver(
  event: DueEvent,
  attachmentCache: Map<string, Promise<Buffer | null>>,
): Promise<string | null> {
  const { subject, body } = renderMessage(event);

  switch (event.channel) {
    case "EMAIL": {
      if (!event.recipient_ref) {
        throw new Error("EMAIL event has no recipient_ref — nothing to send to");
      }

      /** Fetch once per key per tick — several vendor events name the same PDF. */
      const fetchOnce = (key: string): Promise<Buffer | null> => {
        let bytesPromise = attachmentCache.get(key);
        if (!bytesPromise) {
          bytesPromise = getObject(BUYBACK_BUCKET, key);
          attachmentCache.set(key, bytesPromise);
        }
        return bytesPromise;
      };

      const attachments = [];
      if (event.attachment_s3_key) {
        const key = event.attachment_s3_key;
        const bytes = await fetchOnce(key);
        if (!bytes) {
          // The quotation IS the email. Sending a "please quote" with no
          // quotation attached would be worse than retrying.
          throw new Error(`attachment missing from storage: ${key}`);
        }
        attachments.push({
          filename: key.split("/").pop() || "quotation.pdf",
          content: bytes,
          contentType: "application/pdf",
        });
      }

      // E-198 — the battery photos. A scrap buyer judges condition from these,
      // and they are the reason the quotation email exists in the shape it does:
      // "the vendor should not have to log in just to see the battery".
      //
      // OPPOSITE FAILURE POLICY TO THE PDF ABOVE, deliberately. A missing
      // quotation makes the message meaningless, so it throws and retries. A
      // missing photo does not: skipping it sends nine of ten photos, while
      // throwing sends none, retries six times, and eventually gives up — the
      // vendor gets no email at all because one object was gone. Evidence is
      // not worth stranding the message over.
      for (const key of event.attachment_s3_keys ?? []) {
        const bytes = await fetchOnce(key);
        if (!bytes) continue;
        attachments.push({
          filename: key.split("/").pop() || "photo",
          content: bytes,
          contentType: mimeForKey(key),
        });
      }

      const result = await sendEmail({
        to: event.recipient_ref,
        subject,
        html: body,
        attachments,
      });

      return result.messageId ?? null;
    }

    case "WHATSAPP": {
      if (!event.recipient_ref) {
        throw new Error("WHATSAPP event has no recipient_ref — nothing to send to");
      }
      const result = await getAdapter().sendText(event.recipient_ref, stripHtml(body));
      return (result as { messageId?: string })?.messageId ?? null;
    }

    case "PORTAL": {
      // Reuses the CRM's existing in-app bell (the `notifications` table). No
      // new UI: buyback events show up where admins already look.
      await notifyRoles([...BUYBACK_ADMIN_ROLES], {
        type: `buyback.${event.event_type}`,
        title: subject,
        message: stripHtml(body),
        data: { request_id: event.request_id, deal_id: event.deal_id, ...event.payload },
      });
      return null;
    }

    default:
      throw new Error(`unknown channel: ${event.channel}`);
  }
}

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Message copy, per action.
 *
 * Deliberately terse and free of numbers the recipient should not have: a
 * DEALER-bound message never mentions margin or a vendor, because the party is
 * decided in NOTIFICATION_FOR and the payload is written by the route — but copy
 * is the last place a leak can hide, so it stays boring on purpose.
 */
function renderMessage(event: DueEvent): { subject: string; body: string } {
  const p = event.payload ?? {};
  const requestNo = String(p.request_no ?? "your request");

  // Every message in one transition's fan-out shares the same event_type (the
  // action). So when a single action produces DIFFERENT messages for different
  // recipients — an agreement tells the admins one thing and the losing vendors
  // quite another — the payload says which. Keyed first, before event_type.
  if (p.kind === "vendor_lost") {
    return {
      subject: `Quotation ${String(p.quotation_no ?? "")} — closed`,
      body:
        `<p>Hello ${escapeHtml(String(p.vendor_name ?? "there"))},</p>` +
        `<p>Thank you for quoting on this lot. On this occasion we have placed it ` +
        `elsewhere. We will be in touch with the next one.</p>` +
        `<p>— iTarang</p>`,
    };
  }

  // E-193/R5 — the vendor's Razorpay payment link. The ONLY figure here is what
  // the vendor owes; no dealer price, no margin, no floor ever appears (the
  // vendor redaction holds in copy, the last place a leak could hide).
  if (p.kind === "vendor_payment_link") {
    const amountLabel = inr(p.amount as number | string | null | undefined);
    const shortUrl = String(p.short_url ?? "");
    return {
      subject: `Payment request — iTarang buyback ${requestNo}`,
      body:
        `<p>Hello ${escapeHtml(String(p.vendor_name ?? "there"))},</p>` +
        `<p>Your payment of <b>${escapeHtml(amountLabel)}</b> for buyback lot ` +
        `<b>${escapeHtml(requestNo)}</b> is now due. Please pay securely using the ` +
        `link below:</p>` +
        `<p><a href="${escapeHtml(shortUrl)}">${escapeHtml(shortUrl)}</a></p>` +
        `<p>This link is valid for 7 days.</p>` +
        `<p>— iTarang</p>`,
    };
  }

  // E-193 — gateway anomaly alerts (reversed payout, payment on a dead link,
  // amount mismatch, failed attempt). ADMIN/PORTAL only, and the whole story is
  // already written into payload.message by gateway.ts — surface it verbatim
  // rather than letting the generic default swallow it into "request — event".
  if (p.kind === "gateway_alert") {
    const prefix = p.severity === "critical" ? "URGENT: " : "";
    return {
      subject: `${prefix}Payment alert — ${requestNo}`,
      body: `<p>${escapeHtml(String(p.message ?? "A payment-gateway anomaly needs review."))}</p>`,
    };
  }

  switch (event.event_type) {
    case "route_to_vendors":
      return {
        subject: `Request for quotation — ${String(p.quotation_no ?? "iTarang buyback")}`,
        body:
          `<p>Hello ${escapeHtml(String(p.vendor_name ?? "there"))},</p>` +
          `<p>We have a lot of end-of-life batteries available for collection from ` +
          `<b>${escapeHtml(String(p.pickup_location ?? "our partner site"))}</b>. ` +
          `The itemised quotation is attached.</p>` +
          `<p>Please reply with your price <b>per SKU</b> — we settle each variant ` +
          `separately and cannot accept a single lump-sum figure for the lot.</p>` +
          `<p>— iTarang</p>`,
      };

    case "exchange_pos":
      return {
        subject: `Purchase order issued — ${requestNo}`,
        body: `Your purchase order for ${requestNo} is ready. Raise your invoice against it at the agreed per-battery rates.`,
      };

    case "schedule_pickup":
      return {
        subject: `Pickup scheduled — ${requestNo}`,
        body: `Collection for ${requestNo} is scheduled for ${escapeHtml(String(p.scheduled_at ?? "shortly"))}. Please have the batteries ready.`,
      };

    case "complete_pickup":
      return {
        subject: `Pickup completed — ${requestNo}`,
        body: `We have collected the batteries for ${requestNo}. Your invoice can now be raised.`,
      };

    default: {
      // Every other action already has copy on the dealer leg or is an internal
      // portal ping. A generic line is fine — and a missing case must never
      // throw, because that would fail-loop a legitimate transition forever.
      const from = String(p.from ?? "");
      const to = String(p.to ?? "");
      return {
        subject: `${requestNo} — ${event.event_type.replace(/_/g, " ")}`,
        body: from && to ? `${requestNo}: ${from} → ${to}.` : `${requestNo}: ${event.event_type}.`,
      };
    }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
