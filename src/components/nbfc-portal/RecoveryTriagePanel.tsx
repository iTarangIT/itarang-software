"use client";

/**
 * E-292 — Recovery triage (refurbish flow v3, R2/R3), for one battery.
 *
 * R2: the operator types the pack's rated and measured voltage (plus
 * condition and a note) and the health % + the system's suggestion appear
 * live. R3: three branch buttons. Refurbish is disabled under the 70% floor
 * with the design's exact words — "not suitable for refurbishing"; auction /
 * redeploy / scrap are the NBFC's call at any health.
 *
 * Photos stay on BatteryPhotoCapture (the same five angles the auction
 * reuses); this panel sits beside it on the register row.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { nbfcFetch } from "@/lib/auction/client";
import {
  TRIAGE_CHOICE_LABEL,
  TRIAGE_FIT_MIN_PCT,
  TRIAGE_REFURB_MIN_PCT,
  TRIAGE_SUGGESTION_LABEL,
  allowedChoices,
  healthPct,
  suggestTriage,
  type TriageChoice,
  type TriageCondition,
} from "@/lib/nbfc/recovery/triage-rules";

export interface TriageBattery {
  id: string;
  serial: string;
  model: string | null;
  state_code: string;
  rated_voltage_v: number | null;
  measured_voltage_v: number | null;
  health_pct: number | null;
  triage_condition: string | null;
  triage_note: string | null;
  triage_suggestion: string | null;
  triage_choice: string | null;
  triaged_at: string | null;
  recovery_pipeline_id: string | null;
}

const RATED_PRESETS = [48, 51, 60, 72];

export default function RecoveryTriagePanel({ battery, onChange }: { battery: TriageBattery; onChange?: () => void }) {
  const [rated, setRated] = useState(battery.rated_voltage_v != null ? String(battery.rated_voltage_v) : "51");
  const [measured, setMeasured] = useState(battery.measured_voltage_v != null ? String(battery.measured_voltage_v) : "");
  const [condition, setCondition] = useState<TriageCondition | "">((battery.triage_condition as TriageCondition | null) ?? "");
  const [note, setNote] = useState(battery.triage_note ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  const liveHealth = useMemo(() => healthPct(Number(measured), Number(rated)), [measured, rated]);
  const liveSuggestion = suggestTriage(liveHealth);
  const saved = battery.health_pct != null;
  const dirty = !saved || String(battery.rated_voltage_v) !== rated || String(battery.measured_voltage_v) !== measured || (battery.triage_condition ?? "") !== condition || (battery.triage_note ?? "") !== note;
  const choices = allowedChoices(battery.health_pct);
  const over = ["lotted", "sold", "scrapped", "refurbishing"].includes(battery.state_code);

  async function record() {
    setBusy("record");
    try {
      await nbfcFetch(`/api/nbfc/recovery/batteries/${battery.id}/triage`, {
        method: "POST",
        body: JSON.stringify({ action: "record", rated_voltage_v: Number(rated), measured_voltage_v: Number(measured), condition: condition || null, note: note.trim() || null }),
      });
      toast.success(`Health ${liveHealth}% — ${liveSuggestion ? TRIAGE_SUGGESTION_LABEL[liveSuggestion] : ""}`);
      onChange?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function choose(choice: TriageChoice) {
    setBusy(choice);
    try {
      const r = await nbfcFetch<{ transition: { published_lot?: { lot_code: string } } | null }>(`/api/nbfc/recovery/batteries/${battery.id}/triage`, {
        method: "POST",
        body: JSON.stringify({ action: "choose", choice }),
      });
      toast.success(
        choice === "refurbish"
          ? "Marked refurbishable — send it in a lot from the Refurbishment page."
          : choice === "auction"
            ? `Sent to auction${r.transition?.published_lot ? ` as ${r.transition.published_lot.lot_code}` : ""}.`
            : choice === "scrap"
              ? "Marked scrap — it appears on the Scrap Sales page."
              : "Redeploy recorded — iTarang has been asked to help.",
      );
      onChange?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="auc-panel" style={{ marginBlockStart: ".75rem" }}>
      <header><span className="auc-panel-n">⚡</span><h3>Recovery details &amp; triage</h3></header>
      <div className="auc-panel-body">
        {over ? <p className="auc-hint">Triage is over for this battery — it is {battery.state_code.replace(/_/g, " ")}.</p> : null}
        <div className="auc-dl" style={{ gap: ".75rem" }}>
          <div className="auc-field">
            <label>Rated pack voltage (V)</label>
            <div className="auc-linkrow">
              <input className="auc-text" data-numeric="true" inputMode="decimal" style={{ width: "6rem" }} value={rated} disabled={over} onChange={(e) => setRated(e.target.value.replace(/[^\d.]/g, ""))} />
              {RATED_PRESETS.map((v) => <button key={v} type="button" className="auc-btn" data-variant="ghost" disabled={over} onClick={() => setRated(String(v))}>{v} V</button>)}
            </div>
          </div>
          <div className="auc-field"><label>Measured pack voltage (V)</label><input className="auc-text" data-numeric="true" inputMode="decimal" style={{ width: "8rem" }} value={measured} disabled={over} onChange={(e) => setMeasured(e.target.value.replace(/[^\d.]/g, ""))} placeholder="at the terminals" /></div>
          <div className="auc-field">
            <label>Condition</label>
            <select className="auc-text" value={condition} disabled={over} onChange={(e) => setCondition(e.target.value as TriageCondition | "")}>
              <option value="">—</option><option value="good">good</option><option value="fair">fair</option><option value="poor">poor</option>
            </select>
          </div>
          <div className="auc-field"><label>Note</label><input className="auc-text" value={note} disabled={over} onChange={(e) => setNote(e.target.value)} placeholder="casing, terminals, BMS, what the meter showed" /></div>
        </div>

        <div className="auc-ledger" style={{ marginBlockStart: ".75rem", maxWidth: "30rem" }}>
          <div className="auc-ledger-row" data-total="true"><span>Health = measured ÷ rated</span><b>{liveHealth != null ? `${liveHealth}%` : "—"}</b></div>
          <div className="auc-ledger-row">
            <span>System suggests</span>
            <b>{liveSuggestion ? <span className="auc-chip" data-tone={liveSuggestion === "fit_as_is" ? "live" : liveSuggestion === "refurbish" ? "warn" : "muted"}>{TRIAGE_SUGGESTION_LABEL[liveSuggestion]}</span> : "—"}</b>
          </div>
        </div>
        <span className="auc-hint">Fit as-is at or above {TRIAGE_FIT_MIN_PCT}% (40 V of a 51 V pack) · refurbish {TRIAGE_REFURB_MIN_PCT}–{TRIAGE_FIT_MIN_PCT}% (35–40 V) · scrap under {TRIAGE_REFURB_MIN_PCT}% (35 V). A suggestion, not a decision — you click the branch.</span>

        {!over ? (
          <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
            <button type="button" className="auc-btn" disabled={busy !== null || liveHealth == null} onClick={() => void record()}>{busy === "record" ? "Saving…" : saved && !dirty ? "Recovery details saved" : saved ? "Update recovery details" : "Save recovery details"}</button>
            {battery.triaged_at ? <span className="auc-subtle">recorded {new Date(battery.triaged_at).toLocaleDateString("en-IN")}</span> : null}
          </div>
        ) : null}

        {saved && !over ? (
          <div style={{ marginBlockStart: "1rem" }}>
            <span className="auc-label">Where does it go?{battery.triage_choice ? ` (chosen: ${TRIAGE_CHOICE_LABEL[battery.triage_choice as TriageChoice] ?? battery.triage_choice})` : ""}</span>
            <div className="auc-linkrow" style={{ marginBlockStart: ".5rem" }}>
              {(["auction", "redeploy", "refurbish", "scrap"] as TriageChoice[]).map((c) => {
                const allowed = choices.includes(c);
                const suggested = battery.triage_suggestion === (c === "auction" || c === "redeploy" ? "fit_as_is" : c);
                return (
                  <button key={c} type="button" className="auc-btn" data-variant={suggested ? undefined : "ghost"} disabled={busy !== null || !allowed || dirty}
                    title={!allowed ? `Health ${battery.health_pct}% — not suitable for refurbishing (floor ${TRIAGE_REFURB_MIN_PCT}%)` : dirty ? "Save the recovery details first" : undefined}
                    onClick={() => void choose(c)}>
                    {busy === c ? "…" : TRIAGE_CHOICE_LABEL[c]}{suggested ? " ★" : ""}
                  </button>
                );
              })}
            </div>
            {!choices.includes("refurbish") ? <span className="auc-hint" style={{ color: "var(--auc-warn)" }}>Not suitable for refurbishing — auction as-is, redeploy, or scrap.</span> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
