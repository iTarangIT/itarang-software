// LinkedIn Outreach — the pure rules behind the acceptance tests in
// tasks/linkedin-outreach-dev-plan.md §11. No I/O.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractJson } from "../agent/llm";
import { parseDraft } from "../agent/reply-draft";
import { parseScores } from "../agent/scoring";
import { approvalHashes, checkApproval, NO_ATTACHMENT, sha256 } from "../lib/hash";
import { normaliseProfileUrl, parseLinkedInTitle } from "../lib/profile-url";
import { firstNameOf, renderTemplate } from "../lib/render-template";
import { connectionFromProfile, healthFromError } from "../providers/messaging/unipile.provider";
import { mapBrightDataRecord, parseBrightDataPayload } from "../providers/search/brightdata.provider";
import { discoveryQuery, hitsToProfiles } from "../providers/search/discovery";
import {
  canAct,
  DEFAULT_SETTINGS,
  gapFor,
  inSendingWindow,
  inviteCap,
  inviteExpired,
  istDayStart,
  pollDue,
  randomGapMs,
} from "../services/pacing";
import { kpis } from "../services/kpis";
import { LIVE_STATES, nextState, PROSPECT_STATES, TERMINAL_STATES, type ProspectState } from "../state/prospect-state";

// IST = UTC+05:30. 2026-11-23 is a Monday.
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe("prospect state machine (doc §6.2)", () => {
  it("walks the connected path", () => {
    let s: ProspectState = "selected";
    for (const e of ["approve", "enqueue", "message_sent", "seen", "replied"] as const) s = nextState(s, e)!;
    expect(s).toBe("replied");
  });
  it("walks the not-connected path: invite first, message only after acceptance", () => {
    expect(nextState("queued", "invite_sent")).toBe("invite_sent");
    expect(nextState("invite_sent", "message_sent")).toBeNull();
    expect(nextState("invite_sent", "accepted")).toBe("accepted");
    expect(nextState("accepted", "message_sent")).toBe("message_sent");
  });
  it("a reply at any live point stops automatic sends", () => {
    for (const s of ["queued", "invite_sent", "accepted", "message_sent", "seen"] as ProspectState[]) {
      expect(nextState(s, "replied")).toBe("replied");
    }
  });
  it("terminal states accept no event", () => {
    for (const s of TERMINAL_STATES) {
      for (const e of ["approve", "enqueue", "invite_sent", "message_sent", "replied", "stop", "fail"] as const) {
        expect(nextState(s, e)).toBeNull();
      }
    }
  });
  it("voiding an approval returns unsent rows to selected, not sent ones", () => {
    expect(nextState("approved", "void")).toBe("selected");
    expect(nextState("queued", "void")).toBe("selected");
    expect(nextState("invite_sent", "void")).toBeNull();
  });
  it("invite expiry only from invite_sent", () => {
    expect(nextState("invite_sent", "expire")).toBe("invite_expired");
    expect(nextState("queued", "expire")).toBeNull();
  });
  it("LIVE_STATES matches the migration's one-live-campaign index", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle", "E-393_linkedin_outreach.sql"), "utf8");
    const m = /li_campaign_prospects_one_live_uniq[\s\S]*?WHERE state IN \(([^)]+)\)/.exec(sql);
    expect(m).not.toBeNull();
    const inSql = m![1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(new Set(inSql)).toEqual(new Set(LIVE_STATES));
    for (const s of LIVE_STATES) expect(PROSPECT_STATES).toContain(s);
  });
});

