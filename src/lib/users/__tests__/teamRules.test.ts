import { describe, expect, it } from "vitest";
import {
    TEAM_TOTAL_PERSON,
    checkLineStart,
    checkReassignReason,
    checkTeamReassign,
    isIsoDate,
    ownerInScope,
    ownerScopeIds,
    pickPerformanceScope,
    pickScopedPerson,
} from "@/lib/users/teamRules";
import { canEditLead } from "@/lib/leads/access";

// ID 155 — Sonu manages two ASMs (a1, a2); x is someone else's rep.
const SONU = "sonu";
const TEAM = ["a1", "a2"];

describe("ownerScopeIds / ownerInScope (ID 155)", () => {
    it("is just yourself without a team", () => {
        expect(ownerScopeIds(SONU, [])).toEqual([SONU]);
        expect(ownerScopeIds(SONU, null)).toEqual([SONU]);
    });

    it("adds direct reports once, self first", () => {
        expect(ownerScopeIds(SONU, ["a1", "a2", "a1", SONU])).toEqual([SONU, "a1", "a2"]);
    });

    it("a manager reads their own and the team's leads, not others'", () => {
        expect(ownerInScope(SONU, SONU, TEAM)).toBe(true);
        expect(ownerInScope("a1", SONU, TEAM)).toBe(true);
        expect(ownerInScope("x", SONU, TEAM)).toBe(false);
        expect(ownerInScope(null, SONU, TEAM)).toBe(false);
    });

    it("a team member still reads only their own", () => {
        expect(ownerInScope("a2", "a1", [])).toBe(false);
        expect(ownerInScope(SONU, "a1", [])).toBe(false);
    });
});

describe("checkTeamReassign (ID 155)", () => {
    const base = { actorId: SONU, teamMemberIds: TEAM };

    it("moves a lead between two team members", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: "a1", targetUserId: "a2" })).toEqual({ ok: true });
    });

    it("lets the manager take it themself", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: "a1", targetUserId: SONU })).toEqual({ ok: true });
    });

    it("refuses a target outside the team", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: "a1", targetUserId: "x" })).toMatchObject({
            ok: false,
            reason: "target_outside_team",
        });
    });

    it("refuses a lead owned by someone outside the team, or nobody", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: "x", targetUserId: "a1" })).toMatchObject({ reason: "not_manager" });
        expect(checkTeamReassign({ ...base, currentOwnerId: null, targetUserId: "a1" })).toMatchObject({ reason: "not_manager" });
    });

    it("does not treat the manager's own lead as a team move", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: SONU, targetUserId: "a1" })).toMatchObject({ reason: "not_manager" });
    });

    it("refuses moving it to the person who already has it", () => {
        expect(checkTeamReassign({ ...base, currentOwnerId: "a1", targetUserId: "a1" })).toMatchObject({ reason: "same_owner" });
    });

    it("a team member has no team, so cannot move a colleague's lead", () => {
        expect(checkTeamReassign({ actorId: "a1", teamMemberIds: [], currentOwnerId: "a2", targetUserId: "a1" })).toMatchObject({
            reason: "not_manager",
        });
    });
});

describe("isIsoDate / checkLineStart (ID 155)", () => {
    it("reads only real YYYY-MM-DD dates", () => {
        expect(isIsoDate("2026-10-12")).toBe(true);
        expect(isIsoDate("2026-02-30")).toBe(false);
        expect(isIsoDate("12-10-2026")).toBe(false);
        expect(isIsoDate("")).toBe(false);
        expect(isIsoDate(null)).toBe(false);
    });

    const today = "2026-10-12";

    it("accepts today and a back-dated start", () => {
        expect(checkLineStart({ start: today, today, openFrom: null })).toEqual({ ok: true });
        expect(checkLineStart({ start: "2026-10-01", today, openFrom: null })).toEqual({ ok: true });
    });

    it("refuses a future start", () => {
        expect(checkLineStart({ start: "2026-10-13", today, openFrom: null })).toMatchObject({ ok: false });
    });

    it("refuses a start before the current line began, allows the same day", () => {
        expect(checkLineStart({ start: "2026-10-09", today, openFrom: "2026-10-10" })).toMatchObject({ ok: false });
        expect(checkLineStart({ start: "2026-10-10", today, openFrom: "2026-10-10" })).toEqual({ ok: true });
    });

    it("refuses a malformed date", () => {
        expect(checkLineStart({ start: "2026/10/12", today, openFrom: null })).toMatchObject({ ok: false });
    });
});

