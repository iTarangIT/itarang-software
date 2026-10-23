// Tool results + the model's reply → one WhatsApp message, within WhatsApp's
// limits (BRD §9.4, plan §6). Lists and lead cards are built DETERMINISTICALLY
// from tool results — the model's wording never decides what a row says.
//
//   text     ≤ 1,000 chars (WhatsApp allows 4,096; the BRD keeps it short);
//            a lead report ≤ 2,000 so all 10 of its rows fit
//   list     ≤ 10 rows; row title ≤ 24 (shop, truncated); description ≤ 72
//            (status · interest · next date · phone); row id ast:lead:<id>; body ≤ 1,024
//            products: row id ast:prod:<asset_type>:<product_id>
//   paging   a longer list is followed by a second message with a "Next 10"
//            button (ast:more:<token>) — a list can't carry buttons, and a
//            "Next" row would take a lead's place and misalign the pages
//   format   *bold* for a heading only; no markdown tables or links
//
// Truncation never splits a grapheme (emoji, Devanagari conjuncts) and keeps
// BOTH the UTF-16 length and the code-point count within the limit, so the
// result is valid however WhatsApp counts.

import { PAGE_MAX, type LeadSummary, type Paging, type ProductSummary, type Preview, type ToolResult } from "@/lib/assistant/types";
import type { CancelOutcome, ExecOutcome } from "@/lib/assistant/executor";
import { PENDING_TTL_MINUTES } from "@/lib/assistant/actions";
import type { ListRow } from "./client";
import type { AgentStop } from "@/lib/assistant/agent";

export const RENDER_LIMITS = {
    text: 1000,
    /** A Hot / Warm / Cold lead report: up to 10 lines with phone + ageing must fit whole. */
    report: 2000,
    previewBody: 900,
    listBody: 1024,
    header: 60,
    listButton: 20,
    rowTitle: 24,
    rowDescription: 72,
    rows: 10,
} as const;

export type WaPayload =
    /** `followUp` — sent right after (the "Next 10" button under a longer list or report). */
    | { kind: "text"; body: string; followUp?: WaPayload }
    | { kind: "list"; body: string; button: string; header?: string; rows: ListRow[]; followUp?: WaPayload }
    /**
     * Reply buttons. A write preview: exactly Confirm / Cancel, ids ast:c:<id> /
     * ast:x:<id>, with its actionId. After a conversion: "Send invite"
     * (ast:inv:<leadId>), no actionId. Under a longer list: "Next 10"
     * (ast:more:<token>). For a big catalogue: the product types (ast:ptype:<type>).
     */
    | { kind: "buttons"; body: string; buttons: { id: string; title: string }[]; actionId?: string };

// ── Paging ──────────────────────────────────────────────────────────────────

/** The list tools a "Next 10" tap may re-run — short codes keep the button id small. */
const PAGED_TOOLS = {
    q: "my_queue",
    s: "search_lead",
    h: "my_leads_by_temperature",
    p: "product_catalogue",
} as const;
export type PagedTool = (typeof PAGED_TOOLS)[keyof typeof PAGED_TOOLS];
const CODE_OF = Object.fromEntries(Object.entries(PAGED_TOOLS).map(([c, t]) => [t, c])) as Record<PagedTool, string>;

/** Meta caps a reply button id at 256 (parse.ts reads ≤ 256). */
const BUTTON_ID_MAX = 256;

export const MORE_PREFIX = "ast:more:";

/**
 * "ast:more:<base64url JSON>" for page `page` of `tool` with `args`, or null
 * when the tool isn't paged or the id would not fit. Carries no authority: a
 * tap replays the tool through its own schema and the user's scope.
 */
export function encodeMore(tool: string, args: Record<string, string>, page: number): string | null {
    const code = CODE_OF[tool as PagedTool];
    if (!code || page < 2 || page > PAGE_MAX) return null;
    const id = MORE_PREFIX + Buffer.from(JSON.stringify({ t: code, a: args, p: page }), "utf8").toString("base64url");
    return id.length <= BUTTON_ID_MAX ? id : null;
}

