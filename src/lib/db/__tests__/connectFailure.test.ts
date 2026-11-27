import { describe, expect, it } from "vitest";
import { isDbConnectFailure } from "../connectFailure";

describe("isDbConnectFailure", () => {
  it("matches the postgres.js connect timeout seen on prod", () => {
    const err = Object.assign(
      new Error("write CONNECT_TIMEOUT database-2.example.rds.amazonaws.com:5432"),
      { code: "CONNECT_TIMEOUT" },
    );
    expect(isDbConnectFailure(err)).toBe(true);
  });

  it("looks through Drizzle's wrapper to the cause", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const wrapped = new Error("Failed query: select 1", { cause });
    expect(isDbConnectFailure(wrapped)).toBe(true);
  });

  it("matches a refused login (too many connections)", () => {
    expect(isDbConnectFailure({ code: "53300", message: "sorry, too many clients" })).toBe(true);
  });

  it("matches on the message when the code is missing", () => {
    expect(isDbConnectFailure(new Error("write CONNECT_TIMEOUT host:5432"))).toBe(true);
  });

  it("does not match errors on an open connection", () => {
    expect(isDbConnectFailure({ code: "ECONNRESET" })).toBe(false);
    expect(isDbConnectFailure({ code: "57014" })).toBe(false); // statement timeout
    expect(isDbConnectFailure({ code: "23505" })).toBe(false); // unique violation
    expect(isDbConnectFailure(new Error("Company name is required"))).toBe(false);
  });

  it("handles non-errors", () => {
    expect(isDbConnectFailure(null)).toBe(false);
    expect(isDbConnectFailure(undefined)).toBe(false);
    expect(isDbConnectFailure("CONNECT_TIMEOUT")).toBe(false);
  });
});
