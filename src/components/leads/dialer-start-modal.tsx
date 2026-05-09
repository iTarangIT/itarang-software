"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Phone,
  Sparkles,
  Brain,
  Loader2,
  ArrowRight,
  ChevronDown,
} from "lucide-react";

export type DialerProvider = "bolna" | "elevenlabs";
export type DialerCategory = "hot" | "warm" | "cold" | "all";

interface Lead {
  id: string;
  current_status?: string | null;
  phone?: string | null;
}

interface DialerStartModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    provider: DialerProvider,
    category: DialerCategory,
  ) => Promise<void> | void;
  /** Full lead list (no called-today filter applied — modal shows all). */
  eligibleLeads: Lead[];
}

// ─── Exhaustive bucketing ──────────────────────────────────────
// Every dialable lead lands in exactly one of hot / warm / cold so
// hot + warm + cold == all.

const HOT_STATUSES = new Set(["hot", "qualified"]);
const WARM_STATUSES = new Set([
  "warm",
  "callback_requested",
  "contacted",
  "interested",
]);

function bucketOf(status: string | null | undefined): "hot" | "warm" | "cold" {
  const s = (status ?? "").toLowerCase().trim();
  if (HOT_STATUSES.has(s)) return "hot";
  if (WARM_STATUSES.has(s)) return "warm";
  return "cold";
}

const CATEGORIES: {
  key: DialerCategory;
  label: string;
  hint: string;
}[] = [
  { key: "hot", label: "Hot", hint: "ready to convert" },
  { key: "warm", label: "Warm", hint: "engaged, follow up" },
  { key: "cold", label: "Cold", hint: "low intent / new" },
  { key: "all", label: "All", hint: "every lead" },
];

const CATEGORY_COLOR: Record<
  DialerCategory,
  { bar: string; dot: string }
> = {
  hot: { bar: "bg-rose-500", dot: "bg-rose-500" },
  warm: { bar: "bg-amber-500", dot: "bg-amber-500" },
  cold: { bar: "bg-sky-500", dot: "bg-sky-500" },
  all: { bar: "bg-gray-400", dot: "bg-gray-400" },
};

const PROVIDERS: {
  key: DialerProvider;
  label: string;
  hint: string;
  icon: typeof Brain;
  iconColor: string;
  iconBg: string;
}[] = [
  {
    key: "bolna",
    label: "Bolna",
    hint: "Production agent",
    icon: Brain,
    iconColor: "text-blue-600",
    iconBg: "bg-blue-50",
  },
  {
    key: "elevenlabs",
    label: "ElevenLabs",
    hint: "New agent",
    icon: Sparkles,
    iconColor: "text-violet-600",
    iconBg: "bg-violet-50",
  },
];