/** The token after "ast:more:" → what to run, or null for anything malformed. Pure. */
export function decodeMore(token: string): { tool: PagedTool; args: Record<string, string>; page: number } | null {
    try {
        const v = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
        if (!v || typeof v !== "object") return null;
        const { t, a, p } = v as { t?: unknown; a?: unknown; p?: unknown };
        const tool = typeof t === "string" && Object.hasOwn(PAGED_TOOLS, t) ? PAGED_TOOLS[t as keyof typeof PAGED_TOOLS] : null;
        if (!tool || !Number.isInteger(p) || (p as number) < 2 || (p as number) > PAGE_MAX) return null;
        if (!a || typeof a !== "object" || Array.isArray(a)) return null;
        const args: Record<string, string> = {};
        for (const [k, val] of Object.entries(a as Record<string, unknown>)) {
            if (typeof val !== "string" || k === "page") return null;
            args[k] = val;
        }
        return { tool, args, page: p as number };
    } catch {
        return null;
    }
}

/** First and last row number shown ("11–20"), 1-based. */
function range(paging: Paging | undefined, shown: number): { from: number; to: number } {
    const from = paging ? (paging.page - 1) * paging.page_size + 1 : 1;
    return { from, to: from + shown - 1 };
}

/**
 * The "Next 10" message under a page that isn't the last one: where we are,
 * the CRM link, and the button. Null on the last page, for a result without
 * paging, or when `shown` isn't the whole page (rows were cut to fit — the
 * next page would skip them).
 */
export function nextPageFollowUp(
    tool: string,
    r: { total: number; paging?: Paging; crm_url?: string | null },
    shown: number,
): WaPayload | null {
    const p = r.paging;
    if (!p || shown < p.page_size) return null;
    const { from, to } = range(p, shown);
    if (r.total <= to) return null;
    const id = encodeMore(tool, p.args, p.page + 1);
    if (!id) return null;
    const left = Math.min(p.page_size, r.total - to);
    const link = r.crm_url ? `\nAll ${r.total} in the CRM: ${r.crm_url}` : "";
    return {
        kind: "buttons",
        body: fit(`Showing ${from}–${to} of ${r.total}.${link}`, RENDER_LIMITS.listBody),
        buttons: [{ id, title: `Next ${left} ▶` }],
    };
}

/** Rows asked for past the end ("next" after the last page). */
const pastTheEnd = (paging: Paging | undefined, rows: number) => !!paging && paging.page > 1 && rows === 0;

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
import { fmtDate, fmtDay, statusLabel } from "@/lib/assistant/format";

/**
 * One list row. The title falls back shop → dealer → id; never empty. The
 * description is status · interest · next date · phone; when it is too long
 * the other parts are cut first, so the phone (prompt rule 19) always shows.
 */
