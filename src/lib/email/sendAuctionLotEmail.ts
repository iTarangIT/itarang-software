/**
 * Battery auction lot email — Battery Auction BRD §17.
 *
 * One template, three moments: a lot going live, a lot entering its final
 * hour, and a lot won. They share a body (the same lot facts, the same CTA)
 * and differ only in headline, accent and call to action, so they live in one
 * file rather than three near-copies that drift.
 *
 * WHY THIS EXISTS AT ALL, GIVEN emit() ALREADY SENDS EMAIL
 *   emit()'s generic mail is a title, a paragraph and a link. That is right for
 *   an internal state change and wrong for the only outbound message in this
 *   flow that has to make an external dealer want to act: it carries no price,
 *   no deadline, no photo. These three types are listed in catalog.ts's
 *   NO_EMAIL set precisely so this file is the only sender and nobody gets two.
 *
 * The photo is referenced by ABSOLUTE proxy URL, not embedded as CID. The
 * proxy is auth-gated, so a logged-out mail client shows the alt text instead
 * of the battery — which is the correct failure. Attaching the bytes would put
 * a recovered asset's photograph into an inbox we do not control, and the
 * layout is built to read with no image at all.
 */
import { getMailer } from "./mailer";

function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const inr = (n: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;

const ist = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export type AuctionEmailKind = "published" | "ending_soon" | "won";

export interface AuctionLotEmailPayload {
  toEmail: string | string[];
  kind: AuctionEmailKind;
  dealerName?: string | null;
  lot: {
    lot_id: string;
    lot_code: string;
    title?: string | null;
    quantity: number;
    base_price: number;
    /** Highest live bid, when there is one. */
    current_bid?: number | null;
    /** What the dealer actually paid — `won` only. */
    final_price?: number | null;
    ends_at: string;
    auction_type: string;
    conditions?: string[];
    city?: string | null;
    distance_km?: number | null;
    /** Relative `/api/files/...` path, or absolute. */
    photo_path?: string | null;
  };
}

/** The doc's own palette, inlined — no stylesheet survives an email client. */
const NAVY = "#0f2540";
const AMBER = "#b45309";
const TEAL = "#0f766e";

const COPY: Record<
  AuctionEmailKind,
  { accent: string; eyebrow: string; cta: string; subject: (code: string) => string }
> = {
  published: {
    accent: NAVY,
    eyebrow: "Now open for bidding",
    cta: "Place a bid",
    subject: (c) => `iTarang — battery lot ${c} is open for bidding`,
  },
  ending_soon: {
    accent: AMBER,
    eyebrow: "Closing within the hour",
    cta: "Bid before it closes",
    subject: (c) => `iTarang — lot ${c} closes within the hour`,
  },
  won: {
    accent: TEAL,
    eyebrow: "You won this lot",
    cta: "View the settlement",
    subject: (c) => `iTarang — you won battery lot ${c}`,
  },
};

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://app.itarang.com"
  ).replace(/\/+$/, "");
}

export async function sendAuctionLotEmail(
  p: AuctionLotEmailPayload,
): Promise<{ ok: boolean; messageId: string | null; error?: string }> {
  const copy = COPY[p.kind];
  const origin = appUrl();
  const href = `${origin}/dealer-portal/auctions/${p.lot.lot_id}`;
  const photo = p.lot.photo_path
    ? p.lot.photo_path.startsWith("http")
      ? p.lot.photo_path
      : `${origin}${p.lot.photo_path}`
    : null;

  const headlinePrice =
    p.kind === "won"
      ? (p.lot.final_price ?? p.lot.current_bid ?? p.lot.base_price)
      : (p.lot.current_bid ?? p.lot.base_price);
  const priceLabel =
    p.kind === "won"
      ? "Winning bid"
      : p.lot.current_bid != null
        ? "Highest bid"
        : "Opening price";

  const facts: Array<[string, string]> = [
    ["Lot", p.lot.lot_code],
    ["Batteries", String(p.lot.quantity)],
    [priceLabel, inr(headlinePrice)],
  ];
  if (p.kind !== "won") facts.push(["Closes", `${ist(p.lot.ends_at)} IST`]);
  if (p.lot.conditions?.length) facts.push(["Condition", p.lot.conditions.join(", ")]);
  if (p.lot.city) {
    facts.push([
      "Location",
      p.lot.distance_km != null
        ? `${p.lot.city} · ~${Math.round(p.lot.distance_km)} km away`
        : p.lot.city,
    ]);
  }
  if (p.lot.auction_type === "cash_refinance") {
    facts.push(["Payment", "Cash or refinance"]);
  }

  const factRows = facts
    .map(
      ([k, v]) => `
      <tr>
        <td style="padding:6px 14px 6px 0;color:#64748b;font-size:12px;
          letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">${esc(k)}</td>
        <td style="padding:6px 0;color:#0f172a;font-size:15px;font-weight:600">${esc(v)}</td>
      </tr>`,
    )
    .join("");

  const html = `
  <div style="font-family:Georgia,'Iowan Old Style',Palatino,serif;font-size:14px;
    color:#0f172a;max-width:560px">
    <p style="margin:0 0 4px;color:${copy.accent};font-size:11px;letter-spacing:.14em;
      text-transform:uppercase;font-family:Arial,sans-serif">${esc(copy.eyebrow)}</p>
    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${NAVY}">
      ${esc(p.lot.title || `${p.lot.quantity} recovered batteries`)}</h1>
    ${
      p.dealerName
        ? `<p style="margin:0 0 16px;color:#334155">Hello ${esc(p.dealerName)},</p>`
        : ""
    }
    ${
      photo
        ? `<img src="${esc(photo)}" alt="Battery lot ${esc(p.lot.lot_code)}"
             width="560" style="width:100%;max-width:560px;border-radius:10px;
             border:1px solid #e2e8f0;display:block;margin:0 0 18px">`
        : ""
    }
    <table role="presentation" cellpadding="0" cellspacing="0"
      style="border-collapse:collapse;margin:0 0 22px;font-family:Arial,sans-serif">
      ${factRows}
    </table>
    <p style="margin:0 0 22px">
      <a href="${esc(href)}" style="background:${copy.accent};color:#fff;text-decoration:none;
        padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;
        font-family:Arial,sans-serif;font-size:14px">${esc(copy.cta)}</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;font-family:Arial,sans-serif;margin:0">
      You are seeing this because your dealership is in the audience for this lot.
      Bids are binding once placed.
    </p>
  </div>`;

  const text = [
    copy.eyebrow.toUpperCase(),
    p.lot.title || `${p.lot.quantity} recovered batteries`,
    "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "",
    `${copy.cta}: ${href}`,
  ].join("\n");

  try {
    const transporter = await getMailer();
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    const info = await transporter.sendMail({
      from,
      to: p.toEmail,
      subject: copy.subject(p.lot.lot_code),
      text,
      html,
    });
    return { ok: true, messageId: info.messageId ?? null };
  } catch (err) {
    // Never throws: a lot must go live even when SMTP is down. The caller
    // records the failure on the audience row, so it is visible rather than
    // silently lost.
    const error = err instanceof Error ? err.message : "smtp_error";
    console.error(`[auction] lot email (${p.kind}) failed:`, error);
    return { ok: false, messageId: null, error };
  }
}
