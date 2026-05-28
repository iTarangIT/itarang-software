/**
 * E-111 — Server-side helpers for NBFC correction rounds.
 *
 * Two responsibilities:
 *   1. `autoResolveOpenRoundOnResubmit` — DB writer called by the transition
 *      route when the NBFC moves from `request_correction → pending_admin_review`.
 *      For every still-pending item, snapshots the current live value/file URL
 *      and flips the round + items to `resolved`.
 *   2. `computeEffectiveResolution` — read-only render-time helper used by
 *      the admin /review and /approval pages to decide whether a pending
 *      item has been fixed in the live tables since the round was opened.
 *      The UI uses this so the panel shows progressive resolution (header
 *      "N items pending" decrements as the admin fixes each field) without
 *      writing to the DB before the admin clicks "Submit corrections for
 *      CEO review".
 *
 * Both paths share the same per-kind switch via `computeLiveValueForItem`,
 * so the UI's notion of "effectively resolved" always matches what the
 * writer will persist on resubmit.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import {
  type CorrectionKind,
  parseSignerKey,
} from "./correction-catalog";

const NBFC_MASTER_FIELD_COLUMN: Record<string, string> = {
  legal_name: "legal_name",
  short_name: "short_name",
  rbi_registration_no: "rbi_registration_no",
  cin: "cin",
  gst_number: "gst_number",
  pan_number: "pan_number",
  nbfc_type: "nbfc_type",
  partnership_date: "partnership_date",
  cor_expiry_date: "cor_expiry_date",
  registered_address: "registered_address",
  active_geographies: "active_geographies",
  primary_contact_name: "primary_contact_name",
  primary_contact_email: "primary_contact_email",
  primary_contact_phone: "primary_contact_phone",
  grievance_officer_name: "grievance_officer_name",
  grievance_helpline: "grievance_helpline",
  grievance_url: "grievance_url",
  nodal_officer: "nodal_officer",
};

function stringifyMaybeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type NbfcRow = typeof nbfc.$inferSelect;
export type NbfcComplianceDocRow = typeof nbfcComplianceDocuments.$inferSelect;
export type NbfcLspAgreementRow = typeof nbfcLspAgreements.$inferSelect;
export type NbfcLspAgreementSignerRow =
  typeof nbfcLspAgreementSigners.$inferSelect;
export type NbfcCorrectionItemRow = typeof nbfcCorrectionItems.$inferSelect;

export interface LiveCorrectionData {
  nbfcRow: NbfcRow | null;
  latestDocByType: Map<string, NbfcComplianceDocRow>;
  agreement: NbfcLspAgreementRow | null;
  signers: NbfcLspAgreementSignerRow[];
}

export function buildLatestDocByType(
  docs: NbfcComplianceDocRow[],
): Map<string, NbfcComplianceDocRow> {
  const map = new Map<string, NbfcComplianceDocRow>();
  for (const d of docs) {
    const prev = map.get(d.document_type);
    if (
      !prev ||
      new Date(d.created_at as Date | string) >=
        new Date(prev.created_at as Date | string)
    ) {
      map.set(d.document_type, d);
    }
  }
  return map;
}

export async function loadLiveCorrectionData(
  nbfcId: number,
): Promise<LiveCorrectionData> {
  const [nbfcRow] = await db.select().from(nbfc).where(eq(nbfc.id, nbfcId));
  const docs = await db
    .select()
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, nbfcId));
  const [agreement] = await db
    .select()
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, nbfcId))
    .orderBy(desc(nbfcLspAgreements.created_at))
    .limit(1);
  const signers = agreement
    ? await db
        .select()
        .from(nbfcLspAgreementSigners)
        .where(
          eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id),
        )
    : [];
  return {
    nbfcRow: nbfcRow ?? null,
    latestDocByType: buildLatestDocByType(docs),
    agreement: agreement ?? null,
    signers,
  };
}

/** Pure — given an item + live data, returns the value/file URL that the
 *  resolver would snapshot at resubmit time. */