export function leadRow(lead: LeadSummary): ListRow {
    const title = lead.shop_name?.trim() || lead.dealer_name?.trim() || lead.id;
    const phone = lead.phone?.trim() || null;
    const parts = [lead.status ? statusLabel(lead.status) : null, lead.interest, fmtDate(lead.next_date)].filter(
        Boolean,
    ) as string[];
    const sep = " · ";
    let description: string;
    if (!phone) description = fit(parts.join(sep), RENDER_LIMITS.rowDescription);
    else if (!parts.length) description = fit(phone, RENDER_LIMITS.rowDescription);
    else {
        const room = RENDER_LIMITS.rowDescription - phone.length - sep.length;
        description = room >= 4 ? `${fit(parts.join(sep), room)}${sep}${phone}` : fit(phone, RENDER_LIMITS.rowDescription);
    }
    return {
        id: `ast:lead:${lead.id}`,
        title: fit(title, RENDER_LIMITS.rowTitle),
        ...(description ? { description } : {}),
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

type LeadReport = Extract<ToolResult, { kind: "lead_report" }>;

/** The model's lead-in only (prompt rule 11 asks for one sentence) — the rows are ours. */
function firstLine(s: string): string {
    return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** One report line: "3. Kaycee Battery House (Malout) · 9896880001 · Awaiting field visit · Hot 13 days · last activity Wed 30 Sep". */
function reportLine(n: number, lead: LeadReport["rows"][number], level: string): string {
    const name = lead.shop_name?.trim() || lead.dealer_name?.trim() || lead.id;
    const parts = [
        `${n}. ${name}${lead.city ? ` (${lead.city})` : ""}`,
        lead.phone,
        lead.status ? statusLabel(lead.status) : null,
        `${level} ${lead.age_days} ${lead.age_days === 1 ? "day" : "days"}`,
        lead.last_activity_at ? `last activity ${fmtDay(lead.last_activity_at)}` : "no activity yet",
    ].filter(Boolean);
    return fit(parts.join(" · "), 200);
}

/**
 * The leads behind a Hot / Warm / Cold card as text (BRD §9.4: built from the
 * tool result, never from model wording). The heading always carries the exact
 * total; rows that don't fit are summarised as "+N more" with the CRM link, so
 * the count stays true even when the list is cut.
 */
export function renderLeadReport(report: LeadReport, lead: string, max: number = RENDER_LIMITS.report): string {
    return layoutLeadReport(report, lead, max).text;
}

/** renderLeadReport, plus how many rows made it in (a page cut short gets no "Next"). */
function layoutLeadReport(report: LeadReport, lead: string, max: number): { text: string; shown: number } {
    const level = report.title.split(" ")[0] ?? "";
    const head = `*${report.title} — ${report.total}*\n(${report.definition})`;
    const intro = lead ? `${lead}\n\n` : "";
    if (pastTheEnd(report.paging, report.rows.length)) {
        return { text: fit(`${intro}No more ${report.title.toLowerCase()} — that was the whole list.`, max), shown: 0 };
    }
    if (report.total === 0) return { text: fit(`${intro}${head}\n\nNone right now.`, max), shown: 0 };
    // Page 2 numbers its lines 11, 12, … so they match the CRM's order.
    const { from } = range(report.paging, 0);
    const lines = report.rows.map((r, i) => reportLine(from + i, r, level));
    const tail = (shown: number) => {
        const left = report.total - (from - 1) - shown;
        return left > 0 ? `\n\n+${left} more${report.crm_url ? `: ${report.crm_url}` : ""}` : "";
    };
    let shown = lines.length;
    const body = () => `${intro}${head}\n\n${lines.slice(0, shown).join("\n")}${tail(shown)}`;
    while (shown > 0 && body().length > max) shown--;
    return { text: fit(body(), max), shown };
}

/** Every number in a line ("5 hot leads", "2 of 7"). */
function numbersIn(s: string): number[] {
    return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(",", "")));
}

/**
 * A model line may stand next to our rows only if each number in it is one
 * of the true totals: "You have 5 hot leads" over a report of 7 is dropped.
 * A line with no number passes.
 */
function countsAgree(line: string, totals: number[]): boolean {
    return numbersIn(line).every((n) => totals.includes(n));
}

/** Does a model line just repeat one of the rows (its name or phone, or a numbered item)? */
function repeatsRow(line: string, rows: LeadSummary[]): boolean {
    if (/^\s*(\d+[.)]|[-•*])\s/.test(line)) return true;
    const l = line.toLowerCase();
    return rows.some((r) => {
        const name = (r.shop_name?.trim() || r.dealer_name?.trim() || "").toLowerCase();
        const phone = r.phone?.replace(/\D/g, "") ?? "";
        return (name.length >= 3 && l.includes(name)) || (phone.length >= 6 && line.replace(/\D/g, "").includes(phone));
    });
}

/**
 * Every lead report of the turn (hot AND warm when both were asked), each with
 * its own heading and exact total, within RENDER_LIMITS.report together. The
 * model's lines stay above them unless they repeat a row or state a count the
 * reports don't.
 */
function renderLeadReports(reports: LeadReport[], text: string): WaPayload {
    const totals = reports.map((r) => r.total);
    const rows = reports.flatMap((r) => r.rows);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const kept = lines.filter((l, i) => (i === 0 || !repeatsRow(l, rows)) && countsAgree(l, totals));
    const intro = fit(kept.join("\n"), 300);
    const gap = 2; // "\n\n" between reports
    const room = RENDER_LIMITS.report - (intro ? intro.length + gap : 0) - gap * (reports.length - 1);
    const each = Math.floor(room / reports.length);
    const parts = reports.map((r) => layoutLeadReport(r, "", each));
    const body = fit([intro, ...parts.map((p) => p.text)].filter(Boolean).join("\n\n"), RENDER_LIMITS.report);
    // "Next 10" only under a single report: two reports share the room and are
    // usually cut short, so their "+N more" CRM link is the way to the rest.
    const followUp =
        reports.length === 1 ? nextPageFollowUp("my_leads_by_temperature", reports[0], parts[0].shown) : null;
    return followUp ? { kind: "text", body, followUp } : { kind: "text", body };
}

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
        // A question card (ID 137) answers Yes / No and has nothing to edit.
        buttons: [
            { id: `ast:c:${actionId}`, title: preview.answers?.confirm ?? "Confirm" },
            ...(opts.edit === false || preview.answers ? [] : [{ id: `ast:e:${actionId}`, title: "Edit" }]),
            { id: `ast:x:${actionId}`, title: preview.answers?.cancel ?? "Cancel" },
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
    duplicate_phone:
        "A lead with this phone number was added meanwhile, so nothing was saved. Ask me to add it again to record a Re-inquiry on it.",
    target_unavailable: "That person is no longer active, so nothing was saved. Pick someone else.",
    visit_booked: "The ASM has a visit booked on this lead, so nothing was saved. Cancel or complete the visit first.",
    already_transferred: "This lead was already transferred to an ASM, so nothing was saved.",
    attachment_used: "That photo or file was already used for another change, so nothing was saved. Send it again.",
    // Only without the writer's sentence (an old row); normally `message` carries it.
    refused: "The CRM refused this change, so nothing was saved.",
};

