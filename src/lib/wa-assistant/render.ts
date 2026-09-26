// Tool results + the model's reply → one WhatsApp message, within WhatsApp's
// limits (BRD §9.4, plan §6). Lists and lead cards are built DETERMINISTICALLY
// from tool results — the model's wording never decides what a row says.
//
//   text     ≤ 1,000 chars (WhatsApp allows 4,096; the BRD keeps it short)
//   list     ≤ 10 rows; row title ≤ 24 (shop, truncated); description ≤ 72
//            (status · interest · next date); row id ast:lead:<id>; body ≤ 1,024
//   format   *bold* for a heading only; no markdown tables or links
//
// Truncation never splits a grapheme (emoji, Devanagari conjuncts) and keeps
// BOTH the UTF-16 length and the code-point count within the limit, so the
// result is valid however WhatsApp counts.

import type { LeadSummary, Preview, ToolResult } from "@/lib/assistant/types";
import type { CancelOutcome, ExecOutcome } from "@/lib/assistant/executor";
import { PENDING_TTL_MINUTES } from "@/lib/assistant/actions";
import type { ListRow } from "./client";

export const RENDER_LIMITS = {
    text: 1000,
    previewBody: 900,
    listBody: 1024,
    header: 60,
    listButton: 20,
    rowTitle: 24,
    rowDescription: 72,
    rows: 10,
} as const;

export type WaPayload =
    | { kind: "text"; body: string }
    | { kind: "list"; body: string; button: string; header?: string; rows: ListRow[] }
    /**
     * Reply buttons. A write preview: exactly Confirm / Cancel, ids ast:c:<id> /
     * ast:x:<id>, with its actionId. After a conversion: "Send invite"
     * (ast:inv:<leadId>), no actionId.
     */
    | { kind: "buttons"; body: string; buttons: { id: string; title: string }[]; actionId?: string };

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Fit `s` into `max` characters, ending with "…" when cut. Grapheme-safe. */
export function fit(s: string, max: number): string {
    const text = s.trim();
    if (text.length <= max) return text;
    const room = max - 1; // for "…"
    let out = "";
    for (const { segment } of segmenter.segment(text)) {
        if (out.length + segment.length > room) break;
        out += segment;
    }
    return out.trimEnd() + "…";
}

// IST dates with fixed names — shared with the core's previews.
export { fmtDate } from "@/lib/assistant/format";
import { fmtDate } from "@/lib/assistant/format";

function statusLabel(s: string | null): string | null {
    return s ? s.replace(/_/g, " ") : null;
}

/** One list row. The title falls back shop → dealer → id; never empty. */
export function leadRow(lead: LeadSummary): ListRow {
    const title = lead.shop_name?.trim() || lead.dealer_name?.trim() || lead.id;
    const parts = [statusLabel(lead.status), lead.interest, fmtDate(lead.next_date)].filter(Boolean) as string[];
    return {
        id: `ast:lead:${lead.id}`,
        title: fit(title, RENDER_LIMITS.rowTitle),
        ...(parts.length ? { description: fit(parts.join(" · "), RENDER_LIMITS.rowDescription) } : {}),
    };
}

