/**
 * E-234 — the auction notification fan-out (Battery Auction BRD §17).
 *
 * Five events, four channels:
 *
 *   auction.lot_published   whole frozen audience   in-app · email · WhatsApp · SMS
 *   auction.outbid          the dealer just passed  in-app
 *   auction.ending_soon     everyone who has bid    in-app · email
 *   auction.won             the winner              in-app · email · WhatsApp
 *   auction.lost            the other bidders       in-app · email
 *
 * WHY THE AUDIENCE TABLE IS THE QUEUE
 *   `auction_lot_audience` already holds one row per (lot, dealer, channel)
 *   with a `status`, frozen at publish. Reading `status = 'pending'`, sending,
 *   and stamping `sent` / `failed` / `skipped` turns that table into the outbox
 *   for free — no new table, and the fan-out becomes RESUMABLE: a crash halfway
 *   through 400 dealers leaves 200 rows still pending and the next tick
 *   finishes them, without re-messaging the 200 already done. It also answers
 *   "who did we actually tell, on what, and when?", which is the question a
 *   disputed auction turns on.
 *
 * WHY IT RUNS FROM THE TICKER AND NOT FROM THE PUBLISH REQUEST
 *   A country-wide audience is thousands of sends across three external
 *   providers. Inline, the publish request would hang for minutes and a single
 *   provider timeout would fail an otherwise-good publish. The publish writes
 *   'pending' rows and returns; `runAuctionNotifications()` drains them.
 *
 * NOTHING HERE THROWS. Every send is wrapped, every failure is recorded on the
 * row it belongs to. A notification must never be the reason a lot fails to go
 * live or fails to close.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  auctionBids,
  auctionLotAudience,
  auctionLotItems,
  auctionLots,
  recoveryBatteries,
  users,
} from "@/lib/db/schema";
import { emit, type Recipient } from "@/lib/notifications/emit";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";
import { sendAuctionLotEmail } from "@/lib/email/sendAuctionLotEmail";
import { getAdapter } from "@/lib/whatsapp";
import { logOutbound } from "@/lib/whatsapp/notifications";
import { sendKycSms } from "@/lib/sms";
import { getObject } from "@/lib/storage/s3";

const DEALER_PARTY = { party: "dealer" as const, label: "Dealer" };

/** How many dealers one drain pass will message. Keeps a tick bounded. */
const FANOUT_BATCH = 60;