/** A refusal after Confirm: the CRM writer's own sentence when there is one, else the reason's. */
function renderRejected(o: Extract<ExecOutcome, { kind: "rejected" }>): string {
    const said = o.message?.trim();
    if (!said) return REJECTED[o.reason];
    return fit(`${/[.!?]$/.test(said) ? said : `${said}.`} Nothing was saved.`, RENDER_LIMITS.text);
}

/**
 * A confirmed write. After a conversion the reply OFFERS the dealer invite as a
 * button — it only proposes; the invite has its own preview and Confirm. The
 * invite itself reports whether WhatsApp accepted the send.
 */
function renderConfirmed(o: Extract<ExecOutcome, { kind: "confirmed" }>): WaPayload {
    const saved = fit(`✅ Saved: ${o.title.replace(/^\*|\*$/g, "")}\n${o.crmUrl}`, RENDER_LIMITS.text);
    // ID 137 — the card's title is the question; the answer reads as what happened.
    if (o.tool === "record_reinquiry") {
        // The rep is not "told" about their own lead; a lead with no owner has only the Sales Head.
        const told =
            o.after.owner_is_actor === true || !o.after.current_owner_id
                ? "The Sales Head has been told."
                : "The lead's owner and the Sales Head have been told.";
        return { kind: "text", body: fit(`✅ Re-inquiry recorded. ${told}\n${o.crmUrl}`, RENDER_LIMITS.text) };
    }
    if (o.tool === "invite_dealer_onboarding") {
        if (o.extra?.delivered === true) return { kind: "text", body: `✅ Onboarding invite sent to the dealer.\n${o.crmUrl}` };
        const why = String(o.extra?.error ?? "WhatsApp send failed");
        return {
            kind: "text",
            body: fit(`⚠️ The invite could not be sent (${why}). Try again, or use Invite on WhatsApp in the CRM.\n${o.crmUrl}`, RENDER_LIMITS.text),
        };
    }
    // ID 79: the writer found the screenshot already used when it saved (the
    // card may have been built before the other entry was).
    if (o.tool === "log_call" && o.after.screenshot_reused === true) {
        return {
            kind: "text",
            body: withLink(
                "⚠️ Saved as a note. That screenshot was already used on another entry, so this chat is NOT counted as contact.",
                o.crmUrl,
            ),
        };
    }
    if (o.tool === "create_quote") return { kind: "text", body: renderQuoteSaved(o) };
    if (o.tool === "send_quote") return { kind: "text", body: renderQuoteSent(o) };
    if (o.tool === "withdraw_quote") return { kind: "text", body: renderQuoteWithdrawn(o) };
    if (o.tool === "mark_converted" && o.leadId) {
        return {
            kind: "buttons",
            body: fit(`${saved}\n\nSend the dealer the WhatsApp onboarding invite?`, RENDER_LIMITS.previewBody),
            buttons: [{ id: `ast:inv:${o.leadId}`, title: "Send invite" }],
        };
    }
    return { kind: "text", body: saved };
}

/** A reply line plus the lead's CRM link — the link is never the part that gets cut. */
function withLink(body: string, url: string): string {
    return `${fit(body, RENDER_LIMITS.text - url.length - 1)}\n${url}`;
}