export function computeLiveValueForItem(
  item: { kind: CorrectionKind; target_key: string },
  live: LiveCorrectionData,
): { value: string | null; fileUrl: string | null } {
  switch (item.kind) {
    case "master_field": {
      const col = NBFC_MASTER_FIELD_COLUMN[item.target_key];
      if (!col || !live.nbfcRow) return { value: null, fileUrl: null };
      return {
        value: stringifyMaybeJson(
          (live.nbfcRow as unknown as Record<string, unknown>)[col],
        ),
        fileUrl: null,
      };
    }
    case "compliance_doc": {
      const d = live.latestDocByType.get(item.target_key);
      return {
        value: d?.status ?? null,
        fileUrl: d?.file_url ?? null,
      };
    }
    case "signer_field": {
      const p = parseSignerKey(item.target_key);
      if (!p || p.field === "identity") return { value: null, fileUrl: null };
      const s = live.signers.find(
        (r) => r.party === p.party && r.signer_order === p.signerOrder,
      );
      if (!s) return { value: null, fileUrl: null };
      const fieldVal =
        p.field === "full_name"
          ? s.full_name
          : p.field === "email"
            ? s.email
            : s.designation;
      return { value: fieldVal ?? null, fileUrl: null };
    }
    case "signer_identity_doc": {
      const p = parseSignerKey(item.target_key);
      if (!p) return { value: null, fileUrl: null };
      const s = live.signers.find(
        (r) => r.party === p.party && r.signer_order === p.signerOrder,
      );
      return { value: null, fileUrl: s?.identity_document_url ?? null };
    }
    case "agreement_template": {
      return {
        value: live.agreement?.agreement_status ?? null,
        fileUrl: live.agreement?.agreement_template_url ?? null,
      };
    }
  }
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/** Decide whether a pending item has effectively been fixed by the admin
 *  since the round was opened. Compares the live value/file URL against
 *  the snapshotted `previous_value` / `previous_file_url`. Items already
 *  marked `resolved` or `dismissed` are returned unchanged. */
export function computeEffectiveResolution(
  item: NbfcCorrectionItemRow,
  live: LiveCorrectionData,
): {
  resolutionStatus: "pending" | "resolved" | "dismissed";
  newValue: string | null;
  newFileUrl: string | null;
} {
  if (item.resolution_status !== "pending") {
    return {
      resolutionStatus: item.resolution_status as
        | "pending"
        | "resolved"
        | "dismissed",
      newValue: item.new_value ?? null,
      newFileUrl: item.new_file_url ?? null,
    };
  }
  const live_ = computeLiveValueForItem(
    { kind: item.kind as CorrectionKind, target_key: item.target_key },
    live,
  );
  const valueChanged = normalize(live_.value) !== normalize(item.previous_value);
  const fileChanged =
    normalize(live_.fileUrl) !== normalize(item.previous_file_url);
  if (valueChanged || fileChanged) {
    return {
      resolutionStatus: "resolved",
      newValue: live_.value,
      newFileUrl: live_.fileUrl,
    };
  }
  return { resolutionStatus: "pending", newValue: null, newFileUrl: null };
}

export type AutoResolveResult =
  | { ok: true; roundId: number; resolvedItemCount: number }
  | { ok: false; reason: "no_open_round" };

export async function autoResolveOpenRoundOnResubmit(
  nbfcId: number,
  actorId: string,
): Promise<AutoResolveResult> {
  const [round] = await db
    .select()
    .from(nbfcCorrectionRounds)
    .where(
      and(
        eq(nbfcCorrectionRounds.nbfc_id, nbfcId),
        eq(nbfcCorrectionRounds.status, "open"),
      ),
    )
    .limit(1);
  if (!round) return { ok: false, reason: "no_open_round" };

  const pending = await db
    .select()
    .from(nbfcCorrectionItems)
    .where(
      and(
        eq(nbfcCorrectionItems.round_id, round.id),
        eq(nbfcCorrectionItems.resolution_status, "pending"),
      ),
    );

  const now = new Date();

  if (pending.length === 0) {
    await db
      .update(nbfcCorrectionRounds)
      .set({
        status: "resolved",
        resolved_at: now,
        resolved_by: actorId,
        updated_at: now,
      })
      .where(eq(nbfcCorrectionRounds.id, round.id));
    return { ok: true, roundId: round.id, resolvedItemCount: 0 };
  }

  const live = await loadLiveCorrectionData(nbfcId);

  for (const item of pending) {
    const { value, fileUrl } = computeLiveValueForItem(
      { kind: item.kind as CorrectionKind, target_key: item.target_key },
      live,
    );
    await db
      .update(nbfcCorrectionItems)
      .set({
        resolution_status: "resolved",
        new_value: value,
        new_file_url: fileUrl,
        resolved_at: now,
        resolved_by: actorId,
      })
      .where(eq(nbfcCorrectionItems.id, item.id));
  }

  await db
    .update(nbfcCorrectionRounds)
    .set({
      status: "resolved",
      resolved_at: now,
      resolved_by: actorId,
      updated_at: now,
    })
    .where(eq(nbfcCorrectionRounds.id, round.id));

  return { ok: true, roundId: round.id, resolvedItemCount: pending.length };
}
