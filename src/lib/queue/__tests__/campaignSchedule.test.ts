// E-254 — guard tests for the pure half of the calling-window vocabulary.
//
// The SQL half (windowOpenSql / nextWindowOpenSql) is covered separately and
// against a real database by scripts/verify-e254-campaign-window.ts, because
// its behaviour is Postgres', not TypeScript's. What is left here is the part
// that decides what actually reaches the columns — and the properties below are
// the ones that are invisible at the call site and expensive to get wrong.

import { describe, expect, it } from "vitest";
import {
  campaignScheduleSchema,
  formatWindow,
  scheduleColumns,
  toHHMM,
} from "../campaignSchedule";

const valid = {
  mode: "recurring" as const,
  window_start: "11:00",
  window_end: "15:00",
  window_days: ["mon", "wed"] as const,
};

describe("campaignScheduleSchema", () => {
  it("accepts a well-formed recurring window", () => {
    const r = campaignScheduleSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("defaults mode to 'now', which is the unscheduled behaviour", () => {
    const r = campaignScheduleSchema.parse({});
    expect(r.mode).toBe("now");
  });

  it("lets a 'now' campaign omit the window entirely", () => {
    expect(campaignScheduleSchema.safeParse({ mode: "now" }).success).toBe(true);
  });

  it("requires both bounds once a window is being used", () => {
    for (const mode of ["single", "recurring"]) {
      const r = campaignScheduleSchema.safeParse({ mode, window_start: "11:00" });
      expect(r.success, `${mode} with only a start`).toBe(false);
    }
  });

  // A zero-length window is the one input that parks a campaign forever with
  // nothing to say why: the wrap-aware predicate reads start === end as "never
  // open", so it pauses on its first advance and never wakes.
  it("rejects equal start and end", () => {
    const r = campaignScheduleSchema.safeParse({
      ...valid,
      window_start: "11:00",
      window_end: "11:00",
    });
    expect(r.success).toBe(false);
  });

  it("accepts an overnight window, which is legal and wraps midnight", () => {
    const r = campaignScheduleSchema.safeParse({
      ...valid,
      window_start: "22:00",
      window_end: "06:00",
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed times and out-of-range hours", () => {
    for (const bad of ["9:00", "24:00", "11:60", "1100", "11:00:00", ""]) {
      const r = campaignScheduleSchema.safeParse({ ...valid, window_start: bad });
      expect(r.success, `window_start=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects an unknown weekday and an empty day list", () => {
    expect(
      campaignScheduleSchema.safeParse({ ...valid, window_days: ["monday"] })
        .success,
    ).toBe(false);
    expect(
      campaignScheduleSchema.safeParse({ ...valid, window_days: [] }).success,
    ).toBe(false);
  });

  it("rejects an unknown mode rather than silently treating it as 'now'", () => {
    expect(campaignScheduleSchema.safeParse({ mode: "daily" }).success).toBe(
      false,
    );
  });
});

describe("scheduleColumns", () => {
  // The backward-compatibility guarantee: an absent or 'now' schedule must
  // write the unscheduled quartet, because NULL window columns are what make
  // advanceCampaign skip the gate entirely.
  it("writes the unscheduled quartet for null, undefined and 'now'", () => {
    for (const input of [null, undefined, { mode: "now" as const }]) {
      expect(scheduleColumns(input as never)).toEqual({
        schedule_mode: "now",
        window_start: null,
        window_end: null,
        window_days: null,
      });
    }
  });

  it("carries a recurring window through intact", () => {
    expect(scheduleColumns({ ...valid, window_days: ["mon", "wed"] })).toEqual({
      schedule_mode: "recurring",
      window_start: "11:00",
      window_end: "15:00",
      window_days: ["mon", "wed"],
    });
  });

  // A single run happens once, so a stored weekday list would be a recurrence
  // the campaign never acts on — and formatWindow would show "Mon, Wed" on a
  // campaign that runs one afternoon.
  it("drops window_days for a single run even when supplied", () => {
    const cols = scheduleColumns({
      ...valid,
      mode: "single",
      window_days: ["mon", "wed"],
    });
    expect(cols.schedule_mode).toBe("single");
    expect(cols.window_days).toBeNull();
    expect(cols.window_start).toBe("11:00");
  });

  it("round-trips whatever the schema produced", () => {
    const parsed = campaignScheduleSchema.parse(valid);
    expect(scheduleColumns(parsed).schedule_mode).toBe("recurring");
  });
});

describe("toHHMM", () => {
  // assignment_config stores varchar(8) while the window columns are
  // varchar(5); an untruncated '09:00:00' fails the HHMM regex on the way back
  // in, so the defaults lookup would silently fall back for every user.
  it("narrows assignment_config's varchar(8) to HH:MM", () => {
    expect(toHHMM("09:00:00")).toBe("09:00");
    expect(toHHMM("19:30:00")).toBe("19:30");
  });

  it("zero-pads a single-digit hour", () => {
    expect(toHHMM("9:05")).toBe("09:05");
  });

  it("returns null for anything it cannot narrow", () => {
    for (const bad of ["", "nonsense", "25:00", null, undefined, 900]) {
      expect(toHHMM(bad), String(bad)).toBeNull();
    }
  });
});

describe("formatWindow", () => {
  it("returns null for an unscheduled campaign so the UI shows nothing", () => {
    expect(formatWindow({ schedule_mode: "now" })).toBeNull();
    expect(formatWindow({})).toBeNull();
    // Mode set but bounds missing — a half-written row must not render half a
    // window.
    expect(formatWindow({ schedule_mode: "recurring", window_start: "11:00" })).toBeNull();
  });

  it("compacts a contiguous weekday run into a range", () => {
    expect(
      formatWindow({
        schedule_mode: "recurring",
        window_start: "11:00",
        window_end: "15:00",
        window_days: ["mon", "tue", "wed", "thu", "fri", "sat"],
      }),
    ).toBe("11:00–15:00 IST · Mon–Sat · Recurring");
  });

  it("lists non-contiguous days individually, in week order", () => {
    expect(
      formatWindow({
        schedule_mode: "recurring",
        window_start: "11:00",
        window_end: "15:00",
        // Deliberately out of order: the label must not depend on input order.
        window_days: ["fri", "mon", "wed"],
      }),
    ).toBe("11:00–15:00 IST · Mon, Wed, Fri · Recurring");
  });

  it("calls a null or full day list 'Every day'", () => {
    for (const days of [null, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]]) {
      expect(
        formatWindow({
          schedule_mode: "recurring",
          window_start: "11:00",
          window_end: "15:00",
          window_days: days,
        }),
      ).toBe("11:00–15:00 IST · Every day · Recurring");
    }
  });

  it("labels a single run without any weekday claim", () => {
    expect(
      formatWindow({
        schedule_mode: "single",
        window_start: "11:00",
        window_end: "15:00",
        window_days: null,
      }),
    ).toBe("11:00–15:00 IST · Single run");
  });
});