describe("merge fields (doc §6.1)", () => {
  it("renders the four v1 fields", () => {
    const r = renderTemplate("Hi {{first_name}} at {{ company }}, {{headline}} in {{city}}", {
      first_name: "Asha",
      company: "Zippee",
      headline: "Fleet Ops",
      city: "Pune",
    });
    expect(r).toEqual({ text: "Hi Asha at Zippee, Fleet Ops in Pune", missing: [] });
  });
  it("flags a missing value and an unknown field", () => {
    const r = renderTemplate("Hi {{first_name}} from {{company}} {{phone}}", { first_name: "Asha", company: "  " });
    expect(r.missing.sort()).toEqual(["company", "phone"]);
  });
  it("first name skips honorifics", () => {
    expect(firstNameOf("Dr. Asha Rao")).toBe("Asha");
    expect(firstNameOf("Ravi Kumar")).toBe("Ravi");
    expect(firstNameOf("")).toBeNull();
  });
});

describe("approval gate (R7, acceptance test 1)", () => {
  const approved = approvalHashes({ template: "Hi {{first_name}}", inviteNote: "Let's connect", attachmentSha256: "abc" });
  it("passes when nothing changed", () => {
    expect(checkApproval({ approval: approved, current: { ...approved }, frozen: "Hi Asha", fresh: "Hi Asha" }).ok).toBe(true);
  });
  it("refuses with no approval or a voided one", () => {
    expect(checkApproval({ approval: null, current: approved }).ok).toBe(false);
    expect(checkApproval({ approval: { ...approved, voided_at: new Date() }, current: approved }).ok).toBe(false);
  });
  it("refuses when text, note or attachment changed after approval", () => {
    const text = approvalHashes({ template: "Hi {{first_name}}!", inviteNote: "Let's connect", attachmentSha256: "abc" });
    const note = approvalHashes({ template: "Hi {{first_name}}", inviteNote: "Hello", attachmentSha256: "abc" });
    const file = approvalHashes({ template: "Hi {{first_name}}", inviteNote: "Let's connect", attachmentSha256: "def" });
    for (const current of [text, note, file]) expect(checkApproval({ approval: approved, current }).ok).toBe(false);
  });
  it("refuses when the frozen per-prospect text was tampered with", () => {
    const r = checkApproval({ approval: approved, current: approved, frozen: "Hi Asha, buy now", fresh: "Hi Asha" });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("rendered") });
  });
  it("no attachment hashes to a fixed marker", () => {
    expect(approvalHashes({ template: "x", inviteNote: null, attachmentSha256: null }).attachment_hash).toBe(NO_ATTACHMENT);
    expect(sha256("a")).toHaveLength(64);
  });
});

