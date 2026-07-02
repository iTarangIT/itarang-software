/**
 * Calculator admin service — reads + versioned/audited mutations (server-only).
 *
 * Every mutation runs in one db.transaction that: (1) inserts a new
 * calc_config_versions row, (2) closes the edited effective-dated row
 * (valid_to = now) and inserts a fresh row (valid_from = now, new version) —
 * NEVER an in-place UPDATE, so past quotes reproduce — and (3) writes a
 * calc_audit_log entry (actor, entity, before→after). Soft-delete only.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  calcConfigVersions,
  calcAuditLog,
  calcSettings,
  calcBatteryModels,
  calcComponentPrices,
  calcNbfcs,
  calcSchemes,
  calcNbfcModelCaps,
  calcNbfcCoverage,
  calcLeads,
  dealers,
} from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function mkVersion(tx: Tx, actorId: string, note: string, summary: unknown): Promise<number> {
  const [v] = await tx
    .insert(calcConfigVersions)
    .values({ createdBy: actorId, note, changeSummary: summary as never })
    .returning({ id: calcConfigVersions.id });
  return v.id;
}

async function audit(
  tx: Tx,
  actorId: string,
  action: "create" | "update" | "delete",
  entity: string,
  entityId: string | number,
  before: unknown,
  after: unknown,
  cv: number,
) {
  await tx.insert(calcAuditLog).values({
    actorId,
    action,
    entity,
    entityId: String(entityId),
    before: (before ?? null) as never,
    after: (after ?? null) as never,
    configVersionId: cv,
  });
}

/* ── READS ──────────────────────────────────────────────────────────────── */