export function DialerStartModal({
  isOpen,
  onClose,
  onConfirm,
  eligibleLeads,
}: DialerStartModalProps) {
  const [provider, setProvider] = useState<DialerProvider>("bolna");
  const [providerOpen, setProviderOpen] = useState(false);
  const [category, setCategory] = useState<DialerCategory>("hot");
  const [submitting, setSubmitting] = useState(false);

  const counts = useMemo(() => {
    const c: Record<DialerCategory, number> = {
      hot: 0,
      warm: 0,
      cold: 0,
      all: 0,
    };
    for (const l of eligibleLeads) {
      c[bucketOf(l.current_status)] += 1;
      c.all += 1;
    }
    return c;
  }, [eligibleLeads]);

  const selectedCount = counts[category];
  const selectedProvider = PROVIDERS.find((p) => p.key === provider)!;
  const ProviderIcon = selectedProvider.icon;

  useEffect(() => {
    if (isOpen) {
      setProviderOpen(false);
      setSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (selectedCount === 0 || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(provider, category);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const seg = (n: number) => (counts.all > 0 ? (n / counts.all) * 100 : 0);
  const isHi = (k: "hot" | "warm" | "cold") =>
    category === "all" || category === k;

  return (
    <div className="dialer-modal-root">
      <style jsx global>{`
        .dialer-modal-root {
          position: fixed;
          inset: 0;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(17, 24, 39, 0.45);
          backdrop-filter: blur(6px) saturate(120%);
          -webkit-backdrop-filter: blur(6px) saturate(120%);
          color: #111827;
          animation: dialer-fade 200ms ease-out;
        }
        @keyframes dialer-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .dialer-modal-card {
          width: 100%;
          max-width: 540px;
          background: #ffffff;
          border-radius: 18px;
          overflow: visible;
          border: 1px solid #e5e7eb;
          box-shadow:
            0 24px 60px -20px rgba(15, 23, 42, 0.25),
            0 4px 16px -4px rgba(15, 23, 42, 0.08);
          position: relative;
          animation: dialer-rise 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        @keyframes dialer-rise {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.985);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .dialer-tnum {
          font-variant-numeric: tabular-nums;
          font-feature-settings: "tnum" 1;
        }
        .dialer-eyebrow {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #6b7280;
        }
        .dialer-stagger > * {
          opacity: 0;
          animation: dialer-stagger 380ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
        }
        .dialer-stagger > *:nth-child(1) { animation-delay: 50ms; }
        .dialer-stagger > *:nth-child(2) { animation-delay: 110ms; }
        .dialer-stagger > *:nth-child(3) { animation-delay: 170ms; }
        .dialer-stagger > *:nth-child(4) { animation-delay: 230ms; }
        .dialer-stagger > *:nth-child(5) { animation-delay: 290ms; }
        @keyframes dialer-stagger {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .dialer-cta {
          background: #059669;
          color: #ffffff;
          font-weight: 600;
          letter-spacing: -0.005em;
          transition:
            transform 160ms ease,
            box-shadow 160ms ease,
            background 160ms ease;
        }
        .dialer-cta:hover:not(:disabled) {
          background: #047857;
          transform: translateY(-1px);
          box-shadow: 0 8px 20px -8px rgba(5, 150, 105, 0.5);
        }
        .dialer-cta:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .dialer-cat-card {
          position: relative;
          padding: 12px 12px 10px;
          border-radius: 12px;
          border: 1px solid #e5e7eb;
          background: #ffffff;
          transition:
            border-color 160ms ease,
            background 160ms ease,
            box-shadow 160ms ease;
          cursor: pointer;
          text-align: left;
        }
        .dialer-cat-card:hover {
          border-color: #d1d5db;
          background: #fafafa;
        }
        .dialer-cat-card.is-active {
          border-color: #10b981;
          background: #ecfdf5;
          box-shadow:
            0 0 0 3px rgba(16, 185, 129, 0.12),
            0 4px 12px -4px rgba(16, 185, 129, 0.18);
        }
        .dialer-prov-row {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          transition:
            border-color 160ms ease,
            background 160ms ease;
          cursor: pointer;
        }
        .dialer-prov-row:hover {
          border-color: #d1d5db;
          background: #fafafa;
        }
        .dialer-prov-menu {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          box-shadow:
            0 16px 40px -12px rgba(15, 23, 42, 0.18),
            0 0 0 1px rgba(15, 23, 42, 0.04);
          overflow: hidden;
          animation: dialer-prov-fade 180ms ease-out;
        }
        @keyframes dialer-prov-fade {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .dialer-bar {
          display: flex;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: #f3f4f6;
        }
        .dialer-bar > span {
          transition:
            width 360ms cubic-bezier(0.2, 0.8, 0.2, 1),
            opacity 220ms ease;
        }
      `}</style>

      <div onClick={onClose} style={{ position: "absolute", inset: 0 }} />

      <div className="dialer-modal-card relative">
        <div className="relative px-7 pt-7 pb-6 dialer-stagger">
          {/* Header row */}
          <div className="flex items-start justify-between mb-7">
            <div>
              <p className="dialer-eyebrow mb-2">Outbound · session</p>
              <h2 className="text-[28px] leading-tight font-bold text-gray-900 tracking-tight">
                Start AI Dialer
              </h2>
              <p className="text-sm text-gray-500 mt-1.5 max-w-[28rem]">
                Pick a voice agent and the lead segment to call.
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 -m-2 text-gray-400 hover:text-gray-700 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Voice agent — relative wrapper + z-index so dropdown overlays
              the section below cleanly. */}
          <div className="mb-6 relative z-20">
            <p className="dialer-eyebrow mb-2.5">01 · Voice Agent</p>
            <div className="relative">
              <button
                type="button"
                onClick={() => setProviderOpen((o) => !o)}
                className="dialer-prov-row w-full flex items-center justify-between gap-3 px-4 py-3.5"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full ${selectedProvider.iconBg} flex items-center justify-center`}
                  >
                    <ProviderIcon
                      className={`w-4 h-4 ${selectedProvider.iconColor}`}
                    />
                  </div>
                  <div className="text-left leading-tight">
                    <div className="text-[15px] font-semibold text-gray-900">
                      {selectedProvider.label}
                    </div>
                    <div className="text-[12px] text-gray-500 mt-0.5">
                      {selectedProvider.hint}
                    </div>
                  </div>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-gray-400 transition-transform ${
                    providerOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {providerOpen && (
                <div className="dialer-prov-menu absolute top-full left-0 right-0 mt-2 z-30">
                  {PROVIDERS.map((p) => {
                    const Icon = p.icon;
                    const active = p.key === provider;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          setProvider(p.key);
                          setProviderOpen(false);
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
                          active
                            ? "bg-emerald-50/60"
                            : "hover:bg-gray-50"
                        }`}
                      >
                        <div
                          className={`w-8 h-8 rounded-full ${p.iconBg} flex items-center justify-center`}
                        >
                          <Icon className={`w-3.5 h-3.5 ${p.iconColor}`} />
                        </div>
                        <div className="flex-1 leading-tight">
                          <div className="text-sm font-semibold text-gray-900">
                            {p.label}
                          </div>
                          <div className="text-[12px] text-gray-500 mt-0.5">
                            {p.hint}
                          </div>
                        </div>
                        {active && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Composition + categories */}
          <div className="mb-2 relative z-10">
            <div className="flex items-baseline justify-between mb-3">
              <p className="dialer-eyebrow">02 · Lead Segment</p>
              <p className="text-[12px] text-gray-500 dialer-tnum">
                breakdown of{" "}
                <span className="font-semibold text-gray-700">
                  {counts.all}
                </span>{" "}
                leads
              </p>
            </div>

            {/* Stacked composition bar */}
            <div className="dialer-bar mb-2.5">
              <span
                className={CATEGORY_COLOR.hot.bar}
                style={{
                  width: `${seg(counts.hot)}%`,
                  opacity: isHi("hot") ? 1 : 0.22,
                }}
              />
              <span
                className={CATEGORY_COLOR.warm.bar}
                style={{
                  width: `${seg(counts.warm)}%`,
                  opacity: isHi("warm") ? 1 : 0.22,
                }}
              />
              <span
                className={CATEGORY_COLOR.cold.bar}
                style={{
                  width: `${seg(counts.cold)}%`,
                  opacity: isHi("cold") ? 1 : 0.22,
                }}
              />
            </div>

            {/* Bar legend */}
            <div className="flex items-center gap-4 mb-4">
              {(["hot", "warm", "cold"] as const).map((k) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${CATEGORY_COLOR[k].dot}`}
                  />
                  <span className="text-[11px] text-gray-500 uppercase tracking-wide font-medium dialer-tnum">
                    {k} · {counts[k]}
                  </span>
                </div>
              ))}
              <div className="flex-1" />
              <span className="text-[11px] text-gray-400 uppercase tracking-wide font-medium dialer-tnum">
                Σ {counts.all}
              </span>
            </div>

            {/* Category cards */}
            <div className="grid grid-cols-4 gap-2">
              {CATEGORIES.map((c) => {
                const active = category === c.key;
                const n = counts[c.key];
                const color = CATEGORY_COLOR[c.key];
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setCategory(c.key)}
                    className={`dialer-cat-card ${active ? "is-active" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${color.dot}`}
                      />
                      {active && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      )}
                    </div>
                    <div className="text-[22px] leading-none font-bold text-gray-900 dialer-tnum">
                      {n}
                    </div>
                    <div className="mt-1.5">
                      <div
                        className={`text-[12px] font-semibold ${
                          active ? "text-emerald-700" : "text-gray-900"
                        }`}
                      >
                        {c.label}
                      </div>
                      <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">
                        {c.hint}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-7 py-5 border-t border-gray-100 bg-gray-50 rounded-b-[18px]">
          <div className="flex items-center gap-3">
            <Phone className="w-3.5 h-3.5 text-gray-400" />
            <p className="text-[13px] text-gray-600">
              Will dial{" "}
              <span className="text-gray-900 font-bold dialer-tnum">
                {selectedCount}
              </span>{" "}
              via{" "}
              <span
                className={`font-semibold ${
                  provider === "elevenlabs"
                    ? "text-violet-600"
                    : "text-blue-600"
                }`}
              >
                {selectedProvider.label}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-[13px] text-gray-600 hover:text-gray-900 transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedCount === 0 || submitting}
              className="dialer-cta inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] cursor-pointer"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Starting
                </>
              ) : (
                <>
                  Start dialing
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function categoryMatcher(category: DialerCategory) {
  if (category === "all") return () => true;
  return (status: string | null | undefined) => bucketOf(status) === category;
}