const inr = (n: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;

function lotHref(lotId: string): string {
  return `/dealer-portal/auctions/${lotId}`;
}

// ---------------------------------------------------------------------------
// Lot facts — read once per lot, shared by every channel
// ---------------------------------------------------------------------------

export interface LotFacts {
  lot_id: string;
  lot_code: string;
  title: string | null;
  quantity: number;
  base_price: number;
  current_bid: number | null;
  ends_at: string;
  auction_type: string;
  conditions: string[];
  /** Relative `/api/files/...` path of the first battery photo, if any. */
  photo_path: string | null;
}

async function loadLotFacts(lotId: string): Promise<LotFacts | null> {
  const [lot] = await db
    .select()
    .from(auctionLots)
    .where(eq(auctionLots.id, lotId))
    .limit(1);
  if (!lot) return null;

  const items = await db
    .select({
      condition: auctionLotItems.condition,
      images: recoveryBatteries.image_urls,
    })
    .from(auctionLotItems)
    .leftJoin(
      recoveryBatteries,
      eq(recoveryBatteries.id, auctionLotItems.battery_id),
    )
    .where(eq(auctionLotItems.lot_id, lotId));

  const [top] = await db
    .select({ amount: sql<string | null>`max(${auctionBids.amount})` })
    .from(auctionBids)
    .where(eq(auctionBids.lot_id, lotId));

  const conditions = [...new Set(items.map((i) => i.condition).filter(Boolean))];
  const photo_path =
    items.map((i) => i.images?.[0]).find((u): u is string => !!u) ?? null;

  return {
    lot_id: lot.id,
    lot_code: lot.lot_code,
    title: lot.title ?? null,
    quantity: lot.quantity,
    base_price: Number(lot.base_price),
    current_bid: top?.amount != null ? Number(top.amount) : null,
    ends_at: (lot.ends_at as Date).toISOString(),
    auction_type: lot.auction_type,
    conditions,
    photo_path,
  };
}

function headline(f: LotFacts): string {
  return f.title || `${f.quantity} × recovered battery`;
}

// ---------------------------------------------------------------------------
// Battery photo bytes, for the WhatsApp image header
// ---------------------------------------------------------------------------
// Photos are stored as the RELATIVE proxy path `/api/files/<bucket>/<key>`.
// Meta cannot fetch that (the proxy requires a session), so the bytes are read
// straight out of storage and uploaded to Meta instead — the same reason
// `sendDocumentBytes` exists. Read once per lot, reused for every dealer.
async function loadPhotoBytes(
  path: string | null,
): Promise<{ bytes: Buffer; mimeType: string; filename: string } | null> {
  if (!path) return null;
  const m = /^\/api\/files\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return null;
  try {
    const bucket = decodeURIComponent(m[1]);
    const key = m[2].split("/").map(decodeURIComponent).join("/");
    const bytes = await getObject(bucket, key);
    if (!bytes?.length) return null;
    const ext = (key.split(".").pop() ?? "jpg").toLowerCase();
    const mimeType =
      ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { bytes, mimeType, filename: key.split("/").pop() ?? "battery.jpg" };
  } catch (err) {
    console.error("[auction] photo read failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-channel senders. Each returns a status for the audience row.
// ---------------------------------------------------------------------------

type ChannelOutcome = { status: "sent" | "failed" | "skipped"; error?: string };

interface DealerContact {
  dealer_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  distance_km: number | null;
}

async function sendEmailChannel(
  d: DealerContact,
  f: LotFacts,
): Promise<ChannelOutcome> {
  if (!d.email) return { status: "skipped", error: "no_contact_email" };
  const res = await sendAuctionLotEmail({
    toEmail: d.email,
    kind: "published",
    dealerName: d.name,
    lot: { ...f, city: d.city, distance_km: d.distance_km },
  });
  return res.ok
    ? { status: "sent" }
    : { status: "failed", error: res.error ?? "smtp_error" };
}

/**
 * WhatsApp. A business-initiated message outside the 24h window needs a
 * pre-approved template, so the template name comes from env. With an image
 * template configured we send the battery photo as the header; with only a
 * plain template we send the body; with neither we fall back to free-form text
 * — which reaches dev/test numbers inside a session and nobody else. That
 * fallback is the same one the calculator and the inside-sales onboarding
 * route already use.
 */
async function sendWhatsAppChannel(
  d: DealerContact,
  f: LotFacts,
  photo: { bytes: Buffer; mimeType: string; filename: string } | null,
): Promise<ChannelOutcome> {
  if (!d.phone) return { status: "skipped", error: "no_contact_phone" };

  const template = process.env.AUCTION_WA_TEMPLATE?.trim();
  const lang = process.env.AUCTION_WA_TEMPLATE_LANG?.trim() || "en";
  const adapter = getAdapter();
  const params = [
    d.name ?? "there",
    headline(f),
    String(f.quantity),
    inr(f.current_bid ?? f.base_price),
    new Date(f.ends_at).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  ];

  try {
    let res;
    if (template) {
      res = await adapter.sendTemplateWithImageHeader(
        d.phone,
        template,
        lang,
        params,
        photo,
      );
      await logOutbound(null, res, {
        messageType: "template",
        templateName: template,
        textBody: `template:${template} (auction ${f.lot_code} → ${d.dealer_id})`,
      });
    } else {
      const body =
        `*${headline(f)}* is open for bidding on iTarang.\n\n` +
        `Lot ${f.lot_code} · ${f.quantity} batter${f.quantity === 1 ? "y" : "ies"}\n` +
        `${f.current_bid != null ? "Highest bid" : "Opening price"}: ${inr(f.current_bid ?? f.base_price)}\n` +
        `Closes: ${new Date(f.ends_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST\n\n` +
        `Bid here: ${(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "")}${lotHref(f.lot_id)}`;
      res = await adapter.sendText(d.phone, body);
      await logOutbound(null, res, { messageType: "text", textBody: body });
    }
    return res.ok
      ? { status: "sent" }
      : { status: "failed", error: res.error ?? "whatsapp_error" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "whatsapp_error",
    };
  }
}

/**
 * SMS. Gated on AUCTION_SMS_ENABLED and OFF by default, deliberately.
 *
 * The transport works — `sendKycSms` is the same Gupshup/Decentro picker every
 * other SMS in this app goes through — but an Indian commercial SMS needs a
 * DLT-registered template and sender ID, and this message has neither. Sending
 * without one gets the traffic dropped by the operator and can put the sender
 * ID at risk. Registration is a TRAI process, not a code change; until it is
 * done, every SMS row is recorded `skipped` with the reason, so the gap is
 * visible on the lot rather than presumed working.
 */
async function sendSmsChannel(
  d: DealerContact,
  f: LotFacts,
): Promise<ChannelOutcome> {
  if (process.env.AUCTION_SMS_ENABLED !== "true") {
    return { status: "skipped", error: "sms_disabled_no_dlt_template" };
  }
  if (!d.phone) return { status: "skipped", error: "no_contact_phone" };
  try {
    const res = await sendKycSms({
      mobile_number: d.phone,
      channel: "sms",
      reference_id: `AUC-${f.lot_code}-${d.dealer_id}`,
      message:
        `iTarang: battery lot ${f.lot_code} (${f.quantity} units) is open for bidding at ` +
        `${inr(f.current_bid ?? f.base_price)}. Closes ` +
        `${new Date(f.ends_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
      templateParams: [
        f.lot_code,
        String(f.quantity),
        inr(f.current_bid ?? f.base_price),
      ],
    });
    if (res.skipped) return { status: "skipped", error: res.error ?? "provider_disabled" };
    return res.success
      ? { status: "sent" }
      : { status: "failed", error: res.error ?? "sms_error" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "sms_error",
    };
  }
}

// ---------------------------------------------------------------------------
// 1. auction.lot_published — drain the frozen audience
// ---------------------------------------------------------------------------

export interface FanOutSummary {
  lot_code: string;
  dealers: number;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
}

/**
 * Sends the publish announcement to up to FANOUT_BATCH dealers with pending
 * rows on this lot, and stamps every row it touches.
 *
 * The in-app copy goes through `emit()` in ONE call for the whole batch, so a
 * 60-dealer fan-out is one bell write pass rather than 60. Email / WhatsApp /
 * SMS are inherently per-dealer.
 */
export async function notifyLotPublished(
  lotId: string,
): Promise<FanOutSummary | null> {
  const facts = await loadLotFacts(lotId);
  if (!facts) return null;

  const pending = await db
    .select()
    .from(auctionLotAudience)
    .where(
      and(
        eq(auctionLotAudience.lot_id, lotId),
        eq(auctionLotAudience.status, "pending"),
      ),
    )
    .orderBy(auctionLotAudience.dealer_id);

  if (pending.length === 0) {
    return {
      lot_code: facts.lot_code,
      dealers: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    };
  }

  // Group by dealer, then take the first FANOUT_BATCH dealers WHOLE — never a
  // partial dealer. Splitting a dealer across two passes would email them now
  // and WhatsApp them fifteen seconds later for the same lot.
  const byDealer = new Map<string, typeof pending>();
  for (const row of pending) {
    const bucket = byDealer.get(row.dealer_id) ?? [];
    bucket.push(row);
    byDealer.set(row.dealer_id, bucket);
  }
  const dealerIds = [...byDealer.keys()].slice(0, FANOUT_BATCH);
  const remaining = byDealer.size - dealerIds.length;

  const contactRows = await db
    .select({
      id: accounts.id,
      name: accounts.business_entity_name,
      email: accounts.contact_email,
      phone: accounts.contact_phone,
    })
    .from(accounts)
    .where(inArray(accounts.id, dealerIds));
  const contactById = new Map(contactRows.map((c) => [c.id, c]));

  const wantsWhatsApp = dealerIds.some((id) =>
    (byDealer.get(id) ?? []).some((r) => r.channel === "whatsapp"),
  );
  const photo = wantsWhatsApp ? await loadPhotoBytes(facts.photo_path) : null;

  // Which of these dealers can actually RECEIVE a bell row.
  //
  // `emit()` writes one notification per user_id — that rule is the whole
  // reason the dealer bell used to be permanently empty — so an account with
  // no active login gets nothing, silently. Without this lookup the audience
  // row would still be stamped `sent`, and the ledger whose entire job is
  // answering "who did we tell?" would answer it wrongly. Marking them
  // `skipped/no_active_login` also surfaces a real onboarding gap: a dealer in
  // an auction audience who cannot sign in.
  const withLogin = new Set(
    (
      await db
        .selectDistinct({ dealer_id: users.dealer_id })
        .from(users)
        .where(and(inArray(users.dealer_id, dealerIds), eq(users.is_active, true)))
    )
      .map((r) => r.dealer_id)
      .filter((d): d is string => !!d),
  );

  const counts = { sent: 0, failed: 0, skipped: 0 };
  const inAppRecipients: Recipient[] = [];
  const stamp: Array<{ id: string; status: string; error: string | null }> = [];

  for (const dealerId of dealerIds) {
    const rows = byDealer.get(dealerId) ?? [];
    const c = contactById.get(dealerId);
    const contact: DealerContact = {
      dealer_id: dealerId,
      name: c?.name ?? rows[0]?.dealer_name ?? null,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      city: rows[0]?.city ?? null,
      distance_km: rows[0]?.distance_km != null ? Number(rows[0].distance_km) : null,
    };

    for (const row of rows) {
      let outcome: ChannelOutcome;
      switch (row.channel) {
        case "in_app":
          if (!withLogin.has(dealerId)) {
            outcome = { status: "skipped", error: "no_active_login" };
            break;
          }
          inAppRecipients.push({
            audience: { kind: "dealer", dealerId },
            as: DEALER_PARTY,
            href: lotHref(facts.lot_id),
            message:
              `Lot ${facts.lot_code} — ${facts.quantity} batter${facts.quantity === 1 ? "y" : "ies"}` +
              ` from ${inr(facts.base_price)}. ` +
              (contact.distance_km != null
                ? `About ${Math.round(contact.distance_km)} km from you. `
                : "") +
              `Bidding closes ${new Date(facts.ends_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
            // Suppressed here because sendAuctionLotEmail() below is the sender
            // for this type. Belt and braces with catalog.ts's NO_EMAIL entry.
            email: false,
          });
          // The bell write happens after the loop; assume success and let the
          // emit() try/catch log any failure. A bell row is not worth a second
          // round-trip per dealer to confirm.
          outcome = { status: "sent" };
          break;
        case "email":
          outcome = await sendEmailChannel(contact, facts);
          break;
        case "whatsapp":
          outcome = await sendWhatsAppChannel(contact, facts, photo);
          break;
        case "sms":
          outcome = await sendSmsChannel(contact, facts);
          break;
        default:
          outcome = { status: "skipped", error: `unknown_channel:${row.channel}` };
      }
      counts[outcome.status] += 1;
      stamp.push({ id: row.id, status: outcome.status, error: outcome.error ?? null });
    }
  }

  if (inAppRecipients.length > 0) {
    await emit({
      type: "auction.lot_published",
      title: `Battery lot ${facts.lot_code} is open for bidding`,
      message: `${headline(facts)} — bidding is open.`,
      stage: "Auction",
      from: SYSTEM_PARTY,
      data: { lot_id: facts.lot_id, lot_code: facts.lot_code },
      to: inAppRecipients,
    });
  }

  await stampRows(stamp);

  return {
    lot_code: facts.lot_code,
    dealers: dealerIds.length,
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped,
    remaining,
  };
}

/**
 * Writes the per-row outcome back onto the audience table.
 *
 * One statement per distinct (status, error) pair rather than one per row: a
 * 60-dealer × 4-channel pass is 240 rows but only a handful of distinct
 * outcomes, and `sms_disabled_no_dlt_template` alone accounts for a quarter of
 * them.
 */
async function stampRows(
  rows: Array<{ id: string; status: string; error: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  const groups = new Map<string, { status: string; error: string | null; ids: string[] }>();
  for (const r of rows) {
    const key = `${r.status}::${r.error ?? ""}`;
    const g = groups.get(key) ?? { status: r.status, error: r.error, ids: [] };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    try {
      await db
        .update(auctionLotAudience)
        .set({ status: g.status, error: g.error, sent_at: new Date() })
        .where(inArray(auctionLotAudience.id, g.ids));
    } catch (err) {
      console.error("[auction] audience stamp failed:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. auction.outbid
// ---------------------------------------------------------------------------

/**
 * Tells the dealer who was leading that they no longer are.
 *
 * Called from `placeBid()` AFTER its transaction commits, never inside it: an
 * emit() that fails must not roll back an accepted bid, and holding the lot's
 * row lock across a bell write would serialise every bidder behind it.
 *
 * Silent when the same dealer outbid themselves — which the proxy engine does
 * routinely as it walks a standing maximum up.
 */
export async function notifyOutbid(input: {
  lot_id: string;
  outbid_dealer_id: string | null;
  new_leader_dealer_id: string | null;
  new_amount: number;
}): Promise<void> {
  const { outbid_dealer_id } = input;
  if (!outbid_dealer_id) return;
  if (outbid_dealer_id === input.new_leader_dealer_id) return;

  try {
    const facts = await loadLotFacts(input.lot_id);
    if (!facts) return;
    await emit({
      type: "auction.outbid",
      title: `Outbid on lot ${facts.lot_code}`,
      message:
        `${headline(facts)} is now at ${inr(input.new_amount)}. ` +
        `Bidding closes ${new Date(facts.ends_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
      stage: "Auction",
      from: SYSTEM_PARTY,
      data: {
        lot_id: facts.lot_id,
        lot_code: facts.lot_code,
        current_bid: input.new_amount,
      },
      to: [
        {
          audience: { kind: "dealer", dealerId: outbid_dealer_id },
          as: DEALER_PARTY,
          href: lotHref(facts.lot_id),
        },
      ],
    });
  } catch (err) {
    console.error("[auction] outbid notification failed:", err);
  }
}

// ---------------------------------------------------------------------------
// 3. auction.ending_soon
// ---------------------------------------------------------------------------

/** Distinct dealers who have placed at least one bid on this lot. */
async function biddersOn(lotId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT bidder_dealer_id
      FROM auction_bids
     WHERE lot_id = ${lotId} AND bidder_dealer_id IS NOT NULL
  `);
  return (rows as unknown as Array<Record<string, unknown>>)
    .map((r) => String(r.bidder_dealer_id))
    .filter(Boolean);
}

/**
 * Warns everyone who has bid that the lot closes within the hour.
 *
 * ONCE PER LOT. The ticker sees a lot in its final hour on every one of the
 * ~240 passes that hour, so the guard is not a nicety. It is a row in
 * `nbfc_auction_lot_actions`, inserted inside the same call — that table is
 * already the auction's action ledger, so this needs no new column and the
 * warning shows up in the lot's own audit trail where an operator will look.
 */
export async function notifyEndingSoon(lotId: string): Promise<boolean> {
  try {
    const already = await db.execute(sql`
      SELECT 1 FROM nbfc_auction_lot_actions
       WHERE lot_id = ${lotId} AND action_code = 'ending_soon_notified'
       LIMIT 1
    `);
    if ((already as unknown as Array<unknown>).length > 0) return false;

    const dealerIds = await biddersOn(lotId);
    const facts = await loadLotFacts(lotId);
    if (!facts) return false;

    // The marker is written even with zero bidders, so a lot nobody bid on is
    // not re-checked 240 times.
    await db.execute(sql`
      INSERT INTO nbfc_auction_lot_actions
        (lot_id, action_code, previous_value, new_value, reason, acted_by)
      VALUES (
        ${lotId}, 'ending_soon_notified', '{}'::jsonb,
        ${JSON.stringify({ bidders: dealerIds.length, ends_at: facts.ends_at })}::jsonb,
        'lot entered its final hour',
        '00000000-0000-0000-0000-000000000000'
      )
    `);

    if (dealerIds.length === 0) return true;

    await emit({
      type: "auction.ending_soon",
      title: `Lot ${facts.lot_code} closes within the hour`,
      message:
        `${headline(facts)} is at ${inr(facts.current_bid ?? facts.base_price)}. ` +
        `Bidding closes ${new Date(facts.ends_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`,
      stage: "Auction",
      from: SYSTEM_PARTY,
      data: { lot_id: facts.lot_id, lot_code: facts.lot_code },
      to: dealerIds.map((dealerId) => ({
        audience: { kind: "dealer" as const, dealerId },
        as: DEALER_PARTY,
        href: lotHref(facts.lot_id),
      })),
    });

    const contacts = await db
      .select({
        id: accounts.id,
        name: accounts.business_entity_name,
        email: accounts.contact_email,
      })
      .from(accounts)
      .where(inArray(accounts.id, dealerIds));
    for (const c of contacts) {
      if (!c.email) continue;
      await sendAuctionLotEmail({
        toEmail: c.email,
        kind: "ending_soon",
        dealerName: c.name,
        lot: facts,
      });
    }
    return true;
  } catch (err) {
    console.error("[auction] ending-soon notification failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4/5. auction.won and auction.lost
// ---------------------------------------------------------------------------

/**
 * Announces the result to every dealer who bid: one `won`, the rest `lost`.
 *
 * `lost` deliberately names the price it closed at. A dealer who knows they
 * were ₹2,000 short bids differently next time; one told only "you lost"
 * learns nothing, and the number is public to every participant anyway the
 * moment the lot page renders its final state.
 */
export async function notifyLotClosed(input: {
  lot_id: string;
  winner_dealer_id: string | null;
  final_price: number | null;
  reserve_met: boolean;
}): Promise<void> {
  try {
    const facts = await loadLotFacts(input.lot_id);
    if (!facts) return;
    const dealerIds = await biddersOn(input.lot_id);
    if (dealerIds.length === 0) return;

    const closingPrice = input.final_price ?? facts.current_bid ?? facts.base_price;
    const losers = dealerIds.filter((d) => d !== input.winner_dealer_id);

    if (input.winner_dealer_id && input.reserve_met) {
      await emit({
        type: "auction.won",
        title: `You won lot ${facts.lot_code}`,
        message:
          `${headline(facts)} is yours at ${inr(closingPrice)}. ` +
          `The seller will confirm the award and share payment details.`,
        stage: "Auction",
        from: SYSTEM_PARTY,
        data: {
          lot_id: facts.lot_id,
          lot_code: facts.lot_code,
          final_price: closingPrice,
        },
        to: [
          {
            audience: { kind: "dealer", dealerId: input.winner_dealer_id },
            as: DEALER_PARTY,
            href: lotHref(facts.lot_id),
          },
        ],
      });

      const [winner] = await db
        .select({
          name: accounts.business_entity_name,
          email: accounts.contact_email,
          phone: accounts.contact_phone,
        })
        .from(accounts)
        .where(eq(accounts.id, input.winner_dealer_id))
        .limit(1);
      if (winner?.email) {
        await sendAuctionLotEmail({
          toEmail: winner.email,
          kind: "won",
          dealerName: winner.name,
          lot: { ...facts, final_price: closingPrice },
        });
      }
      if (winner?.phone) {
        await sendWhatsAppChannel(
          {
            dealer_id: input.winner_dealer_id,
            name: winner.name,
            email: winner.email,
            phone: winner.phone,
            city: null,
            distance_km: null,
          },
          { ...facts, current_bid: closingPrice },
          null,
        );
      }
    }

    if (losers.length > 0) {
      // `reserve_met === false` means nobody won: the top bid was under the
      // floor. Saying "someone else took it" would be a lie, so the copy
      // splits.
      const soldToSomeoneElse = Boolean(input.winner_dealer_id) && input.reserve_met;
      await emit({
        type: "auction.lost",
        title: `Lot ${facts.lot_code} has closed`,
        message: soldToSomeoneElse
          ? `${headline(facts)} closed at ${inr(closingPrice)} to another bidder.`
          : `${headline(facts)} closed without meeting its reserve price. It may be re-listed.`,
        stage: "Auction",
        from: SYSTEM_PARTY,
        data: { lot_id: facts.lot_id, lot_code: facts.lot_code },
        to: losers.map((dealerId) => ({
          audience: { kind: "dealer" as const, dealerId },
          as: DEALER_PARTY,
          href: lotHref(facts.lot_id),
        })),
      });
    }
  } catch (err) {
    console.error("[auction] close notification failed:", err);
  }
}

// ---------------------------------------------------------------------------
// The drain, called by the ticker
// ---------------------------------------------------------------------------

/**
 * Finds every live/scheduled lot with pending audience rows and drains one
 * batch each. Bounded on both axes so one enormous fan-out cannot monopolise
 * a tick.
 */
export async function runAuctionNotifications(): Promise<FanOutSummary[]> {
  const lots = await db
    .select({ lot_id: auctionLotAudience.lot_id })
    .from(auctionLotAudience)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionLotAudience.lot_id))
    .where(
      and(
        eq(auctionLotAudience.status, "pending"),
        inArray(auctionLots.status, ["live", "scheduled"]),
      ),
    )
    .groupBy(auctionLotAudience.lot_id)
    .limit(5);

  const out: FanOutSummary[] = [];
  for (const l of lots) {
    try {
      const summary = await notifyLotPublished(l.lot_id);
      if (summary) out.push(summary);
    } catch (err) {
      console.error(`[auction] fan-out failed for lot ${l.lot_id}:`, err);
    }
  }
  return out;
}