export async function getOverview() {
  const [nbfcs, schemes, coverage, models, [settings]] = await Promise.all([
    db.select().from(calcNbfcs).where(isNull(calcNbfcs.validTo)),
    db.select().from(calcSchemes).where(and(eq(calcSchemes.status, "active"), isNull(calcSchemes.validTo))),
    db.select().from(calcNbfcCoverage).where(isNull(calcNbfcCoverage.validTo)),
    db.select().from(calcBatteryModels).where(eq(calcBatteryModels.status, "active")),
    db.select().from(calcSettings).where(isNull(calcSettings.validTo)).limit(1),
  ]);

  const schemeCount = new Map<number, number>();
  for (const s of schemes) schemeCount.set(s.nbfcId, (schemeCount.get(s.nbfcId) ?? 0) + 1);

  const cityCount = new Map<number, number>();
  const panIndia = new Set<number>();
  for (const c of coverage) {
    if (c.coverageType === "PAN_INDIA") panIndia.add(c.nbfcId);
    else cityCount.set(c.nbfcId, (cityCount.get(c.nbfcId) ?? 0) + 1);
  }

  return {
    nbfcs: nbfcs
      .map((nb) => ({
        id: nb.id,
        nbfcCode: nb.nbfcCode,
        name: nb.name,
        variant: nb.variant,
        status: nb.status,
        activeSchemes: schemeCount.get(nb.id) ?? 0,
        coverage: panIndia.has(nb.id) ? "Pan India" : `${cityCount.get(nb.id) ?? 0} cities`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    modelCount: models.length,
    hasSettings: !!settings,
  };
}

export async function getSettings() {
  const [row] = await db.select().from(calcSettings).where(isNull(calcSettings.validTo)).limit(1);
  return row ?? null;
}

export async function getModelsWithPrices() {
  const [models, prices] = await Promise.all([
    db.select().from(calcBatteryModels).where(eq(calcBatteryModels.status, "active")),
    db.select().from(calcComponentPrices).where(isNull(calcComponentPrices.validTo)),
  ]);
  const byModel = new Map<number, Record<string, { amountPaise: number; gstMultiplier: string }>>();
  for (const p of prices) {
    const m = byModel.get(p.modelId) ?? {};
    m[p.component] = { amountPaise: p.amountPaise, gstMultiplier: p.gstMultiplier };
    byModel.set(p.modelId, m);
  }
  return models
    .map((m) => ({ id: m.id, skuCode: m.skuCode, displayName: m.displayName, components: byModel.get(m.id) ?? {} }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getNbfcDetail(nbfcId: number) {
  const [nbfc] = await db
    .select()
    .from(calcNbfcs)
    .where(and(eq(calcNbfcs.id, nbfcId), isNull(calcNbfcs.validTo)))
    .limit(1);
  if (!nbfc) return null;

  const [schemes, caps, models] = await Promise.all([
    db.select().from(calcSchemes).where(and(eq(calcSchemes.nbfcId, nbfcId), isNull(calcSchemes.validTo))),
    nbfc.variant === "B"
      ? db.select().from(calcNbfcModelCaps).where(and(eq(calcNbfcModelCaps.nbfcId, nbfcId), isNull(calcNbfcModelCaps.validTo)))
      : Promise.resolve([]),
    db.select().from(calcBatteryModels).where(eq(calcBatteryModels.status, "active")),
  ]);

  return {
    nbfc,
    schemes: schemes.sort((a, b) => a.tenureMonths - b.tenureMonths || a.advanceMonths - b.advanceMonths),
    caps,
    models: models.sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

export async function getCoverage() {
  const [coverage, nbfcs] = await Promise.all([
    db.select().from(calcNbfcCoverage).where(isNull(calcNbfcCoverage.validTo)),
    db.select().from(calcNbfcs).where(isNull(calcNbfcs.validTo)),
  ]);
  const nameById = new Map(nbfcs.map((n) => [n.id, n.name]));
  return nbfcs
    .map((n) => ({
      nbfcId: n.id,
      nbfcName: n.name,
      variant: n.variant,
      panIndia: coverage.some((c) => c.nbfcId === n.id && c.coverageType === "PAN_INDIA"),
      cities: coverage
        .filter((c) => c.nbfcId === n.id && c.coverageType === "CITY")
        .map((c) => ({ id: c.id, display: c.cityDisplay, normalized: c.cityNormalized, stateCode: c.stateCode }))
        .sort((a, b) => (a.display ?? "").localeCompare(b.display ?? "")),
    }))
    .sort((a, b) => (nameById.get(a.nbfcId) ?? "").localeCompare(nameById.get(b.nbfcId) ?? ""));
}

export async function getAuditFeed(limit = 100) {
  const [logs, versions] = await Promise.all([
    db.select().from(calcAuditLog).orderBy(desc(calcAuditLog.at)).limit(limit),
    db.select().from(calcConfigVersions).orderBy(desc(calcConfigVersions.id)).limit(50),
  ]);
  return { logs, versions };
}

// One scheme line as stored inside calc_leads.result_snapshot (engine SchemeCard).
interface SnapshotScheme {
  nbfc: string;
  schemeCode: string;
  tenure: number;
  emi: number;
  totalUpfront: number;
  estimatedTotalPayable: number;
  recommended?: boolean;
}

export interface SearchHistoryEntry {
  id: string;
  createdAt: string;
  dealerCode: string | null;
  dealerName: string | null;
  customerName: string;
  phone: string;
  city: string | null;
  modelName: string | null;
  tenureMonths: number | null;
  expectedEmi: number | null; // rupees
  upfrontAbility: number | null; // rupees
  outcome: "qualified" | "stretch_only" | "none" | null;
  configVersionId: number | null;
  otpVerifiedAt: string | null;
  waResultsStatus: string | null;
  waResultsSentAt: string | null;
  qualified: SnapshotScheme[];
  stretch: SnapshotScheme[];
}

const paiseToRupees = (p: number | null) => (p == null ? null : Math.round(p / 100));

function schemeLines(raw: unknown): SnapshotScheme[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c: any) => ({
    nbfc: String(c?.nbfc ?? ""),
    schemeCode: String(c?.schemeCode ?? ""),
    tenure: Number(c?.tenure ?? 0),
    emi: Number(c?.emi ?? 0),
    totalUpfront: Number(c?.totalUpfront ?? 0),
    estimatedTotalPayable: Number(c?.estimatedTotalPayable ?? 0),
    recommended: !!c?.recommended,
  }));
}

/** Verified customer searches, newest first — the admin Search History feed. */
export async function getSearchHistory(limit = 200): Promise<SearchHistoryEntry[]> {
  const rows = await db
    .select({
      lead: calcLeads,
      modelName: calcBatteryModels.displayName,
      dealerName: dealers.company_name,
    })
    .from(calcLeads)
    .leftJoin(calcBatteryModels, eq(calcBatteryModels.id, calcLeads.modelId))
    .leftJoin(dealers, eq(dealers.dealer_id, calcLeads.dealerId))
    .orderBy(desc(calcLeads.createdAt))
    .limit(limit);

  return rows.map(({ lead, modelName, dealerName }) => {
    const snap = (lead.resultSnapshot ?? {}) as { qualified?: unknown; stretch?: unknown };
    return {
      id: lead.id,
      createdAt: lead.createdAt.toISOString(),
      dealerCode: lead.dealerId,
      dealerName,
      customerName: lead.customerName,
      phone: lead.phone,
      city: lead.city,
      modelName,
      tenureMonths: lead.tenureMonths,
      expectedEmi: paiseToRupees(lead.expectedEmiPaise),
      upfrontAbility: paiseToRupees(lead.upfrontAbilityPaise),
      outcome: lead.filterOutcome,
      configVersionId: lead.configVersionId,
      otpVerifiedAt: lead.otpVerifiedAt?.toISOString() ?? null,
      waResultsStatus: lead.waResultsStatus,
      waResultsSentAt: lead.waResultsSentAt?.toISOString() ?? null,
      qualified: schemeLines(snap.qualified),
      stretch: schemeLines(snap.stretch),
    };
  });
}

/* ── MUTATIONS (versioned + audited) ────────────────────────────────────── */

export interface SettingsPatch {
  dealerMarginPaise?: number;
  nearBestWindowPct?: string;
  expectedEmiFilterRequired?: boolean;
  upfrontFilterRequired?: boolean;
  disclaimerText?: string;
  cardFooterDisclaimer?: string;
  contactPhone?: string;
  contactEmail?: string;
  contactWhatsapp?: string;
}

export async function saveSettings(actorId: string, patch: SettingsPatch) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(calcSettings).where(isNull(calcSettings.validTo)).limit(1);
    if (!current) throw new Error("No current settings row to edit.");
    const now = new Date();
    const cv = await mkVersion(tx, actorId, "Edit calculator settings", { entity: "settings", patch });
    await tx.update(calcSettings).set({ validTo: now }).where(eq(calcSettings.id, current.id));
    const merged = {
      dealerMarginPaise: patch.dealerMarginPaise ?? current.dealerMarginPaise,
      nearBestWindowPct: patch.nearBestWindowPct ?? current.nearBestWindowPct,
      expectedEmiFilterRequired: patch.expectedEmiFilterRequired ?? current.expectedEmiFilterRequired,
      upfrontFilterRequired: patch.upfrontFilterRequired ?? current.upfrontFilterRequired,
      disclaimerText: patch.disclaimerText ?? current.disclaimerText,
      cardFooterDisclaimer: patch.cardFooterDisclaimer ?? current.cardFooterDisclaimer,
      contactPhone: patch.contactPhone ?? current.contactPhone,
      contactEmail: patch.contactEmail ?? current.contactEmail,
      contactWhatsapp: patch.contactWhatsapp ?? current.contactWhatsapp,
      validFrom: now,
      configVersionId: cv,
    };
    const [inserted] = await tx.insert(calcSettings).values(merged).returning();
    await audit(tx, actorId, "update", "calc_settings", current.id, current, inserted, cv);
    return inserted;
  });
}

export async function saveComponentPrice(
  actorId: string,
  input: { modelId: number; component: "battery" | "charger" | "harness" | "soc" | "iot"; amountPaise?: number; gstMultiplier?: string },
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calcComponentPrices)
      .where(
        and(
          eq(calcComponentPrices.modelId, input.modelId),
          eq(calcComponentPrices.component, input.component),
          isNull(calcComponentPrices.validTo),
        ),
      )
      .limit(1);
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Edit ${input.component} price`, { entity: "component_prices", input });
    if (current) await tx.update(calcComponentPrices).set({ validTo: now }).where(eq(calcComponentPrices.id, current.id));
    const [inserted] = await tx
      .insert(calcComponentPrices)
      .values({
        modelId: input.modelId,
        component: input.component,
        amountPaise: input.amountPaise ?? current?.amountPaise ?? 0,
        gstMultiplier: input.gstMultiplier ?? current?.gstMultiplier ?? "1.18",
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    await audit(tx, actorId, current ? "update" : "create", "calc_component_prices", inserted.id, current ?? null, inserted, cv);
    return inserted;
  });
}

export interface NbfcPatch {
  name?: string;
  maxLoanCapPaise?: number | null;
  flatInterestRate?: string | null;
  fileFeePaise?: number;
  defaultProcessingFeePaise?: number;
  status?: "active" | "disabled";
}

export async function saveNbfc(actorId: string, nbfcId: number, patch: NbfcPatch) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calcNbfcs)
      .where(and(eq(calcNbfcs.id, nbfcId), isNull(calcNbfcs.validTo)))
      .limit(1);
    if (!current) throw new Error("NBFC not found.");
    // Variant A integrity: flat cap + rate required when active.
    const nextStatus = patch.status ?? current.status;
    const nextCap = patch.maxLoanCapPaise !== undefined ? patch.maxLoanCapPaise : current.maxLoanCapPaise;
    const nextRate = patch.flatInterestRate !== undefined ? patch.flatInterestRate : current.flatInterestRate;
    if (current.variant === "A" && nextStatus === "active" && (nextCap == null || nextRate == null)) {
      throw new Error("Variant A NBFC needs a flat cap and interest rate while active.");
    }
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Edit NBFC ${current.name}`, { entity: "nbfcs", nbfcId, patch });
    await tx.update(calcNbfcs).set({ validTo: now }).where(eq(calcNbfcs.id, current.id));
    const [inserted] = await tx
      .insert(calcNbfcs)
      .values({
        nbfcCode: current.nbfcCode,
        name: patch.name ?? current.name,
        variant: current.variant,
        maxLoanCapPaise: nextCap,
        flatInterestRate: nextRate,
        fileFeePaise: patch.fileFeePaise ?? current.fileFeePaise,
        defaultProcessingFeePaise: patch.defaultProcessingFeePaise ?? current.defaultProcessingFeePaise,
        status: nextStatus,
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    // Carry LIVE children to the new parent id — schemes/coverage/caps reference
    // calc_nbfcs.id, so without this the fresh NBFC row has no coverage (drops out
    // of eligibility) and no schemes/caps. Closed child rows keep the old id.
    for (const child of [calcSchemes, calcNbfcCoverage, calcNbfcModelCaps] as const) {
      await tx
        .update(child)
        .set({ nbfcId: inserted.id })
        .where(and(eq(child.nbfcId, current.id), isNull(child.validTo)));
    }
    await audit(tx, actorId, "update", "calc_nbfcs", current.id, current, inserted, cv);
    return inserted;
  });
}

export interface SchemeInput {
  nbfcId: number;
  schemeId?: number; // present = edit; absent = create
  tenure: number;
  advance: number;
  appliedInterestRate: string;
  processingFeePaise: number;
  advanceInterestRate: string;
  status?: "active" | "disabled";
}

export async function saveScheme(actorId: string, input: SchemeInput) {
  if (input.advance >= input.tenure) throw new Error("Advance months must be less than tenure.");
  const code = `${input.tenure}by${input.advance}`;
  return db.transaction(async (tx) => {
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Save scheme ${code}`, { entity: "schemes", input });
    let current = null;
    if (input.schemeId) {
      [current] = await tx
        .select()
        .from(calcSchemes)
        .where(and(eq(calcSchemes.id, input.schemeId), isNull(calcSchemes.validTo)))
        .limit(1);
      if (current) await tx.update(calcSchemes).set({ validTo: now }).where(eq(calcSchemes.id, current.id));
    }
    const [inserted] = await tx
      .insert(calcSchemes)
      .values({
        nbfcId: input.nbfcId,
        tenureMonths: input.tenure,
        advanceMonths: input.advance,
        code,
        appliedInterestRate: input.appliedInterestRate,
        processingFeePaise: input.processingFeePaise,
        advanceInterestRate: input.advanceInterestRate,
        status: input.status ?? "active",
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    await audit(tx, actorId, current ? "update" : "create", "calc_schemes", inserted.id, current ?? null, inserted, cv);
    return inserted;
  });
}

// Soft-delete a scheme: close the current row and replace it with a disabled one.
export async function deactivateScheme(actorId: string, schemeId: number) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calcSchemes)
      .where(and(eq(calcSchemes.id, schemeId), isNull(calcSchemes.validTo)))
      .limit(1);
    if (!current) throw new Error("Scheme not found.");
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Disable scheme ${current.code}`, { entity: "schemes", schemeId });
    await tx.update(calcSchemes).set({ validTo: now }).where(eq(calcSchemes.id, current.id));
    const [inserted] = await tx
      .insert(calcSchemes)
      .values({
        nbfcId: current.nbfcId,
        tenureMonths: current.tenureMonths,
        advanceMonths: current.advanceMonths,
        code: current.code,
        appliedInterestRate: current.appliedInterestRate,
        processingFeePaise: current.processingFeePaise,
        advanceInterestRate: current.advanceInterestRate,
        status: "disabled",
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    await audit(tx, actorId, "update", "calc_schemes", current.id, current, inserted, cv);
    return inserted;
  });
}

export async function saveModelCap(actorId: string, input: { nbfcId: number; modelId: number; maxLoanCapPaise: number }) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calcNbfcModelCaps)
      .where(
        and(
          eq(calcNbfcModelCaps.nbfcId, input.nbfcId),
          eq(calcNbfcModelCaps.modelId, input.modelId),
          isNull(calcNbfcModelCaps.validTo),
        ),
      )
      .limit(1);
    const now = new Date();
    const cv = await mkVersion(tx, actorId, "Edit per-model cap", { entity: "nbfc_model_caps", input });
    if (current) await tx.update(calcNbfcModelCaps).set({ validTo: now }).where(eq(calcNbfcModelCaps.id, current.id));
    const [inserted] = await tx
      .insert(calcNbfcModelCaps)
      .values({
        nbfcId: input.nbfcId,
        modelId: input.modelId,
        maxLoanCapPaise: input.maxLoanCapPaise,
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    await audit(tx, actorId, current ? "update" : "create", "calc_nbfc_model_caps", inserted.id, current ?? null, inserted, cv);
    return inserted;
  });
}