/** create_quote confirmed: what the gate decided, and what the rep can do next. */
function renderQuoteSaved(o: Extract<ExecOutcome, { kind: "confirmed" }>): string {
    const v = typeof o.after.quote_version === "number" ? ` v${o.after.quote_version}` : "";
    const qn = typeof o.extra?.quote_number === "string" ? o.extra.quote_number : null;
    const body =
        o.after.auto_approved === true
            ? qn
                ? `✅ Quote${v} saved and auto-approved. PDF ${qn} is ready — say "send quote" to send it to the dealer.`
                : `✅ Quote${v} saved and auto-approved, but the PDF could not be made yet. Regenerate it on the CRM screen before sending.`
            : `⏳ Quote${v} saved — waiting for CEO approval. It can be sent once approved; ask "quote status" to check.`;
    return withLink(body, o.crmUrl);
}

/** withdraw_quote confirmed: what was closed, and what it did to the lead (ID 78). */
function renderQuoteWithdrawn(o: Extract<ExecOutcome, { kind: "confirmed" }>): string {
    const qn = typeof o.after.quote_number === "string" ? `${o.after.quote_number} ` : "";
    const live = o.after.live_quote_version;
    const tail =
        typeof live === "number"
            ? ` v${live} is still live, so the lead's status is unchanged.`
            : o.after.lead_status === "Under_Discussion"
              ? " The lead is back to Under discussion."
              : "";
    return withLink(`✅ Quote ${qn}withdrawn. The dealer can no longer answer it.${tail}`, o.crmUrl);
}

/** send_quote confirmed: per-channel delivery, never "sent" for a channel that failed. */
function renderQuoteSent(o: Extract<ExecOutcome, { kind: "confirmed" }>): string {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const sent = list(o.extra?.sent);
    const failed = list(o.extra?.failed);
    const qn = typeof o.extra?.quote_number === "string" ? `${o.extra.quote_number} ` : "";
    const name = (c: string) => (c === "email" ? "email" : "WhatsApp");
    let body: string;
    if (!o.extra) body = "⚠️ The send could not be confirmed. Check the lead's history before sending again.";
    else if (sent.length && !failed.length) body = `✅ Quotation ${qn}sent to the dealer on ${sent.map(name).join(" and ")}.`;
    else if (sent.length) body = `⚠️ Quotation ${qn}sent on ${sent.map(name).join(" and ")}, but ${failed.map(name).join(" and ")} failed.`;
    else body = `⚠️ The quotation was not sent${o.extra.error ? ` (${String(o.extra.error)})` : ""}. Try again, or use Send on the CRM screen.`;
    return withLink(body, o.crmUrl);
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
        case "send_failed":
            return text("That send didn't go through, and this card can't be used again. Ask me again for a new card to retry.");
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
            return text(renderRejected(o));
        case "error":
            return text("Something went wrong, nothing was changed. Please try again.");
    }
}

/**
 * Said only when the turn ended without the model's words AND no tool result
 * answers on its own — one per cause. Never "send a shorter message": the
 * message was rarely the problem.
 */
export const SORRY: Record<Exclude<AgentStop, "done">, string> = {
    timeout: "That took too long — please try again.",
    cap: "Sorry, I couldn't work that out. Please try again, or ask one thing at a time.",
    empty: "Sorry, I didn't get an answer just now. Please try again.",
};

type ListResult = Extract<ToolResult, { kind: "leads" | "candidates" }>;

/** A list's body: our first line (the true count / the question), the model's line only if its counts agree. */
function listBody(first: string, text: string, totals: number[]): string {
    const line = firstLine(text);
    return line && line !== first && countsAgree(line, totals) ? `${first}\n${line}` : first;
}

/** "Hot leads: 23" — plus " · showing 11–20" when the list is longer than this page. */
function countLine(label: string, total: number, paging: Paging | undefined, shown: number): string {
    if (total <= shown) return `${label}: ${total}`;
    const { from, to } = range(paging, shown);
    return `${label}: ${total} · showing ${from}–${to}`;
}

