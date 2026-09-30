import { describe, expect, it } from "vitest";

import { CreateConnectionBody, forwardQuery, matchSourceRoute, uploadAllowed } from "../sources-routes";

const ID = "3f6c2a1e-0b7d-4f7e-9a51-2c4b1d9e8f00";

describe("matchSourceRoute", () => {
  it("lets every analyst user read, but only managers change", () => {
    expect(matchSourceRoute("GET", [])).toMatchObject({ agentPath: "/connections", manage: false });
    expect(matchSourceRoute("POST", [])).toMatchObject({ agentPath: "/connections", manage: true, body: "json" });
    expect(matchSourceRoute("GET", [ID, "tables"])).toMatchObject({ manage: false });
    expect(matchSourceRoute("PUT", [ID, "tables"])).toMatchObject({ manage: true, body: "json" });
    expect(matchSourceRoute("GET", [ID, "sources"])).toMatchObject({ manage: false });
    expect(matchSourceRoute("POST", [ID, "sources"])).toMatchObject({ manage: true });
    expect(matchSourceRoute("DELETE", [ID])).toMatchObject({ agentPath: `/connections/${ID}`, manage: true });
  });

  it("maps uploads to multipart", () => {
    expect(matchSourceRoute("POST", ["file"])).toMatchObject({ agentPath: "/connections/file", body: "multipart" });
    expect(matchSourceRoute("POST", [ID, "files"])).toMatchObject({ agentPath: `/connections/${ID}/files`, body: "multipart" });
  });

  it("covers the Google flow", () => {
    expect(matchSourceRoute("POST", ["dataset"])).toMatchObject({ agentPath: "/connections/dataset" });
    expect(matchSourceRoute("POST", [ID, "google", "resolve"])).toMatchObject({ manage: true });
    expect(matchSourceRoute("GET", [ID, "google", "tree"])).toMatchObject({ query: ["source_id", "folder_id"] });
    expect(matchSourceRoute("POST", [ID, "sync"])).toMatchObject({ body: "none", manage: true });
    expect(matchSourceRoute("DELETE", [ID, "sources", "abc_1"])).toMatchObject({ manage: true });
    expect(matchSourceRoute("POST", [ID, "tables", "refresh"])).toMatchObject({ manage: true });
  });

  it("re-encodes a file name and refuses path tricks", () => {
    expect(matchSourceRoute("DELETE", [ID, "files", "sales q3.csv"])?.agentPath).toBe(
      `/connections/${ID}/files/sales%20q3.csv`,
    );
    expect(matchSourceRoute("DELETE", [ID, "files", ".."])).toBeNull();
    expect(matchSourceRoute("DELETE", [ID, "files", "a/b.csv"])).toBeNull();
    expect(matchSourceRoute("DELETE", [ID, "files", "a\\b.csv"])).toBeNull();
  });

  it("refuses anything not on the list", () => {
    expect(matchSourceRoute("PUT", [])).toBeNull();
    expect(matchSourceRoute("GET", [ID])).toBeNull();
    expect(matchSourceRoute("GET", ["..", "runs"])).toBeNull();
    expect(matchSourceRoute("GET", [ID, "secret"])).toBeNull();
    expect(matchSourceRoute("DELETE", [ID, "tables"])).toBeNull();
    expect(matchSourceRoute("GET", [ID, "tables", "refresh"])).toBeNull();
    expect(matchSourceRoute("GET", [ID, "a", "b", "c"])).toBeNull();
    expect(matchSourceRoute("GET", ["x?y"])).toBeNull();
  });
});

describe("forwardQuery", () => {
  it("keeps only the route's safe keys", () => {
    const route = matchSourceRoute("GET", [ID, "google", "tree"])!;
    const params = new URLSearchParams({ source_id: "s1", folder_id: "f-2", evil: "1" });
    expect(forwardQuery(route, params)).toBe("?source_id=s1&folder_id=f-2");
    expect(forwardQuery(route, new URLSearchParams({ source_id: "../x" }))).toBe("");
    expect(forwardQuery(matchSourceRoute("GET", [])!, params)).toBe("");
  });
});

describe("CreateConnectionBody", () => {
  it("accepts the CRM preset or a postgres address", () => {
    expect(CreateConnectionBody.safeParse({ preset: "crm" }).success).toBe(true);
    expect(CreateConnectionBody.safeParse({ name: "W", dsn: "postgresql://u:p@h:5432/d" }).success).toBe(true);
    expect(CreateConnectionBody.safeParse({ name: "W", dsn: "postgres://u@h/d" }).success).toBe(true);
  });
  it("refuses anything else", () => {
    expect(CreateConnectionBody.safeParse({ name: "W", dsn: "mysql://u@h/d" }).success).toBe(false);
    expect(CreateConnectionBody.safeParse({ preset: "other" }).success).toBe(false);
    expect(CreateConnectionBody.safeParse({ dsn: "postgresql://u@h/d" }).success).toBe(false);
  });
});

describe("uploadAllowed", () => {
  it("matches the agent's suffixes, any case", () => {
    expect(uploadAllowed("a.CSV")).toBe(true);
    expect(uploadAllowed("b.xlsx")).toBe(true);
    expect(uploadAllowed("c.pdf")).toBe(true);
    expect(uploadAllowed("d.xls")).toBe(false);
    expect(uploadAllowed("e.docx")).toBe(false);
  });
});
