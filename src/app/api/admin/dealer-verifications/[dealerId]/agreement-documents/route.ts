export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerAgreementDocuments, dealerAgreementOverrideRequests, users } from "@/lib/db/schema";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { isMissingSchemaError } from "@/lib/agreement/executedAgreementStore";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

/**
 * Every manually uploaded agreement file for this dealer — the signed
 * agreement(s) and ALL audit trails, not only the first of each that the
 * canonical download buttons serve — plus the second-approval requests
 * (tracker ID 55, E-313 / E-318). Each file downloads from
 * agreement-documents/[docId].
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [docs, requests] = await Promise.all([
      db
        .select()
        .from(dealerAgreementDocuments)
        .where(eq(dealerAgreementDocuments.application_id, dealerId))
        .orderBy(desc(dealerAgreementDocuments.uploaded_at)),
      db
        .select()
        .from(dealerAgreementOverrideRequests)
        .where(eq(dealerAgreementOverrideRequests.application_id, dealerId))
        .orderBy(desc(dealerAgreementOverrideRequests.requested_at)),
    ]);

    // uploaded_by / requested_by / decided_by are users.id as text.
    const isUuid = (v: string | null): v is string =>
      !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const userIds = [
      ...new Set(
        [
          ...docs.flatMap((d) => [d.uploaded_by, d.mismatch_confirmed_by]),
          ...requests.flatMap((r) => [r.requested_by, r.decided_by]),
        ].filter(isUuid)
      ),
    ];
    const people = userIds.length
      ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds))
      : [];
    const nameOf = (id: string | null) => {
      if (!id) return null;
      const p = people.find((u) => u.id === id);
      return p ? p.name || p.email : id;
    };

    return NextResponse.json({
      success: true,
      data: {
        documents: docs.map((d) => ({
          id: d.id,
          kind: d.kind,
          fileName: d.file_name,
          byteSize: d.byte_size,
          verdict: d.verdict,
          reasons: d.reasons,
          status: d.status,
          overrideRequestId: d.override_request_id,
          uploadedBy: nameOf(d.uploaded_by),
          uploadedAt: d.uploaded_at,
          // Pre-E-318 rows: the uploader confirmed their own mismatch.
          selfConfirmedReason: d.mismatch_confirmed_by ? d.mismatch_reason : null,
        })),
        overrideRequests: requests.map((r) => ({
          id: r.id,
          status: r.status,
          addOnly: r.add_only,
          verdict: r.verdict,
          reasons: r.reasons,
          read: r.read_values,
          typedSignedOn: r.typed_signed_on,
          typedRef: r.typed_ref,
          requestReason: r.request_reason,
          requestedBy: nameOf(r.requested_by),
          requestedAt: r.requested_at,
          decidedBy: nameOf(r.decided_by),
          decidedAt: r.decided_at,
          decisionNote: r.decision_note,
          // The two-person rule, as the page needs it for THIS viewer.
          canDecide: r.status === "pending" && r.requested_by !== auth.user.id,
          canWithdraw: r.status === "pending" && r.requested_by === auth.user.id,
        })),
      },
    });
  } catch (error: unknown) {
    // E-313 / E-318 not applied on this host: nothing recorded yet, so nothing to list.
    if (isMissingSchemaError(error)) {
      return NextResponse.json({
        success: true,
        data: { documents: [], overrideRequests: [], migrationMissing: true },
      });
    }
    console.error("AGREEMENT DOCUMENTS LIST ERROR:", error);
    return NextResponse.json(
      { success: false, message: (error instanceof Error && error.message) || "Failed to list agreement documents" },
      { status: 500 }
    );
  }
}