function renderList(r: ListResult, text: string, tool: string): WaPayload {
    const rows = r.rows.slice(0, RENDER_LIMITS.rows);
    const total = r.kind === "leads" ? r.total : (r.total ?? r.rows.length);
    let first: string;
    if (r.kind === "leads") first = countLine(r.title, r.total, r.paging, rows.length);
    else if (total > rows.length) {
        const { from, to } = range(r.paging, rows.length);
        first = `${r.question} (showing ${from}–${to})`;
    } else first = r.question;
    let body = listBody(first, text, r.kind === "leads" ? [r.total] : [total, r.rows.length]);
    const followUp = nextPageFollowUp(tool, { total, paging: r.paging, crm_url: r.crm_url }, rows.length);
    // The CRM link rides on the "Next" message when there is one.
    if (!followUp && total > rows.length && r.crm_url) {
        const more = `\n\nAll ${total}: ${r.crm_url}`;
        if (body.length + more.length <= RENDER_LIMITS.listBody) body += more;
    }
    return {
        kind: "list",
        header: fit(r.kind === "leads" ? r.title : "Which one?", RENDER_LIMITS.header),
        body: fit(body, RENDER_LIMITS.listBody),
        button: LIST_BUTTON,
        rows: rows.map(leadRow),
        ...(followUp ? { followUp } : {}),
    };
}

// ── Products ────────────────────────────────────────────────────────────────

type ProductsResult = Extract<ToolResult, { kind: "products" }>;

export const PRODUCT_TYPES = ["battery", "charger", "paraphernalia"] as const;
const PRODUCT_TYPE_LABEL: Record<ProductSummary["asset_type"], string> = {
    battery: "Battery",
    charger: "Charger",
    paraphernalia: "Paraphernalia",
};

/** One product row: name, then model · spec. No price (the OEM floor stays with the CEO). */
export function productRow(p: ProductSummary): ListRow {
    const description = fit([p.model_id, p.detail].filter((x) => x && x.trim()).join(" · "), RENDER_LIMITS.rowDescription);
    return {
        id: `ast:prod:${p.asset_type}:${p.product_id}`,
        title: fit(p.product_name?.trim() || p.model_id || p.product_id, RENDER_LIMITS.rowTitle),
        ...(description ? { description } : {}),
    };
}

/**
 * The catalogue as something to TAP, never as model text: a list of up to 10
 * (with "Next" under it), or — when the whole catalogue is asked for and is
 * bigger than one list — the product types first.
 */
export function renderProducts(r: ProductsResult): WaPayload {
    if (pastTheEnd(r.paging, r.rows.length)) return { kind: "text", body: "No more products — that was the whole list." };
    if (r.total === 0) {
        return { kind: "text", body: "No product in the CRM catalogue matches that. Try other words, or ask for the product list." };
    }
    const args = r.paging?.args ?? {};
    if (r.total > RENDER_LIMITS.rows && !args.asset_type && !args.query && (r.paging?.page ?? 1) === 1) {
        return {
            kind: "buttons",
            body: `There are ${r.total} products in the CRM catalogue. Which type?`,
            buttons: PRODUCT_TYPES.map((t) => ({ id: `ast:ptype:${t}`, title: PRODUCT_TYPE_LABEL[t] })),
        };
    }
    const rows = r.rows.slice(0, RENDER_LIMITS.rows);
    const type = PRODUCT_TYPE_LABEL[args.asset_type as ProductSummary["asset_type"]];
    const label = type ? `${type} products` : "Products";
    const followUp = nextPageFollowUp("product_catalogue", r, rows.length);
    return {
        kind: "list",
        header: fit(label, RENDER_LIMITS.header),
        body: fit(`${countLine(label, r.total, r.paging, rows.length)}\nTap one to choose it.`, RENDER_LIMITS.listBody),
        button: "Choose product",
        rows: rows.map(productRow),
        ...(followUp ? { followUp } : {}),
    };
}

/** The reply to a tapped product: what was chosen, and what the quote still needs. */
export function renderProductPicked(p: ProductSummary | null): WaPayload {
    if (!p) return { kind: "text", body: "That product is no longer in the CRM catalogue. Ask for the product list again." };
    const model = p.model_id && p.model_id !== p.product_name ? ` (${p.model_id})` : "";
    return {
        kind: "text",
        body: fit(
            `✔ ${p.product_name}${model} chosen.\nKitni quantity, aur price per unit (₹, GST se pehle)? Lead ka naam bhi batayein agar abhi tak nahi bataya.`,
            RENDER_LIMITS.text,
        ),
    };
}

