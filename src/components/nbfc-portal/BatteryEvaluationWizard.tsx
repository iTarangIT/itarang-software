"use client";

/**
 * E-037 — BatteryEvaluationWizard (BRD §6.1.7)
 *
 * 3-step wizard a Recovery operator fills in for a battery on the recovery
 * pipeline. Step 1 captures technical data; Step 2 captures the refurbishment
 * decision and checklist; Step 3 captures pricing and submits to
 * POST /api/nbfc/recovery/[id]/evaluation. The base auction price is computed
 * server-side and surfaced back in the result panel.
 */
import { useState } from "react";

interface Step1State {
  soh_percent: string;
  physical_condition: "good" | "fair" | "poor";
  manufacturing_date: string;
  iot_status: "online" | "offline";
  bms_health: "healthy" | "degraded" | "failed";
  charger_type: string;
}

interface Step2State {
  decision: "minor_repair" | "cell_replacement" | "scrap";
  estimated_cost: string;
  terminal_cleaning: boolean;
  software_recalibration: boolean;
  warranty_reset: boolean;
}

interface Step3State {
  original_value: string;
  reject: boolean;
}

interface EvaluationResult {
  evaluation_id: string;
  base_auction_price: number;
  rejected: boolean;
}

interface Props {
  recoveryPipelineId: string;
  onComplete?: (result: EvaluationResult) => void;
}

export function BatteryEvaluationWizard({
  recoveryPipelineId,
  onComplete,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);

  const [s1, setS1] = useState<Step1State>({
    soh_percent: "",
    physical_condition: "good",
    manufacturing_date: "",
    iot_status: "online",
    bms_health: "healthy",
    charger_type: "",
  });
  const [s2, setS2] = useState<Step2State>({
    decision: "minor_repair",
    estimated_cost: "",
    terminal_cleaning: false,
    software_recalibration: false,
    warranty_reset: false,
  });
  const [s3, setS3] = useState<Step3State>({
    original_value: "",
    reject: false,
  });

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        step1: {
          soh_percent: Number(s1.soh_percent),
          physical_condition: s1.physical_condition,
          manufacturing_date: s1.manufacturing_date,
          iot_status: s1.iot_status,
          bms_health: s1.bms_health,
          charger_type: s1.charger_type,
        },
        step2: {
          decision: s2.decision,
          estimated_cost: Number(s2.estimated_cost),
          checklist: {
            terminal_cleaning: s2.terminal_cleaning,
            software_recalibration: s2.software_recalibration,
            warranty_reset: s2.warranty_reset,
          },
        },
        step3: {
          original_value: Number(s3.original_value),
          reject: s3.reject,
        },
      };

      const res = await fetch(
        `/api/nbfc/recovery/${recoveryPipelineId}/evaluation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setResult(json as EvaluationResult);
      setStep(4);
      onComplete?.(json as EvaluationResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Battery Evaluation</h2>
        <span className="text-xs text-slate-500">Step {step} of 3</span>
      </header>

      {step === 1 && (
        <div className="space-y-3">
          <label className="block text-sm">
            <span>SOH %</span>
            <input
              type="number"
              min={0}
              max={100}
              value={s1.soh_percent}
              onChange={(e) => setS1({ ...s1, soh_percent: e.target.value })}
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            <span>Physical condition</span>
            <select
              value={s1.physical_condition}
              onChange={(e) =>
                setS1({
                  ...s1,
                  physical_condition: e.target
                    .value as Step1State["physical_condition"],
                })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            >
              <option value="good">Good</option>
              <option value="fair">Fair</option>
              <option value="poor">Poor</option>
            </select>
          </label>
          <label className="block text-sm">
            <span>Manufacturing date</span>
            <input
              type="date"
              value={s1.manufacturing_date}
              onChange={(e) =>
                setS1({ ...s1, manufacturing_date: e.target.value })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            <span>IoT status</span>
            <select
              value={s1.iot_status}
              onChange={(e) =>
                setS1({
                  ...s1,
                  iot_status: e.target.value as Step1State["iot_status"],
                })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            >
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>
          </label>
          <label className="block text-sm">
            <span>BMS health</span>
            <select
              value={s1.bms_health}
              onChange={(e) =>
                setS1({
                  ...s1,
                  bms_health: e.target.value as Step1State["bms_health"],
                })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            >
              <option value="healthy">Healthy</option>
              <option value="degraded">Degraded</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="block text-sm">
            <span>Charger type</span>
            <input
              type="text"
              value={s1.charger_type}
              onChange={(e) => setS1({ ...s1, charger_type: e.target.value })}
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded bg-slate-900 px-4 py-1 text-sm text-white"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <label className="block text-sm">
            <span>Decision</span>
            <select
              value={s2.decision}
              onChange={(e) =>
                setS2({
                  ...s2,
                  decision: e.target.value as Step2State["decision"],
                })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            >
              <option value="minor_repair">Minor Repair</option>
              <option value="cell_replacement">Cell Replacement</option>
              <option value="scrap">Scrap</option>
            </select>
          </label>
          <label className="block text-sm">
            <span>Estimated refurb cost</span>
            <input
              type="number"
              min={0}
              value={s2.estimated_cost}
              onChange={(e) =>
                setS2({ ...s2, estimated_cost: e.target.value })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Checklist</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={s2.terminal_cleaning}
                onChange={(e) =>
                  setS2({ ...s2, terminal_cleaning: e.target.checked })
                }
              />
              Terminal cleaning
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={s2.software_recalibration}
                onChange={(e) =>
                  setS2({
                    ...s2,
                    software_recalibration: e.target.checked,
                  })
                }
              />
              Software recalibration
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={s2.warranty_reset}
                onChange={(e) =>
                  setS2({ ...s2, warranty_reset: e.target.checked })
                }
              />
              Warranty reset
            </label>
          </fieldset>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border px-4 py-1 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded bg-slate-900 px-4 py-1 text-sm text-white"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <label className="block text-sm">
            <span>Original value</span>
            <input
              type="number"
              min={0}
              value={s3.original_value}
              onChange={(e) =>
                setS3({ ...s3, original_value: e.target.value })
              }
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s3.reject}
              onChange={(e) => setS3({ ...s3, reject: e.target.checked })}
            />
            Reject (unsalvageable; base price will be 0)
          </label>
          {error && (
            <p className="rounded bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded border px-4 py-1 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={submit}
              className="rounded bg-emerald-600 px-4 py-1 text-sm text-white disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Submit evaluation"}
            </button>
          </div>
        </div>
      )}

      {step === 4 && result && (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-emerald-700">Evaluation recorded.</p>
          <p>
            Evaluation ID:{" "}
            <code className="rounded bg-slate-100 px-1">
              {result.evaluation_id}
            </code>
          </p>
          <p>
            Base auction price:{" "}
            <span className="font-semibold">
              {result.rejected
                ? "Rejected"
                : `₹${result.base_auction_price.toLocaleString("en-IN")}`}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

export default BatteryEvaluationWizard;