describe("pickScopedPerson (ID 155/156)", () => {
    it("shows a picked team member", () => {
        expect(pickScopedPerson(SONU, "a2", TEAM)).toBe("a2");
    });

    it("falls back to yourself for no pick or anyone outside the team", () => {
        expect(pickScopedPerson(SONU, null, TEAM)).toBe(SONU);
        expect(pickScopedPerson(SONU, "x", TEAM)).toBe(SONU);
        expect(pickScopedPerson("a1", SONU, [])).toBe("a1");
    });
});

describe("a manager sees + reassigns, never edits, a team lead (ID 155, decided 12 Oct)", () => {
    it("a manager may NOT edit a direct report's lead, even if a team list is passed along", () => {
        // A stray team list (old call shape) must not widen edit rights.
        const withTeam = { role: "asm", userId: SONU, currentOwnerId: "a1", asmId: null, teamMemberIds: TEAM } as Parameters<
            typeof canEditLead
        >[0];
        expect(canEditLead(withTeam)).toBe(false);
        expect(canEditLead({ role: "inside_sales_rep", userId: SONU, currentOwnerId: "a2", asmId: null })).toBe(false);
    });

    it("but may read it and move it within the team", () => {
        expect(ownerInScope("a1", SONU, TEAM)).toBe(true);
        expect(checkTeamReassign({ actorId: SONU, teamMemberIds: TEAM, currentOwnerId: "a1", targetUserId: "a2" })).toEqual({
            ok: true,
        });
    });

    it("their own lead stays editable", () => {
        expect(canEditLead({ role: "asm", userId: SONU, currentOwnerId: SONU, asmId: null })).toBe(true);
    });
});

describe("checkReassignReason (ID 155)", () => {
    it("needs at least the minimum once trimmed", () => {
        expect(checkReassignReason("Moving to Ravi, he covers Pune now", 20)).toEqual({
            ok: true,
            reason: "Moving to Ravi, he covers Pune now",
        });
        expect(checkReassignReason("   too short   ", 20)).toMatchObject({ ok: false });
        expect(checkReassignReason(" ".repeat(25), 20)).toMatchObject({ ok: false });
        expect(checkReassignReason(null, 20)).toMatchObject({ ok: false });
    });

    it("stores the trimmed text", () => {
        expect(checkReassignReason("  workload balancing across the team  ", 20)).toEqual({
            ok: true,
            reason: "workload balancing across the team",
        });
    });
});

describe("pickPerformanceScope — Team total (ID 156)", () => {
    it("Team total is the manager plus every direct report", () => {
        expect(pickPerformanceScope(SONU, TEAM_TOTAL_PERSON, TEAM)).toEqual({ spoc_id: null, spoc_ids: [SONU, "a1", "a2"] });
    });

    it("one team member, or yourself", () => {
        expect(pickPerformanceScope(SONU, "a1", TEAM)).toEqual({ spoc_id: "a1", spoc_ids: null });
        expect(pickPerformanceScope(SONU, null, TEAM)).toEqual({ spoc_id: SONU, spoc_ids: null });
        expect(pickPerformanceScope(SONU, "x", TEAM)).toEqual({ spoc_id: SONU, spoc_ids: null });
    });

    it("a team member asking for Team total gets only themself", () => {
        expect(pickPerformanceScope("a1", TEAM_TOTAL_PERSON, [])).toEqual({ spoc_id: "a1", spoc_ids: null });
        expect(pickPerformanceScope("a1", TEAM_TOTAL_PERSON, null)).toEqual({ spoc_id: "a1", spoc_ids: null });
    });
});