/**
 * The reply for one agent turn. A write preview (if any) wins and is sent with
 * its buttons, the model's wording dropped (plus "Next: …" when the one-change
 * limit held a second write back). Otherwise the NEWEST result that answers
 * decides the shape, built from the result, not from the model's wording:
 *   lead_report → every report of the turn, as text
 *   leads (2+ rows) / candidates → a tappable list whose first body line is
 *     the true total (or the question)
 *   lead → the model's answer about it, or the lead card when it gave none
 *   products → a list to tap (or the product types first, for the whole
 *     catalogue) — never product names typed out by the model
 * A page that isn't the last carries a "Next 10" follow-up message.
 * With no such result the model's text is the reply; with no text either, a
 * question / refusal / not-found result speaks for itself, and only when
 * nothing answered is it a per-cause SORRY.
 */
export function renderTurn(turn: {
    text: string;
    results: { tool: string; result: ToolResult }[];
    stop?: AgentStop;
    next?: string | null;
}): WaPayload {
    const last = [...turn.results].reverse().find((r) => r.result.kind === "preview");
    if (last?.result.kind === "preview") {
        // A send has nothing to edit: it goes to the lead's own phone / email.
        const card = renderPreview(last.result.preview, last.result.action_id, { edit: last.tool !== "send_quote" });
        if (turn.next && card.kind === "buttons") {
            const room = RENDER_LIMITS.previewBody - card.body.length - 1;
            if (room >= 12) return { ...card, body: `${card.body}\n${fit(turn.next, room)}` };
        }
        return card;
    }
    const text = whatsappText(turn.text);
    const results = turn.results.map((r) => r.result);
    // The newest answering result wins: a lead opened after a search, a report after a list, and vice versa.
    const answerAt = [...turn.results]
        .reverse()
        .find(
            ({ result: r }) =>
                r.kind === "lead_report" || r.kind === "leads" || r.kind === "candidates" || r.kind === "lead" || r.kind === "products",
        );
    const answer = answerAt?.result;
    const tool = answerAt?.tool ?? "";
    if (answer?.kind === "lead_report") {
        return renderLeadReports(results.filter((r): r is LeadReport => r.kind === "lead_report"), text);
    }
    if (answer?.kind === "products") {
        // One clear match reads better as the model's answer about it (it asks
        // for quantity and price); otherwise the rep picks from the list.
        if (answer.rows.length === 1 && text && (answer.paging?.page ?? 1) === 1) {
            return { kind: "text", body: fit(text, RENDER_LIMITS.text) };
        }
        return renderProducts(answer);
    }
    if (answer?.kind === "lead") {
        return { kind: "text", body: text ? fit(text, RENDER_LIMITS.text) : renderLeadCard(answer.lead as Detail) };
    }
    if (answer?.kind === "candidates" && answer.rows.length > 0) return renderList(answer, text, tool);
    if (answer?.kind === "leads") {
        if (pastTheEnd(answer.paging, answer.rows.length)) return { kind: "text", body: "No more leads — that was the whole list." };
        // One row reads better as the model's answer about it; without one, it is still a list.
        if (answer.rows.length >= 2 || (!text && answer.rows.length === 1)) return renderList(answer, text, tool);
        if (!text) {
            const more = answer.total > 0 && answer.crm_url ? `\n${answer.crm_url}` : "";
            return { kind: "text", body: fit(`${answer.title}: ${answer.total}${more}`, RENDER_LIMITS.text) };
        }
    }
    if (text) return { kind: "text", body: fit(text, RENDER_LIMITS.text) };

    // No words from the model: a result that speaks for itself, else sorry.
    const said = [...results]
        .reverse()
        .find((r) => r.kind === "question" || r.kind === "declined" || r.kind === "not_found" || r.kind === "unavailable");
    if (said?.kind === "question") return { kind: "text", body: fit(said.question, RENDER_LIMITS.text) };
    if (said?.kind === "declined") {
        return { kind: "text", body: said.crm_url ? withLink(said.reason, said.crm_url) : fit(said.reason, RENDER_LIMITS.text) };
    }
    if (said?.kind === "not_found") return { kind: "text", body: "I couldn't find that lead." };
    if (said?.kind === "unavailable") return { kind: "text", body: fit(said.message, RENDER_LIMITS.text) };
    return { kind: "text", body: turn.stop && turn.stop !== "done" ? SORRY[turn.stop] : "Done." };
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
            `Status: ${statusLabel(str(lead.status))}`,
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
