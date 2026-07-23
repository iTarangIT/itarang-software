"use client";

/**
 * RiskCardCatalogue — the card-centric admin Risk Cards screen.
 *
 * Renders every non-retired risk hypothesis as a card with two actions:
 *   • Info   — a read-only panel explaining the card (logic, data pulled, data
 *              shown, severity), sourced from src/lib/risk/card-info.ts.
 *   • Select — a multi-select of activated NBFC partners. Saving PUTs to
 *              /api/admin/nbfc/risk-cards/[hypothesisId], which writes the
 *              nbfc_risk_card_visibility allowlist so the card appears on the
 *              chosen partners' Risk Alert dashboard.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  Database,
  Cpu,
  Info,
  Search,
  ShieldAlert,
  Target,
  Users,
  X,
} from "lucide-react";
import {
  getCardInfo,
  SEVERITY_VOCAB,
  type RiskCardExample,
  type RiskCardInput,
} from "@/lib/risk/card-info";

export interface CatalogueCard {
  id: string;
  slug: string;
  title: string;
  description: string;
  source: string;
  isPromoted: boolean;
}

export interface CatalogueNbfc {
  id: number;
  nbfcId: string;
  legalName: string;
}

interface Props {
  cards: CatalogueCard[];
  nbfcs: CatalogueNbfc[];
  selectedByCard: Record<string, number[]>;
}

function isAi(source: string) {
  return source !== "human";
}

export default function RiskCardCatalogue({
  cards,
  nbfcs,
  selectedByCard,
}: Props) {
  const [infoCard, setInfoCard] = useState<CatalogueCard | null>(null);
  const [selectCard, setSelectCard] = useState<CatalogueCard | null>(null);
  const searchParams = useSearchParams();

  // Deep-link from global search: /admin/nbfc/risk-cards?card=<id|slug> opens
  // that card's Info panel on arrival.
  useEffect(() => {
    const target = searchParams.get("card");
    if (!target) return;
    const match = cards.find((c) => c.id === target || c.slug === target);
    if (match) setInfoCard(match);
  }, [searchParams, cards]);

  if (cards.length === 0) {
    return (
      <div className="card-iTarang p-10 text-center">
        <p className="section-label-muted">No risk cards</p>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
          No active risk hypotheses are defined yet.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map((card) => {
          const count = selectedByCard[card.id]?.length ?? 0;
          const ai = isAi(card.source);
          return (
            <div
              key={card.id}
              className="card-iTarang p-5 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[color:var(--color-bg)] text-[color:var(--color-brand-sky)] shrink-0">
                  <ShieldAlert className="w-4 h-4" />
                </span>
                <span className={ai ? "status-pill-info" : "status-pill-success"}>
                  {ai ? "AI generated" : "Hand-coded"}
                </span>
              </div>

              <div>
                <h3 className="font-semibold text-[color:var(--color-brand-navy)] leading-snug">
                  {card.title}
                </h3>
                <p className="text-[11px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                  {card.slug}
                </p>
              </div>

              <p className="text-[13px] text-[color:var(--color-ink)] line-clamp-3 flex-1">
                {card.description}
              </p>

              <div className="flex items-center gap-1.5 text-[12px] text-[color:var(--color-ink-muted)]">
                <Users className="w-3.5 h-3.5" />
                {count === 0 ? (
                  <span>Not visible to any partner</span>
                ) : (
                  <span>
                    Visible to{" "}
                    <span className="font-semibold text-[color:var(--color-brand-navy)]">
                      {count}
                    </span>{" "}
                    {count === 1 ? "partner" : "partners"}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setInfoCard(card)}
                  className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-semibold transition-all border hover:bg-[color:var(--color-bg)]"
                  style={{
                    color: "var(--color-brand-navy)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  <Info className="w-3.5 h-3.5" />
                  Info
                </button>
                <button
                  type="button"
                  onClick={() => setSelectCard(card)}
                  className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-semibold text-white transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5"
                  style={{ background: "var(--color-brand-sky)" }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Select
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {infoCard && (
        <InfoModal card={infoCard} onClose={() => setInfoCard(null)} />
      )}
      {selectCard && (
        <SelectModal
          card={selectCard}
          nbfcs={nbfcs}
          initialSelected={selectedByCard[selectCard.id] ?? []}
          onClose={() => setSelectCard(null)}
        />
      )}
    </>
  );
}

// ─── Info modal ──────────────────────────────────────────────────────────────

function InfoSection({
  label,
  items,
  ordered,
}: {
  label: string;
  items: string[];
  ordered?: boolean;
}) {
  if (items.length === 0) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <div>
      <p className="section-label-muted mb-1.5">{label}</p>
      <List
        className={`space-y-1.5 text-[13px] text-[color:var(--color-ink)] ${
          ordered ? "list-decimal pl-5" : "list-disc pl-5"
        }`}
      >
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </List>
    </div>
  );
}

/**
 * Split the single-line "IN: … → PROCESS: … → OUT: …" flow string into its
 * three stages. Every entry in card-info.ts (hand-coded and the AI fallback)
 * follows this exact shape, so the parse is reliable; if it ever doesn't match,
 * we fall back to showing the whole string as the process stage.
 */