/** Model output hygiene: **bold** → *bold*, no markdown headings / tables / links. */
export function whatsappText(s: string): string {
    return s
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
        .replace(/^\s*\|.*\|\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const LIST_BUTTON = "View leads";

const PREVIEW_VALUE_MAX = 200;

/**
 * A write preview with its Confirm / Cancel buttons (BRD §8.4). Built only from
 * the stored Preview — what the executor will write — never from model text.
 * Body ≤ 900: long values are cut first, then the lines; the title, warning and
 * footer always survive.
 */
export function renderPreview(preview: Preview, actionId: string, opts: { edit?: boolean } = {}): WaPayload {
    const head = `*${fit(preview.title, RENDER_LIMITS.header)}*`;
    const footer =
        `Resets idle clock: ${preview.resets_idle_clock ? "yes" : "no"} · Expires in ${PENDING_TTL_MINUTES} min` +
        (preview.needs_second_confirm ? "\nYou'll be asked to confirm once more." : "");
    const warning = preview.warning ? `\n${fit(preview.warning, 300)}` : "";
    const room = RENDER_LIMITS.previewBody - head.length - footer.length - warning.length - 2;
    const lines = fit(
        preview.lines.map((l) => `${l.label}: ${fit(l.value.replace(/\s+/g, " "), PREVIEW_VALUE_MAX)}`).join("\n"),
        Math.max(room, 0),
    );
    return {
        kind: "buttons",
        body: `${head}\n${lines}${warning}\n${footer}`,
        // Edit sits between Confirm and Cancel. Not on a high-impact second
        // confirmation or a dealer invite: there is nothing left to edit.
        buttons: [
            { id: `ast:c:${actionId}`, title: "Confirm" },
            ...(opts.edit === false ? [] : [{ id: `ast:e:${actionId}`, title: "Edit" }]),
            { id: `ast:x:${actionId}`, title: "Cancel" },
        ],
        actionId,
    };
}

const REJECTED: Record<Extract<ExecOutcome, { kind: "rejected" }>["reason"], string> = {
    stale: "This lead changed after the preview, so nothing was saved. Send it again for a fresh preview.",
    not_owner: "You no longer own this lead, so nothing was saved.",
    writes_disabled: "Saving from WhatsApp is switched off for you. Nothing was saved.",
    lead_missing: "That lead no longer exists. Nothing was saved.",
    not_claimable: "That lead can no longer be claimed. Nothing was saved.",
    duplicate_phone: "A lead with this phone number already exists. Nothing was saved.",
    target_unavailable: "That person is no longer active, so nothing was saved. Pick someone else.",
};

/**
 * A confirmed write. After a conversion the reply OFFERS the dealer invite as a
 * button — it only proposes; the invite has its own preview and Confirm. The
 * invite itself reports whether WhatsApp accepted the send.
 */
function renderConfirmed(o: Extract<ExecOutcome, { kind: "confirmed" }>): WaPayload {
    const saved = fit(`✅ Saved: ${o.title.replace(/^\*|\*$/g, "")}\n${o.crmUrl}`, RENDER_LIMITS.text);
    if (o.tool === "invite_dealer_onboarding") {
        if (o.extra?.delivered === true) return { kind: "text", body: `✅ Onboarding invite sent to the dealer.\n${o.crmUrl}` };
        const why = String(o.extra?.error ?? "WhatsApp send failed");
        return {
            kind: "text",
            body: fit(`⚠️ The invite could not be sent (${why}). Try again, or use Invite on WhatsApp in the CRM.\n${o.crmUrl}`, RENDER_LIMITS.text),
        };
    }
    if (o.tool === "mark_converted" && o.leadId) {
        return {
            kind: "buttons",
            body: fit(`${saved}\n\nSend the dealer the WhatsApp onboarding invite?`, RENDER_LIMITS.previewBody),
            buttons: [{ id: `ast:inv:${o.leadId}`, title: "Send invite" }],
        };
    }
    return { kind: "text", body: saved };
}

/** The reply to a Confirm / Cancel tap (UC-15 wording for expired and repeated taps). */
export function renderTapOutcome(o: ExecOutcome | CancelOutcome): WaPayload {
    const text = (body: string): WaPayload => ({ kind: "text", body });
    switch (o.kind) {
        case "confirmed":
            return renderConfirmed(o);
        case "second_confirm":
            return renderPreview(o.preview, o.actionId, { edit: false });
        case "cancelled":
            return text("Cancelled. Nothing was saved.");
        case "expired":
            return text("This action expired. Nothing was saved. Send it again if you still want it.");
        case "already_done":
            return text("Already saved.");
        case "already_cancelled":
            return text("That was cancelled. Nothing was saved.");
        case "superseded":
            return text("That card was replaced by a newer one. Use the latest card.");
        case "in_progress":
            return text("Already saving that…");
        case "failed_before":
            return text("That one didn't save earlier. Nothing was changed. Send it again.");
        case "awaiting_second_confirm":
            return text("Tap Confirm on the high-impact warning to finish, or Cancel.");
        case "not_found":
            return text("I couldn't find that action.");
        case "rejected":
            return text(REJECTED[o.reason]);
        case "error":
            return text("Something went wrong, nothing was changed. Please try again.");
    }
}

/**
 * The reply for one agent turn. A write preview (if any) wins and is sent with
 * its buttons, the model's wording dropped. Otherwise the last list-shaped
 * result (candidates, or a queue/search with 2+ rows) becomes a tappable list;
 * everything else is text.
 */
export function renderTurn(turn: { text: string; results: { tool: string; result: ToolResult }[] }): WaPayload {
    const preview = [...turn.results].reverse().map((r) => r.result).find((r) => r.kind === "preview");
    if (preview?.kind === "preview") return renderPreview(preview.preview, preview.action_id);
    const text = whatsappText(turn.text);
    const listy = [...turn.results]
        .reverse()
        .map((r) => r.result)
        .find(
            (r): r is Extract<ToolResult, { kind: "leads" | "candidates" }> =>
                (r.kind === "candidates" && r.rows.length > 0) || (r.kind === "leads" && r.rows.length >= 2),
        );
    if (listy) {
        const heading = listy.kind === "leads" ? listy.title : "Which one?";
        const fallback =
            listy.kind === "candidates"
                ? listy.question
                : `${listy.rows.length} of ${listy.total}. Tap one for details.`;
        let body = text || fallback;
        if (listy.kind === "leads" && listy.total > listy.rows.length && listy.crm_url) {
            const more = `\n\nAll ${listy.total}: ${listy.crm_url}`;
            if (body.length + more.length <= RENDER_LIMITS.listBody) body += more;
        }
        return {
            kind: "list",
            header: fit(heading, RENDER_LIMITS.header),
            body: fit(body, RENDER_LIMITS.listBody),
            button: LIST_BUTTON,
            rows: listy.rows.slice(0, RENDER_LIMITS.rows).map(leadRow),
        };
    }
    return { kind: "text", body: fit(text || "Done.", RENDER_LIMITS.text) };
}

type Detail = Record<string, unknown> & {
    recent_touchpoints?: Record<string, unknown>[];
    recent_visits?: Record<string, unknown>[];
};

const str = (v: unknown) => (v == null || v === "" ? null : String(v));

/** A lead card for a tapped list row — no model involved. */
export function renderLeadCard(lead: Detail): string {
    const lines: string[] = [];
    const name = str(lead.shop_name) ?? str(lead.dealer_name) ?? str(lead.id) ?? "Lead";
    lines.push(`*${name}*`);
    const who = [str(lead.dealer_name) !== name ? str(lead.dealer_name) : null, str(lead.city)].filter(Boolean).join(" · ");
    if (who) lines.push(who);
    if (lead.phone) lines.push(`Phone: ${lead.phone}`);
    lines.push(
        [
            `Status: ${statusLabel(str(lead.status)) ?? "none"}`,
            lead.interest ? `Interest: ${lead.interest}` : null,
        ].filter(Boolean).join(" · "),
    );
    lines.push(
        lead.owned_by_you ? "Owner: you" : `Owner: ${str(lead.owner_name) ?? "nobody"} (read-only for you)`,
    );
    const next = fmtDate(str(lead.next_follow_up_at));
    if (next) lines.push(`Next follow-up: ${next}`);
    const last = fmtDate(str(lead.last_activity_at));
    if (last) lines.push(`Last activity: ${last}`);

    const tps = (lead.recent_touchpoints ?? []).slice(0, 3);
    if (tps.length) {
        lines.push("", "*Recent*");
        for (const t of tps) {
            const head = [fmtDate(str(t.at)), str(t.type)?.replace(/_/g, " "), str(t.call_status)?.replace(/_/g, " ")]
                .filter(Boolean)
                .join(" · ");
            const remark = str(t.remarks);
            lines.push(remark ? `${head}: ${fit(remark.replace(/\s+/g, " "), 80)}` : head);
        }
    }
    const visits = (lead.recent_visits ?? []).slice(0, 2);
    if (visits.length) {
        lines.push("", "*Visits*");
        for (const v of visits) {
            lines.push(
                [fmtDate(str(v.visited_on) ?? str(v.scheduled_date)), str(v.status), str(v.outcome)?.replace(/_/g, " ")]
                    .filter(Boolean)
                    .join(" · "),
            );
        }
    }
    const url = str(lead.crm_url);
    const tail = url ? `\n\n${url}` : "";
    return fit(lines.join("\n"), RENDER_LIMITS.text - tail.length) + tail;
}