describe("pacing (doc §6.3, acceptance test 3)", () => {
  const s = DEFAULT_SETTINGS;
  it("sending hours are 10:00–18:30 IST, Monday to Saturday", () => {
    expect(inSendingWindow(s, ist("2026-11-23T09:59:00"))).toBe(false);
    expect(inSendingWindow(s, ist("2026-11-23T10:00:00"))).toBe(true);
    expect(inSendingWindow(s, ist("2026-11-23T18:29:00"))).toBe(true);
    expect(inSendingWindow(s, ist("2026-11-23T18:30:00"))).toBe(false);
    expect(inSendingWindow(s, ist("2026-11-28T12:00:00"))).toBe(true); // Saturday
    expect(inSendingWindow(s, ist("2026-11-29T12:00:00"))).toBe(false); // Sunday
  });
  it("the cap day starts at IST midnight", () => {
    expect(istDayStart(ist("2026-11-23T00:10:00")).toISOString()).toBe("2026-11-22T18:30:00.000Z");
    expect(istDayStart(ist("2026-11-23T23:50:00")).toISOString()).toBe("2026-11-22T18:30:00.000Z");
  });
  it("warm-up: 5 then 10 then the full cap", () => {
    const start = ist("2026-11-01T10:00:00");
    expect(inviteCap(s, start, ist("2026-11-03T10:00:00"))).toBe(5);
    expect(inviteCap(s, start, ist("2026-11-10T10:00:00"))).toBe(10);
    expect(inviteCap(s, start, ist("2026-11-20T10:00:00"))).toBe(15);
    expect(inviteCap(s, null, ist("2026-11-03T10:00:00"))).toBe(15);
  });
  it("caps come from the counted log, so a restart cannot exceed them", () => {
    const base = { settings: s, warmupStartedAt: null, lastActionAt: null, gapMs: 0, now: ist("2026-11-23T11:00:00") };
    expect(canAct({ ...base, action: "invite", counts: { invites: 14, messages: 0 } }).ok).toBe(true);
    expect(canAct({ ...base, action: "invite", counts: { invites: 15, messages: 0 } })).toEqual({ ok: false, reason: "invite_cap" });
    expect(canAct({ ...base, action: "message", counts: { invites: 0, messages: 30 } })).toEqual({ ok: false, reason: "message_cap" });
    expect(canAct({ ...base, action: "invite", counts: { invites: 0, messages: 0 }, now: ist("2026-11-23T20:00:00") })).toEqual({
      ok: false,
      reason: "outside_hours",
    });
  });
  it("the random gap is 3–9 minutes and stable per last action", () => {
    expect(randomGapMs(s, () => 0)).toBe(3 * 60_000);
    expect(randomGapMs(s, () => 1)).toBe(9 * 60_000);
    const g = gapFor(s, "acct:42");
    expect(g).toBe(gapFor(s, "acct:42"));
    expect(g).toBeGreaterThanOrEqual(3 * 60_000);
    expect(g).toBeLessThanOrEqual(9 * 60_000);
    const now = ist("2026-11-23T11:00:00");
    expect(
      canAct({ settings: s, action: "invite", counts: { invites: 0, messages: 0 }, warmupStartedAt: null, lastActionAt: new Date(now.getTime() - 60_000), gapMs: g, now }),
    ).toEqual({ ok: false, reason: "too_soon" });
  });
  it("poll runs every 45 minutes, inside sending hours only", () => {
    const now = ist("2026-11-23T12:00:00");
    expect(pollDue(s, null, now)).toBe(true);
    expect(pollDue(s, new Date(now.getTime() - 30 * 60_000), now)).toBe(false);
    expect(pollDue(s, new Date(now.getTime() - 46 * 60_000), now)).toBe(true);
    expect(pollDue(s, null, ist("2026-11-23T22:00:00"))).toBe(false);
  });
  it("invites expire after 21 days", () => {
    const sent = ist("2026-11-01T10:00:00");
    expect(inviteExpired(s, sent, ist("2026-11-21T10:00:00"))).toBe(false);
    expect(inviteExpired(s, sent, ist("2026-11-22T10:00:00"))).toBe(true);
  });
});

describe("dedupe key (acceptance test 6)", () => {
  it("normalises host, case, trailing slash and tracking params", () => {
    const a = normaliseProfileUrl("https://in.linkedin.com/in/Asha-Rao-12ab/?trk=public");
    const b = normaliseProfileUrl("linkedin.com/in/asha-rao-12ab");
    expect(a).toEqual({ profileId: "asha-rao-12ab", publicUrl: "https://www.linkedin.com/in/asha-rao-12ab" });
    expect(b).toEqual(a);
  });
  it("rejects non-profile and non-LinkedIn URLs", () => {
    expect(normaliseProfileUrl("https://www.linkedin.com/company/itarang")).toBeNull();
    expect(normaliseProfileUrl("https://example.com/in/asha")).toBeNull();
    expect(normaliseProfileUrl("")).toBeNull();
  });
  it("discovery dedupes hits and parses titles", () => {
    const p = hitsToProfiles([
      { url: "https://www.linkedin.com/in/asha-rao/", title: "Asha Rao - Fleet Manager - Zippee | LinkedIn" },
      { url: "https://in.linkedin.com/in/Asha-Rao", title: "dup" },
      { url: "https://www.linkedin.com/posts/x", title: "post" },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ fullName: "Asha Rao", firstName: "Asha", headline: "Fleet Manager", company: "Zippee" });
    expect(parseLinkedInTitle("Ravi K | LinkedIn").fullName).toBe("Ravi K");
    expect(discoveryQuery({ keywords: "EV fleet", location: "Pune", company: "Zippee" })).toBe('site:linkedin.com/in EV fleet "Zippee" Pune');
  });
});