function parseFlow(flow: string): { in: string; process: string; out: string } {
  const m = flow.match(
    /IN:\s*([\s\S]*?)\s*(?:→|->)\s*PROCESS:\s*([\s\S]*?)\s*(?:→|->)\s*OUT:\s*([\s\S]*)/,
  );
  if (!m) return { in: "", process: flow, out: "" };
  return { in: m[1].trim(), process: m[2].trim(), out: m[3].trim() };
}

/** One stage box in the Input → Output diagram. */
function FlowNode({
  badge,
  title,
  accent,
  icon,
  children,
}: {
  badge: string;
  title: string;
  accent: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border bg-[color:var(--color-surface)] p-3"
      style={{ borderColor: "var(--color-border)", borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0"
          style={{ background: "var(--color-bg)", color: accent }}
        >
          {icon}
        </span>
        <span
          className="text-[10px] font-bold uppercase tracking-[0.1em]"
          style={{ color: accent }}
        >
          {badge}
        </span>
        <span className="text-[12px] font-semibold text-[color:var(--color-brand-navy)]">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex justify-center py-1" aria-hidden>
      <ArrowDown className="w-4 h-4 text-[color:var(--color-ink-muted)]" />
    </div>
  );
}

/**
 * A compact input → process → output diagram, so the reader can see at a glance
 * which tables the card reads and which vehicles/borrowers it flags as output.
 */
function FlowDiagram({
  inputs,
  flow,
}: {
  inputs: RiskCardInput[];
  flow: string;
}) {
  const parsed = parseFlow(flow);
  return (
    <div>
      <p className="section-label-muted mb-1.5">Input → Output (at a glance)</p>
      <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 p-4">
        {/* INPUT — the tables/data feeds it reads */}
        <FlowNode
          badge="In"
          title="Data it reads"
          accent="var(--color-brand-sky)"
          icon={<Database className="w-3.5 h-3.5" />}
        >
          <ul className="space-y-1">
            {inputs.map((row, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-snug"
              >
                <span className="font-mono font-semibold text-[color:var(--color-brand-navy)]">
                  {row.table}
                </span>
                <span className="text-[color:var(--color-ink-muted)]">·</span>
                <span className="text-[color:var(--color-ink-muted)]">{row.source}</span>
              </li>
            ))}
          </ul>
          {parsed.in && (
            <p className="text-[11px] text-[color:var(--color-ink-muted)] mt-1.5">
              {parsed.in}
            </p>
          )}
        </FlowNode>

        <FlowArrow />

        {/* PROCESS — what the evaluator computes */}
        <FlowNode
          badge="Process"
          title="What it computes"
          accent="var(--color-brand-teal)"
          icon={<Cpu className="w-3.5 h-3.5" />}
        >
          <p className="text-[12px] leading-snug text-[color:var(--color-ink)]">
            {parsed.process}
          </p>
        </FlowNode>

        <FlowArrow />

        {/* OUTPUT — the vehicles/borrowers the card surfaces */}
        <FlowNode
          badge="Out"
          title="What you get"
          accent="var(--color-brand-navy)"
          icon={<Target className="w-3.5 h-3.5" />}
        >
          <p className="text-[12px] leading-snug text-[color:var(--color-ink)]">
            {parsed.out || "The borrowers/vehicles that crossed the threshold."}
          </p>
        </FlowNode>
      </div>
    </div>
  );
}

function InputTablesSection({ inputs }: { inputs: RiskCardInput[] }) {
  if (inputs.length === 0) return null;
  return (
    <div>
      <p className="section-label-muted mb-1.5">Input tables &amp; data sources</p>
      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-border)]">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="text-left">
              {["Input / table", "Data source", "What it provides"].map((c) => (
                <th
                  key={c}
                  className="py-1.5 px-2.5 font-bold uppercase tracking-[0.08em] text-[10px] text-[color:var(--color-ink-muted)] border-b border-[color:var(--color-border)] whitespace-nowrap bg-[color:var(--color-bg)]/60"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inputs.map((row, i) => (
              <tr key={i}>
                <td className="py-1.5 px-2.5 border-b border-[color:var(--color-border)]/60 font-mono text-[color:var(--color-brand-navy)] whitespace-nowrap align-top">
                  {row.table}
                </td>
                <td className="py-1.5 px-2.5 border-b border-[color:var(--color-border)]/60 whitespace-nowrap align-top text-[color:var(--color-ink)]">
                  {row.source}
                </td>
                <td className="py-1.5 px-2.5 border-b border-[color:var(--color-border)]/60 align-top text-[color:var(--color-ink)]">
                  {row.provides}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function severityPillClass(severity: string): string {
  const s = severity.toLowerCase();
  if (s.includes("high")) return "status-pill-danger";
  if (s.includes("warn")) return "status-pill-warning";
  if (s.includes("ok")) return "status-pill-success";
  return "status-pill-neutral";
}

function ExampleSection({ example }: { example: RiskCardExample }) {
  return (
    <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="section-label-muted">Sample run — what the partner sees</p>
        <span className={severityPillClass(example.severity)}>
          {example.severity}
        </span>
      </div>
      <p className="text-[13px] font-medium text-[color:var(--color-ink)]">
        “{example.finding}”
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="text-left">
              {example.table.columns.map((c) => (
                <th
                  key={c}
                  className="py-1.5 px-2 font-bold uppercase tracking-[0.08em] text-[10px] text-[color:var(--color-ink-muted)] border-b border-[color:var(--color-border)] whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {example.table.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`py-1.5 px-2 border-b border-[color:var(--color-border)]/60 whitespace-nowrap ${
                      ci === 0
                        ? "font-mono text-[color:var(--color-brand-navy)]"
                        : "text-[color:var(--color-ink)]"
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-[color:var(--color-ink-muted)]">
        {example.reading}
      </p>
    </div>
  );
}

function InfoModal({
  card,
  onClose,
}: {
  card: CatalogueCard;
  onClose: () => void;
}) {
  const info = useMemo(() => getCardInfo(card), [card]);
  return (
    <ModalShell onClose={onClose} labelledBy="risk-info-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="section-label-muted">Risk card · Info</p>
          <h2
            id="risk-info-title"
            className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1"
          >
            {card.title}
          </h2>
          <p className="text-[11px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
            {card.slug}
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div className="space-y-4">
        <div>
          <p className="section-label-muted mb-1.5">Function — what this card does</p>
          <p className="text-[13px] text-[color:var(--color-ink)]">
            {info.whatItDoes}
          </p>
        </div>
        <div>
          <p className="section-label-muted mb-1.5">Function that builds this card</p>
          <p className="text-[13px] text-[color:var(--color-ink)]">
            <code className="font-mono font-semibold text-[color:var(--color-brand-navy)] bg-[color:var(--color-bg)] rounded px-1.5 py-0.5">
              {info.evaluator.fn}
            </code>{" "}
            <span className="text-[color:var(--color-ink-muted)]">
              ({info.evaluator.file})
            </span>
          </p>
        </div>
        <FlowDiagram inputs={info.inputTables} flow={info.flow} />
        <InputTablesSection inputs={info.inputTables} />
        <InfoSection
          label="Internal processing (step by step)"
          items={info.logic}
          ordered
        />
        <InfoSection label="Outputs — what the partner sees" items={info.dataShown} />
        <ExampleSection example={info.example} />
        <div>
          <p className="section-label-muted mb-1.5">Severity</p>
          <p className="text-[13px] text-[color:var(--color-ink)]">
            {info.severityMeaning}
          </p>
        </div>
        <InfoSection label="Thresholds" items={info.thresholds} />
        <div className="flex items-start gap-2 text-[12px] text-[color:var(--color-ink-muted)] border-t border-[color:var(--color-border)] pt-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{SEVERITY_VOCAB}</span>
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <button type="button" onClick={onClose} className="btn-ghost">
          Close
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Select modal ────────────────────────────────────────────────────────────

function SelectModal({
  card,
  nbfcs,
  initialSelected,
  onClose,
}: {
  card: CatalogueCard;
  nbfcs: CatalogueNbfc[];
  initialSelected: number[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(initialSelected),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return nbfcs;
    return nbfcs.filter(
      (n) =>
        n.legalName.toLowerCase().includes(term) ||
        n.nbfcId.toLowerCase().includes(term),
    );
  }, [nbfcs, q]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      filtered.forEach((n) => next.add(n.id));
      return next;
    });
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/risk-cards/${card.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nbfc_ids: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setError(
          (typeof data?.message === "string" && data.message) ||
            `Save failed (HTTP ${res.status})`,
        );
        setSaving(false);
        return;
      }
      setSaving(false);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSaving(false);
    }
  }

  return (
    <ModalShell onClose={saving ? undefined : onClose} labelledBy="risk-select-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="section-label-muted">Risk card · Select partners</p>
          <h2
            id="risk-select-title"
            className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1"
          >
            {card.title}
          </h2>
          <p className="text-[13px] text-[color:var(--color-ink-muted)] mt-1">
            Choose the NBFC partners this card should appear for. Selected
            partners see it on their Risk Alert dashboard immediately.
          </p>
        </div>
        <CloseButton onClose={saving ? undefined : onClose} />
      </div>

      {nbfcs.length === 0 ? (
        <div className="text-center py-8 text-sm text-[color:var(--color-ink-muted)]">
          No activated NBFC partners available.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-ink-muted)]" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search partners…"
                className="input-itarang pl-10"
              />
            </div>
            <span className="text-[12px] text-[color:var(--color-ink-muted)] whitespace-nowrap">
              {selected.size} selected
            </span>
          </div>

          <div className="flex items-center gap-3 text-[12px]">
            <button
              type="button"
              onClick={selectAllFiltered}
              className="font-semibold text-[color:var(--color-brand-sky)] hover:underline"
            >
              Select all{q.trim() ? " (matches)" : ""}
            </button>
            <span className="text-[color:var(--color-border)]">|</span>
            <button
              type="button"
              onClick={clearAll}
              className="font-semibold text-[color:var(--color-ink-muted)] hover:underline"
            >
              Clear all
            </button>
          </div>

          <div className="max-h-[45vh] overflow-y-auto -mx-1 px-1 divide-y divide-[color:var(--color-border)]">
            {filtered.length === 0 ? (
              <p className="text-center py-6 text-sm text-[color:var(--color-ink-muted)]">
                No partners match “{q}”.
              </p>
            ) : (
              filtered.map((n) => {
                const checked = selected.has(n.id);
                return (
                  <label
                    key={n.id}
                    className="flex items-center gap-3 py-2.5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(n.id)}
                      className="w-4 h-4 accent-[color:var(--color-brand-sky)] shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-[color:var(--color-brand-navy)] truncate">
                        {n.legalName}
                      </div>
                      <div className="text-[11px] font-mono text-[color:var(--color-ink-muted)] truncate">
                        {n.nbfcId}
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </>
      )}

      {error && (
        <div
          className="card-iTarang p-3 text-[13px]"
          style={{
            color: "var(--color-danger)",
            borderColor: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="btn-ghost"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || nbfcs.length === 0}
          className="btn-primary"
        >
          {saving ? "Saving…" : "Save visibility"}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── shared modal chrome ─────────────────────────────────────────────────────

function ModalShell({
  children,
  onClose,
  labelledBy,
}: {
  children: React.ReactNode;
  onClose?: () => void;
  labelledBy: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onClick={onClose}
    >
      <div
        className="card-iTarang max-w-lg w-full p-6 space-y-4 bg-[color:var(--color-bg)] max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      disabled={!onClose}
      aria-label="Close"
      className="text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)] disabled:opacity-40"
    >
      <X className="w-4 h-4" />
    </button>
  );
}
