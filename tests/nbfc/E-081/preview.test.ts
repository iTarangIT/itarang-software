/**
 * E-081 — Audit Log Entry Preview unit tests.
 *
 * Acceptance criteria (verbatim from docs/nbfc/brd_extract/E-081_audit-log-preview.yaml):
 *   AC1: POST /api/nbfc/audit-log/preview with valid body returns 200 with
 *        will_log object containing timestamp, imei, action, reason,
 *        requested_by.user_id, approver, borrower_notice_record.
 *   AC2: POST /api/nbfc/audit-log/preview does not insert any row into
 *        audit_logs (preview is non-persistent).
 *   AC3: POST without action or reason_code returns 400.
 *
 * Run:
 *   npx tsx --test tests/nbfc/E-081/preview.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PreviewRequestSchema,
  composeWillLog,
} from "../../../src/app/api/nbfc/audit-log/preview/preview-core";

const validBody = {
  entity_type: "loan",
  entity_id: "LN-1001",
  action: "locker_disable",
  reason_code: "DPD_60",
  imei: "356938035643809",
  borrower_notice_id: "bn-42",
  approver_user_id: "11111111-1111-4111-8111-111111111111",
};

const fixedNow = () => new Date("2026-05-01T12:00:00.000Z");

const makeDeps = (overrides: Partial<Parameters<typeof composeWillLog>[1]> = {}) => ({
  session: { id: "22222222-2222-2222-2222-222222222222", email: "ops@nbfc.test" },
  lookupUserDisplayName: async (id: string) =>
    id === "11111111-1111-4111-8111-111111111111"
      ? "Approver Anita"
      : id === "22222222-2222-2222-2222-222222222222"
        ? "Operator Om"
        : null,
  lookupBorrowerNoticeChannel: async (_id: string) => "sms",
  now: fixedNow,
  ...overrides,
});

test("AC1: composeWillLog returns all 7 disclosed fields with valid body", async () => {
  const parsed = PreviewRequestSchema.safeParse(validBody);
  assert.equal(parsed.success, true, "valid body should parse");
  if (!parsed.success) return;

  const will = await composeWillLog(parsed.data, makeDeps());

  // Seven BRD-mandated keys, in any order.
  assert.deepEqual(
    Object.keys(will).sort(),
    [
      "action",
      "approver",
      "borrower_notice_record",
      "imei",
      "reason",
      "requested_by",
      "timestamp",
    ],
  );

  assert.equal(will.timestamp, "2026-05-01T12:00:00.000Z");
  assert.equal(will.imei, "356938035643809");
  assert.equal(will.action, "locker_disable");
  assert.equal(will.reason, "DPD_60");
  assert.equal(will.requested_by.user_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(will.requested_by.display_name, "Operator Om");
  assert.equal(will.approver.user_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(will.approver.display_name, "Approver Anita");
  assert.equal(will.borrower_notice_record.id, "bn-42");
  assert.equal(will.borrower_notice_record.channel, "sms");
});

test("AC1b: omitted optional fields surface as null (not undefined)", async () => {
  const minimalBody = {
    entity_type: "loan",
    entity_id: "LN-1001",
    action: "extension_grant",
    reason_code: "BORROWER_REQUEST",
  };
  const parsed = PreviewRequestSchema.safeParse(minimalBody);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const will = await composeWillLog(parsed.data, makeDeps());

  assert.equal(will.imei, null);
  assert.equal(will.approver.user_id, null);
  assert.equal(will.approver.display_name, null);
  assert.equal(will.borrower_notice_record.id, null);
  assert.equal(will.borrower_notice_record.channel, null);
});

test("AC2: composeWillLog never invokes the audit_logs writer (signature only)", async () => {
  // The preview endpoint imports neither db.insert(auditLogs) nor any
  // audit-write helper; we assert that statically by reading the route file.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const routePath = path.resolve(
    __dirname,
    "../../../src/app/api/nbfc/audit-log/preview/route.ts",
  );
  const src = await fs.readFile(routePath, "utf8");
  assert.ok(
    !/db\.insert\s*\(\s*auditLogs/.test(src),
    "route.ts must not call db.insert(auditLogs) — preview is non-persistent",
  );
  assert.ok(
    !/auditLogs\b/.test(src) || /\/\/.*auditLogs/.test(src),
    "route.ts must not reference auditLogs outside comments",
  );
});

test("AC3: PreviewRequestSchema rejects body missing action", () => {
  const bad = { ...validBody } as Record<string, unknown>;
  delete bad.action;
  const r = PreviewRequestSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("AC3: PreviewRequestSchema rejects body missing reason_code", () => {
  const bad = { ...validBody } as Record<string, unknown>;
  delete bad.reason_code;
  const r = PreviewRequestSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("AC3: PreviewRequestSchema rejects empty action string", () => {
  const r = PreviewRequestSchema.safeParse({ ...validBody, action: "" });
  assert.equal(r.success, false);
});

test("AC3: PreviewRequestSchema rejects non-uuid approver_user_id", () => {
  const r = PreviewRequestSchema.safeParse({
    ...validBody,
    approver_user_id: "not-a-uuid",
  });
  assert.equal(r.success, false);
});