export async function addCoverageCity(
  actorId: string,
  input: { nbfcId: number; cityDisplay: string; stateCode: string },
) {
  const cityNormalized = input.cityDisplay.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [dupe] = await tx
      .select()
      .from(calcNbfcCoverage)
      .where(
        and(
          eq(calcNbfcCoverage.nbfcId, input.nbfcId),
          eq(calcNbfcCoverage.cityNormalized, cityNormalized),
          isNull(calcNbfcCoverage.validTo),
        ),
      )
      .limit(1);
    if (dupe) throw new Error(`${input.cityDisplay} already covered for this NBFC.`);
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Add city ${input.cityDisplay}`, { entity: "nbfc_coverage", input });
    const [inserted] = await tx
      .insert(calcNbfcCoverage)
      .values({
        nbfcId: input.nbfcId,
        coverageType: "CITY",
        cityNormalized,
        stateCode: input.stateCode.trim().toUpperCase(),
        cityDisplay: input.cityDisplay.trim(),
        validFrom: now,
        configVersionId: cv,
      })
      .returning();
    await audit(tx, actorId, "create", "calc_nbfc_coverage", inserted.id, null, inserted, cv);
    return inserted;
  });
}

export async function removeCoverageCity(actorId: string, coverageId: number) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(calcNbfcCoverage)
      .where(and(eq(calcNbfcCoverage.id, coverageId), isNull(calcNbfcCoverage.validTo)))
      .limit(1);
    if (!current) throw new Error("Coverage row not found.");
    const now = new Date();
    const cv = await mkVersion(tx, actorId, `Remove city ${current.cityDisplay ?? ""}`, { entity: "nbfc_coverage", coverageId });
    await tx.update(calcNbfcCoverage).set({ validTo: now }).where(eq(calcNbfcCoverage.id, current.id));
    await audit(tx, actorId, "delete", "calc_nbfc_coverage", current.id, current, null, cv);
    return { ok: true };
  });
}
