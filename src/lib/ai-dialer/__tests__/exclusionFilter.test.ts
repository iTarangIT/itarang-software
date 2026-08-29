// Guard tests for the AI-dialer exclusion filter.
//
// The behaviour these pin down is not "the SQL string is spelled right" — a diff
// would show that. It is the one property that is invisible at the call site and
// expensive to get wrong:
//
//   AI_DIALABLE_SQL / aiDialableCondition() / isAiDialable() are SHARED with the
//   NeoDove **human** calling push. An AI-connected lead must keep flowing to the
//   human team — that is the "follow up manually" escape hatch the hard block's
//   own notice points at. The moment someone folds "has the AI already spoken to
//   this dealer?" into one of those three, the escape hatch closes silently and
//   nothing else in the codebase notices.
//
// isAiDialable also had no test at all before this file, so its four arms are
// pinned here too.

import { describe, expect, it } from "vitest";
import {
    AI_ATTEMPTED_PREDICATE,
    AI_CONNECTED_PREDICATE,
    AI_DIALABLE_PREDICATE,
    IN_LIVE_DIALER_QUEUE_PREDICATE,
    isAiDialable,
} from "@/lib/ai-dialer/exclusionFilter";

describe("AI_DIALABLE_PREDICATE — shared with the NeoDove human push", () => {
    it("tests only the Part-0 lifecycle columns", () => {
        expect(AI_DIALABLE_PREDICATE).toMatch(/lead_status/);
        expect(AI_DIALABLE_PREDICATE).toMatch(/ai_recall_status/);
    });

    // If this fails, someone has folded the AI-connected rule into the shared
    // predicate and AI-connected leads have stopped reaching the human calling
    // team. Put the rule in AI_NOT_YET_CONNECTED_SQL and opt in per call site.
    it("says nothing about AI call history", () => {
        expect(AI_DIALABLE_PREDICATE).not.toMatch(/ai_call_logs/i);
        expect(AI_DIALABLE_PREDICATE).not.toMatch(/transcript/i);
        expect(AI_DIALABLE_PREDICATE).not.toMatch(/dialer_campaign_leads/i);
    });
});

describe("isAiDialable — shared with the NeoDove human push", () => {
    // The escape hatch, asserted directly. Nothing on the AI path writes
    // lead_status, so a lead the AI has already spoken to still looks exactly
    // like a fresh scraped lead to this function — and must, so that
    // /api/neodove/leads/push-batch accepts it without `force`.
    it("admits a lead the AI has already connected with", () => {
        expect(isAiDialable({ lead_status: null, ai_recall_status: null })).toBe(true);
    });

    // A RUNTIME guard, deliberately not just a type-level one.
    //
    // The obvious way to write this is a `@ts-expect-error` on a call passing
    // `ai_connected`, so that widening the row type makes the directive unused
    // and fails the type-check. That does not work in this repo: a pre-existing
    // syntax error in tests/e2e/nbfc/E-101_payment-mode-mapping-utility.headed.spec.ts
    // makes tsc emit syntactic diagnostics only and skip the semantic pass for
    // the whole program, so TS2578 never fires. Asserting the BEHAVIOUR instead
    // works today and keeps working after that spec is fixed.
    it("ignores AI call history even when told about it", () => {
        expect(
            isAiDialable({
                lead_status: null,
                ai_recall_status: null,
                // Not part of the parameter type. If someone widens the row type
                // AND makes the function act on it, this flips to false and the
                // test name tells them why that closes the human escape hatch.
                ...({ ai_connected: true } as Record<string, unknown>),
            }),
        ).toBe(true);
    });

    it("reads exactly one argument", () => {
        expect(isAiDialable.length).toBe(1);
    });

    it("admits a never-touched lead", () => {
        expect(isAiDialable({})).toBe(true);
        expect(isAiDialable({ lead_status: null, ai_recall_status: null })).toBe(true);
    });

    it("refuses a permanently excluded lead", () => {
        expect(
            isAiDialable({ lead_status: null, ai_recall_status: "excluded" }),
        ).toBe(false);
    });

    it("refuses a lead in an active sales state", () => {
        for (const status of [
            "Assigned_Not_Contacted",
            "Under_Discussion",
            "Commercials_Explained",
            "Transferred_to_ASM",
            "Converted",
        ]) {
            expect(isAiDialable({ lead_status: status, ai_recall_status: null })).toBe(
                false,
            );
        }
    });

    it("admits a Lost lead only when an admin pushed it back", () => {
        expect(
            isAiDialable({ lead_status: "Lost", ai_recall_status: "awaiting_re_dial" }),
        ).toBe(true);
        expect(isAiDialable({ lead_status: "Lost", ai_recall_status: null })).toBe(false);
        expect(
            isAiDialable({ lead_status: "Lost", ai_recall_status: "excluded" }),
        ).toBe(false);
    });
});

describe("the AI-only predicates", () => {
    // The mirror of the assertion above: these SHOULD talk about call history,
    // and should NOT restate the Part-0 lifecycle rule (which is ANDed in
    // separately, and would silently diverge if duplicated here).
    it("AI_CONNECTED_PREDICATE keys on a transcript existing", () => {
        expect(AI_CONNECTED_PREDICATE).toMatch(/ai_call_logs/);
        expect(AI_CONNECTED_PREDICATE).toMatch(/transcript IS NOT NULL/);
        expect(AI_CONNECTED_PREDICATE).not.toMatch(/lead_status/);
    });

    it("AI_ATTEMPTED_PREDICATE does NOT test the transcript", () => {
        // "We tried and nobody picked up" needs every attempt, not just the
        // ones that connected.
        expect(AI_ATTEMPTED_PREDICATE).toMatch(/ai_call_logs/);
        expect(AI_ATTEMPTED_PREDICATE).not.toMatch(/transcript/);
    });

    // Terminal parents must be excluded, or the backlog of pending rows under
    // completed/stopped campaigns would retire those leads forever.
    it("IN_LIVE_DIALER_QUEUE_PREDICATE ignores terminal campaigns", () => {
        expect(IN_LIVE_DIALER_QUEUE_PREDICATE).toMatch(
            /dc\.status NOT IN \('completed', 'stopped', 'failed'\)/,
        );
        expect(IN_LIVE_DIALER_QUEUE_PREDICATE).toMatch(
            /dcl\.status IN \('pending', 'calling'\)/,
        );
    });

    // Stated as "not terminal" rather than "is running" so an unknown or future
    // status ('scheduled', 'draft') fails safe — excluding rather than
    // double-dialling.
    it("IN_LIVE_DIALER_QUEUE_PREDICATE is expressed negatively", () => {
        expect(IN_LIVE_DIALER_QUEUE_PREDICATE).not.toMatch(/dc\.status IN \(/);
    });

    it("every AI-only predicate uses the dl alias its callers provide", () => {
        for (const p of [
            AI_CONNECTED_PREDICATE,
            AI_ATTEMPTED_PREDICATE,
            IN_LIVE_DIALER_QUEUE_PREDICATE,
        ]) {
            expect(p).toMatch(/= dl\.id/);
        }
    });
});