describe("Bright Data mapping", () => {
  it("maps a people-profile record", () => {
    const r = mapBrightDataRecord({
      url: "https://www.linkedin.com/in/asha-rao",
      name: "Asha Rao",
      position: "Head of Ops",
      city: "Pune, Maharashtra",
      current_company: { name: "Zippee" },
    });
    expect(r).toMatchObject({ profileUrl: "https://www.linkedin.com/in/asha-rao", firstName: "Asha", company: "Zippee", headline: "Head of Ops" });
  });
  it("drops errors and accepts a single object payload", () => {
    expect(mapBrightDataRecord({ url: "https://www.linkedin.com/in/x", error: "dead" })).toBeNull();
    expect(parseBrightDataPayload({ url: "https://www.linkedin.com/in/x", name: "X Y" })).toHaveLength(1);
    expect(parseBrightDataPayload("nope")).toEqual([]);
  });
});

describe("Unipile signals (acceptance test 5)", () => {
  it("maps login challenges and restrictions to account health", () => {
    expect(healthFromError(401, "errors/disconnected_account")).toBe("challenge");
    expect(healthFromError(403, null, "checkpoint required")).toBe("challenge");
    expect(healthFromError(429, null)).toBe("restricted");
    expect(healthFromError(422, "errors/cannot_resend_yet")).toBeUndefined();
  });
  it("reads the connection degree", () => {
    expect(connectionFromProfile({ network_distance: "FIRST_DEGREE" })).toBe("connected");
    expect(connectionFromProfile({ network_distance: "SECOND_DEGREE", invitation: { status: "PENDING" } })).toBe("pending");
    expect(connectionFromProfile({ network_distance: "THIRD_DEGREE" })).toBe("none");
  });
});

describe("agent output parsing", () => {
  it("extracts JSON from fenced or chatty replies", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('here: {"scores":[]} thanks')).toEqual({ scores: [] });
    expect(extractJson("no json")).toBeNull();
  });
  it("clamps scores and ignores unknown ids", () => {
    const s = parseScores({ scores: [{ id: "a", score: 140, reason: "  great\nfit " }, { id: "zz", score: 50 }, { id: "b", score: "x" }] }, new Set(["a", "b"]));
    expect(s).toEqual([{ id: "a", score: 100, reason: "great fit" }]);
  });
  it("validates a draft", () => {
    expect(parseDraft({ draft: "Thanks!", sentiment: "Positive" })).toEqual({ draft: "Thanks!", sentiment: "positive" });
    expect(parseDraft({ draft: "" })).toBeNull();
  });
});

describe("KPIs (R4)", () => {
  it("acceptance, reply and positive-reply rates; Seen is not a KPI", () => {
    const d = new Date();
    const k = kpis(
      [
        { invite_sent_at: d, accepted_at: d, message_sent_at: d, replied_at: d },
        { invite_sent_at: d, accepted_at: null, message_sent_at: null, replied_at: null },
        { invite_sent_at: null, accepted_at: null, message_sent_at: d, replied_at: null },
      ],
      1,
    );
    expect(k).toMatchObject({ invited: 2, accepted: 1, messaged: 2, replied: 1, acceptance_pct: 50, reply_pct: 50, positive_reply_pct: 100 });
  });
});

describe("provider swap (acceptance test 7)", () => {
  it("only providers/ names a concrete provider class", () => {
    const root = join(process.cwd(), "src", "lib", "linkedin");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f !== "providers" && f !== "__tests__") walk(p);
        } else if (/\.tsx?$/.test(f) && /(BrightDataProvider|UnipileProvider|OpenLibProvider)\b|\.provider["']/.test(readFileSync(p, "utf8"))) {
          offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
