/**
 * Tools the risk-hypothesis LangGraph agent can call. Each tool is a thin
 * wrapper around an existing typed query helper, returning a JSON-safe shape
 * that LangChain can serialize into the model context.
 *
 * All tools take a tenant context and only return data scoped to that tenant.
 * The agent never sees raw global telemetry — only the tenant's slice.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfcLoans } from "@/lib/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import {
  getDailyKm,
  getFleetSummary,
  getSohDelta30d,
  getVehicleStates,
} from "@/lib/db/iot-queries";
import type { TenantContext } from "@/lib/nbfc/tenant";

// Resolve the tenant's vehicleno set inside each tool call so the agent never
// has to pass it. Cached for ~1 minute.
const vnoCache = new Map<string, { vnos: string[]; expires: number }>();
async function resolveTenantVnos(tenantId: string): Promise<string[]> {
  const cached = vnoCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.vnos;
  const rows = await db
    .select({ vehicleno: nbfcLoans.vehicleno })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, tenantId), eq(nbfcLoans.is_active, true)));
  const vnos = rows.map((r) => r.vehicleno).filter((v): v is string => !!v);
  vnoCache.set(tenantId, { vnos, expires: Date.now() + 60_000 });
  return vnos;
}

export function buildRiskTools(tenant: TenantContext) {
  const getCrmLoanSlice = tool(
    async (input: { min_dpd?: number; only_active_emi?: boolean }) => {
      const conds = [eq(nbfcLoans.tenant_id, tenant.id)];
      if (input.only_active_emi) conds.push(sql`${nbfcLoans.emi_amount} > 0`);
      if (typeof input.min_dpd === "number") conds.push(gte(nbfcLoans.current_dpd, input.min_dpd));
      const rows = await db
        .select({
          loan_application_id: nbfcLoans.loan_application_id,
          vehicleno: nbfcLoans.vehicleno,
          current_dpd: nbfcLoans.current_dpd,
          emi_amount: nbfcLoans.emi_amount,
          outstanding_amount: nbfcLoans.outstanding_amount,
        })
        .from(nbfcLoans)
        .where(and(...conds));
      return JSON.stringify({
        count: rows.length,
        sample: rows.slice(0, 25),
        truncated: rows.length > 25,
      });
    },
    {
      name: "getCrmLoanSlice",
      description:
        "Returns a slice of the tenant's loans, optionally filtered by minimum DPD or active-EMI flag. Returns counts plus a sample of up to 25 rows.",
      schema: z.object({
        min_dpd: z.number().int().min(0).optional().describe("Minimum days-past-due"),
        only_active_emi: z.boolean().optional().describe("Restrict to loans with non-zero EMI amount"),
      }),
    },
  );

  const getIotFleetSummary = tool(
    async () => {
      const vnos = await resolveTenantVnos(tenant.id);
      const summary = await getFleetSummary(vnos);
      return JSON.stringify(summary);
    },
    {
      name: "getIotFleetSummary",
      description:
        "Returns the IoT fleet summary (total / online / fresh_5m / with_lat / avg_soc / avg_pack_voltage / open_alerts) for this tenant's vehicles.",
      schema: z.object({}),
    },
  );

  const getCohortBaseline = tool(
    async (input: { metric: "km_7d" | "soh_delta_30d" | "soc_now" }) => {
      const vnos = await resolveTenantVnos(tenant.id);
      if (input.metric === "km_7d") {
        const daily = await getDailyKm(vnos, 14);
        const recentByVno = new Map<string, number>();
        const sevenAgo = Date.now() - 7 * 86400_000;
        for (const r of daily) {
          if (r.day.getTime() < sevenAgo) continue;
          recentByVno.set(r.vehicleno, (recentByVno.get(r.vehicleno) ?? 0) + r.km);
        }
        const vals = [...recentByVno.values()];
        return JSON.stringify(percentiles(vals));
      }
      if (input.metric === "soh_delta_30d") {
        const decay = await getSohDelta30d(vnos);
        return JSON.stringify(percentiles(decay.map((d) => d.delta)));
      }
      if (input.metric === "soc_now") {
        const states = await getVehicleStates(vnos);
        return JSON.stringify(
          percentiles(states.map((s) => s.soc_pct).filter((s): s is number => s != null)),
        );
      }
      return JSON.stringify({ error: "unknown metric" });
    },
    {
      name: "getCohortBaseline",
      description:
        "Returns a percentile distribution (p10, p25, p50, p75, p90, count) of a tenant-wide metric. Use this to anchor hypothesis thresholds against the cohort instead of guessing.",
      schema: z.object({
        metric: z.enum(["km_7d", "soh_delta_30d", "soc_now"]),
      }),
    },
  );

  return [getCrmLoanSlice, getIotFleetSummary, getCohortBaseline];
}

function percentiles(vals: number[]) {
  if (vals.length === 0) return { count: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    count: sorted.length,
    p10: at(10),
    p25: at(25),
    p50: at(50),
    p75: at(75),
    p90: at(90),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
