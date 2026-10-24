/**
 * Tracker IDs 186, 179 and 118 (18 Oct) — source-text contract for the server
 * rules the routes enforce. The routes import the database, so this reads
 * their source (same style as id119-owner-gates.contract.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canEditLead, canReassignToIsr } from "@/lib/leads/access";

const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), "src", ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const route = (r: string) => read("app", "api", ...r.split("/"), "route.ts");

describe("ID 186 — a brand-new dealer's quote needs the deal card (server)", () => {
  const src = route("inside-sales/lead/[id]/commercials");

  it("the quote save decides with dealCardRequired and the onboarded check, not the role alone", () => {
    expect(src).toMatch(/const dealerOnboarded = isQuote \? \(await isDealerOnboarded\(id\)\)\.onboarded : undefined;/);
    expect(src).toMatch(/dealCardRequired\(\{ role: user\.role, dealerOnboarded: !!dealerOnboarded \}\)/);
    expect(src).toMatch(/requireDealCard,/);
    // 22 Oct: the onboarded answer also picks the refusal text (dealCardMissingMessage).
    expect(src).toMatch(/dealerOnboarded,\s*\}\)/);
    expect(src).not.toMatch(/requireDealCard: dealCardRequiredFor\(/);
  });

  it("the WhatsApp quote uses the same helper and re-decides at Confirm", () => {
    const wa = read("lib", "assistant", "tools", "write", "createQuote.ts");
    expect(wa).toMatch(/dealCardRequired\(\{ role: ctx\.user\.role, dealerOnboarded:/);
    expect(wa).toMatch(/requireDealCard: p\.deal_card\s*\?\s*true\s*:\s*dealCardRequired\(/);
    expect(wa).not.toMatch(/requireDealCard: true,/);
  });
});

describe("ID 179 — Reassign to ISR: Admin, Sales Head and CEO only", () => {
  it("not the partner login", () => {
    expect(canReassignToIsr("partner")).toBe(false);
    for (const r of ["admin", "sales_head", "ceo"]) expect(canReassignToIsr(r)).toBe(true);
  });

  it("the bulk route refuses a reassign to an inside-sales rep for any other role", () => {
    expect(route("admin/leads/bulk")).toMatch(
      /if \(target\.role === "inside_sales_rep" && !canReassignToIsr\(user\.role\)\) \{\s*return errorResponse\([^)]*, 403\)/,
    );
  });

  it("the lead page shows the button by the same rule", () => {
    expect(read("app", "(dashboard)", "inside-sales", "lead", "[id]", "_components", "LeadActionBar.tsx")).toMatch(
      /canReassignToIsr\(viewerRole\)/,
    );
  });

  it("WhatsApp visit notices go to the transfer watchers (the rep who owned the lead too)", () => {
    const src = read("lib", "assistant", "tools", "write", "logVisit.ts");
    expect(src).toMatch(/for \(const watcher of await transferWatchers\(input\.leadId\)\)/);
    expect(src).not.toMatch(/lastTransferredBy\(/);
  });

  it.each([
    ["lib", "admin", "isrScorecard.ts"],
    ["lib", "targets", "service.ts"],
    ["lib", "digests", "salesDailyBlocks.ts"],
    ["lib", "digests", "salesDailyBlockA.ts"],
  ])("'Hot to field' counts only the first move to the field: %s/%s/%s", (...p) => {
    expect(read(...p)).toMatch(/firstMoveToField\(\)/);
  });
});

describe("ID 118 item 2 — NeoDove and manual calls refresh the Overall Summary", () => {
  it("writeTouchpoint schedules it for call touchpoints (NeoDove after its evidence)", () => {
    expect(read("lib", "touchpoints", "write.ts")).toMatch(
      /if \(refreshOnTouchpointWrite\(input\.touchpointType, input\.externalSystem\)\) \{\s*scheduleOverallSummaryRefresh\(input\.dealerLeadId\)/,
    );
  });

  it("attachCallEvidence gets the lead id from both callers and schedules the refresh", () => {
    const inbound = read("lib", "neodove", "inbound.ts");
    expect(inbound).toMatch(/await attachCallEvidence\(touchpointId, event, dealerLeadId\)/);
    expect(inbound).toMatch(/scheduleOverallSummaryRefresh\(dealerLeadId\)/);
    expect(route("neodove/reconcile")).toMatch(/await attachCallEvidence\(touchpointId, event, dealerLeadId\)/);
  });

  it("the summary reads human calls, not only ai_call_logs", () => {
    const src = read("lib", "leads", "overallSummary.ts");
    expect(src).toMatch(/touchpoint_type = 'inside_sales_call'/);
    expect(src).toMatch(/FROM lead_call_recordings/);
  });

  it("developer check: Sales Insight asking for the summary of a lead it does not own is refused", () => {
    expect(canEditLead({ role: "sales_insight", userId: "u-1", currentOwnerId: "u-2", asmId: null })).toBe(false);
    expect(canEditLead({ role: "sales_insight", userId: "u-1", currentOwnerId: "u-1", asmId: null })).toBe(true);
    const src = route("leads/[id]/summary");
    expect(src).toMatch(/!canEditLead\(\{ role: user\.role, userId: user\.id, currentOwnerId: lead\.current_owner_id, asmId: lead\.asm_id \}\)/);
    expect(src).toMatch(/status: 404/);
    // The refresh (which reads the lead's calls) runs only after that check.
    expect(src.indexOf("canEditLead(")).toBeLessThan(src.indexOf("refreshOverallSummary(id)"));
  });
});
