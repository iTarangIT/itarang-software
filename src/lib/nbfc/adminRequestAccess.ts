// ID 166 (15 Oct check): the admin NBFC request routes (message, forward,
// push, act, fulfil, verdict replies, rejections) pass customer files between
// the dealer and the NBFC. They open the admin screens to the six admin roles
// (requireAdminAppUser), but on ONE customer only Admin, the Sales Head, the
// CEO and the lead's owner may act — the same rule as the KYC screens (ID 119,
// backOfficeMayReachLead).

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { backOfficeMayReachLead } from "@/lib/auth/requireLeadAccess";
import { db } from "@/lib/db";
import { nbfcDocRequests, nbfcDocumentVerifications, nbfcLeadAssignments } from "@/lib/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lead behind an NBFC request id, or null when there is no such row. */
export async function leadOfNbfcObject(
  kind: "assignment" | "doc_request" | "verdict",
  id: string,
): Promise<string | null> {
  if (!id) return null;
  // Malformed ids are "no such row" here (the route answers 404), never a
  // database error: assignments are uuids, verdicts serial numbers.
  if (kind === "assignment" && !UUID.test(id)) return null;
  if (kind === "verdict" && !/^\d{1,9}$/.test(id)) return null;
  const rows =
    kind === "assignment"
      ? await db
          .select({ lead_id: nbfcLeadAssignments.lead_id })
          .from(nbfcLeadAssignments)
          .where(eq(nbfcLeadAssignments.id, id))
          .limit(1)
      : kind === "doc_request"
        ? await db
            .select({ lead_id: nbfcDocRequests.lead_id })
            .from(nbfcDocRequests)
            .where(eq(nbfcDocRequests.id, id))
            .limit(1)
        : await db
            .select({ lead_id: nbfcDocumentVerifications.lead_id })
            .from(nbfcDocumentVerifications)
            .where(eq(nbfcDocumentVerifications.id, Number(id)))
            .limit(1);
  return rows[0]?.lead_id ?? null;
}

/** May this admin-screen user act on the NBFC requests of lead `leadId`? */
export async function adminMayActOnNbfcLead(
  appUser: { id: string; role: string | null },
  leadId: string | null | undefined,
): Promise<boolean> {
  if (!leadId) return false;
  return backOfficeMayReachLead(appUser, leadId);
}

/**
 * Gate a route that names an NBFC object (assignment, request, verdict): a
 * 403 response when its lead is not the caller's, else null. A missing row
 * passes here so the route's own lookup still answers 404.
 */
export async function nbfcObjectGate(
  appUser: { id: string; role: string | null },
  kind: "assignment" | "doc_request" | "verdict",
  id: string,
): Promise<NextResponse | null> {
  const leadId = await leadOfNbfcObject(kind, id);
  if (!leadId) return null;
  return (await adminMayActOnNbfcLead(appUser, leadId)) ? null : nbfcLeadNotYours();
}

/** The 403 every one of these routes returns when the lead is not the caller's. */
export function nbfcLeadNotYours(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { message: "Only Admin, the Sales Head, the CEO or this customer's owner can do this." },
    },
    { status: 403 },
  );
}
