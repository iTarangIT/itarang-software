import "server-only";

// Data Analyst agent — who may use it, and whose conversations are whose.
//
// The agent sees one service account for the whole CRM (src/lib/analyst/client.ts), so it
// cannot tell the CEO's conversations from a sales head's. The CRM does that here: every thread
// id is minted as `crm.<crm user id>.<uuid>`, and the routes only list, read or continue
// threads carrying the caller's own prefix. Thread ids are capped at 100 characters by the
// agent; this format is 77.

import { randomUUID } from "node:crypto";

import { requireAuth } from "@/lib/auth-utils";

import { AnalystError } from "./errors";

/** Mirrors the pages' gate: /ceo/analyst and /sales-head/analyst. admin keeps support access. */
export const ANALYST_ROLES = new Set(["ceo", "sales_head", "admin"]);

export type AnalystUser = { id: string; role: string; prefix: string };

export async function requireAnalystUser(): Promise<AnalystUser> {
  const user = await requireAuth();
  if (!ANALYST_ROLES.has(user.role)) {
    throw new AnalystError("the analyst is only open to CEO and Sales Head", 403, "forbidden");
  }
  return { id: user.id, role: user.role, prefix: threadPrefix(user.id) };
}

export function threadPrefix(userId: string): string {
  return `crm.${userId}.`;
}

export function newThreadId(user: AnalystUser): string {
  return `${user.prefix}${randomUUID()}`;
}

export function ownsThread(user: AnalystUser, threadId: string | null | undefined): boolean {
  return typeof threadId === "string" && threadId.startsWith(user.prefix) && threadId.length <= 100;
}
