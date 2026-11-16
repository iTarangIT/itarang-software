import { describe, expect, it } from "vitest";

import { analystDailyDigest, cellText, plainAnswer } from "../kinds/analyst-daily";

describe("analyst_daily (251 item 23)", () => {
  it("mails each person their own copy, mornings only, and is on until people opt in", () => {
    expect(analystDailyDigest.perRecipient).toBeTruthy();
    expect(analystDailyDigest.slots).toEqual(["morning"]);
    expect(analystDailyDigest.defaults).toEqual({ enabled: true, recipients: [] });
  });

  it("turns a markdown answer into one plain paragraph", () => {
    expect(plainAnswer("## Visits\n\n**Biplabh Ghosh** made `7` visits.\n- Fresh: 3\n- Repeat: 4")).toBe(
      "Visits Biplabh Ghosh made 7 visits. • Fresh: 3 • Repeat: 4",
    );
  });

  it("cuts a very long answer", () => {
    const long = plainAnswer("x".repeat(5000));
    expect(long.length).toBe(1500);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes result cells as mail text", () => {
    expect(cellText(null)).toBe("—");
    expect(cellText(12)).toBe(12);
    expect(cellText(Number.NaN)).toBe("—");
    expect(cellText(true)).toBe("Yes");
    expect(cellText("Ravi")).toBe("Ravi");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(String(cellText("y".repeat(300))).length).toBe(120);
  });
});
