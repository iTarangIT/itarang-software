/**
 * E-067 — /admin/nbfc/risk-rules page (BRD §6.3.3).
 *
 * Admin-only Risk Rule Engine view. Lists the eight platform thresholds and
 * lets the admin preview the impact of a proposed change before raising it
 * for dual approval (E-085 owns the actual commit). Route protection is
 * provided by `src/middleware.ts` which gates `/admin/*` to admin-grade roles.
 */
import RiskRuleEngineForm from "@/components/admin/nbfc/RiskRuleEngineForm";

export const dynamic = "force-dynamic";

export default function RiskRulesPage() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="mb-2 text-2xl font-semibold text-gray-900">
        Risk Rule Engine
      </h1>
      <p className="mb-6 text-sm text-gray-600">
        Platform-wide thresholds that drive CDS bands, alert triggers, and
        action gates. Every change requires dual approval (BRD §6.3.3).
      </p>
      <RiskRuleEngineForm />
    </main>
  );
}
