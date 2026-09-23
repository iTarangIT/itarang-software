/**
 * The text that goes with the 08:00 Telegram card.
 *
 * The caption is the product, not the garnish. A dense dashboard screenshot on
 * a phone is something you squint at; these six lines are what actually gets
 * read, and the image is there for when one of them looks wrong.
 *
 * Sent with parse_mode=HTML, so every interpolated value is escaped. Telegram
 * rejects the whole message on a malformed tag, and one of these values is raw
 * database error text.
 */
import { freshnessPill, relativeAge } from "@/lib/telemetry/monitor-math";
import type { MonitorOverview } from "@/lib/telemetry/monitor-queries";

/** Telegram's hard limit for a photo caption. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

const IST_DATE = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
});

function esc(s: string | number): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function istDate(now: Date): string {
    return IST_DATE.format(now);
}

const PILL_DOT: Record<string, string> = {
    live: "\u{1F7E2}",
    stale: "\u{1F7E1}",
    frozen: "\u{1F534}",
    never: "⚫",
};

export function buildMorningCaption(data: MonitorOverview, now: Date): string {
    const { fleet, alerts } = data;
    const pill = freshnessPill(fleet.newestSignalAgeMs);

    const lines = [
        `<b>iTarang Fleet Monitor</b> · ${esc(istDate(now))}`,
        `${PILL_DOT[pill.kind]} ${esc(pill.label)} · newest signal ${esc(relativeAge(fleet.newestSignalAgeMs))}`,
        "",
        `<b>${esc(fleet.liveNow.toLocaleString("en-IN"))}</b> live of ${esc(fleet.fleetSize.toLocaleString("en-IN"))} (${esc(fleet.livePct)}%)`,
        `${esc(fleet.silentOver24h)} silent &gt;24h · ${esc(fleet.neverReported)} never reported`,
        `${esc(alerts.open.toLocaleString("en-IN"))} open connectivity alerts`,
    ];

    if (fleet.soc.below20 > 0) {
        lines.push(
            `⚠️ ${esc(fleet.soc.below20)} ${fleet.soc.below20 === 1 ? "pack" : "packs"} below 20% charge`,
        );
    }

    const caption = lines.join("\n");

    // Belt and braces. Every value above is a small integer today, but a caption
    // Telegram rejects is a morning with no report at all, so trim rather than
    // risk it.
    return caption.length <= TELEGRAM_CAPTION_LIMIT
        ? caption
        : `${caption.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}…`;
}

/**
 * Sent INSTEAD of the card when the telemetry database cannot be reached.
 *
 * A picture of an empty dashboard says less than one line of text, and silence
 * would be worse than either — it reads exactly like a morning where everything
 * was fine.
 */
export function buildUnreachableMessage(reason: string, now: Date): string {
    return [
        `<b>iTarang Fleet Monitor</b> · ${esc(istDate(now))}`,
        `⚫ No report — the telemetry database was unreachable, so nothing was measured.`,
        "",
        esc(reason),
    ].join("\n");
}
