/**
 * PageShell — branded page heading + breadcrumb + step indicator primitive.
 *
 * Server-renderable: this component uses no React state, only links + icons,
 * so it can be a server component. Pages that wrap their client form
 * components in <PageShell> stay server-rendered until the form mounts.
 *
 * iTarang BRD §6.B: H1 52/700 navy, eyebrow 11/600 ALL CAPS 0.12em teal.
 * Step indicator covers the NBFC onboarding journey (master → docs → LSP →
 * approval → activation) with active/done states. Loan-product management
 * is a post-onboarding tool and lives outside this ribbon.
 *
 * Used by every NBFC admin page so the role's view stays consistent.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export type StepKey =
  | "master"
  | "documents"
  | "lsp"
  | "approval"
  | "activation";

export interface PageShellStep {
  key: StepKey;
  label: string;
  state: "todo" | "active" | "done";
}

const NBFC_STEPS: ReadonlyArray<{ key: StepKey; label: string }> = [
  { key: "master", label: "Master" },
  { key: "documents", label: "Documents" },
  { key: "lsp", label: "Agreement" },
  { key: "approval", label: "Approval" },
  { key: "activation", label: "Activation" },
];

/**
 * Build the standard NBFC step ribbon, given which step is "active" and
 * which steps have been "done". Anything not in those sets is "todo".
 */
export function buildNbfcSteps(opts: {
  active?: StepKey;
  done?: StepKey[];
}): PageShellStep[] {
  const doneSet = new Set(opts.done ?? []);
  return NBFC_STEPS.map((s) => ({
    ...s,
    state: doneSet.has(s.key) ? "done" : s.key === opts.active ? "active" : "todo",
  }));
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PageShellProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  breadcrumb?: BreadcrumbItem[];
  steps?: PageShellStep[];
  /**
   * When provided, every step in the ribbon becomes a clickable link
   * pointing at the URL this callback returns. Return `null` to leave a
   * specific step non-navigable. When the prop is omitted entirely the
   * ribbon stays purely visual (backward-compatible with pages outside
   * the NBFC admin flow).
   */
  hrefForStep?: (key: StepKey) => string | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function PageShell({
  eyebrow,
  title,
  subtitle,
  breadcrumb,
  steps,
  hrefForStep,
  actions,
  children,
}: PageShellProps) {
  return (
    <div className="space-y-6">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-[color:var(--color-ink-muted)]">
          {breadcrumb.map((b, i) => (
            <span key={`${b.label}-${i}`} className="flex items-center gap-1.5">
              {b.href ? (
                <Link
                  href={b.href}
                  className="hover:text-[color:var(--color-brand-sky)] transition-colors"
                >
                  {b.label}
                </Link>
              ) : (
                <span>{b.label}</span>
              )}
              {i < breadcrumb.length - 1 && (
                <ChevronRight className="w-3 h-3 text-[color:var(--color-brand-silver)]" />
              )}
            </span>
          ))}
        </nav>
      )}

      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
          <h1 className="page-h1">{title}</h1>
          {subtitle && (
            <p className="text-sm text-[color:var(--color-ink-muted)] max-w-2xl">
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </header>

      {steps && steps.length > 0 && (
        <StepRibbon steps={steps} hrefForStep={hrefForStep} />
      )}

      <div>{children}</div>
    </div>
  );
}

function StepRibbon({
  steps,
  hrefForStep,
}: {
  steps: PageShellStep[];
  hrefForStep?: (key: StepKey) => string | null;
}) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto py-2">
      {steps.map((s, i) => {
        const dotClass =
          s.state === "active"
            ? "step-dot-active"
            : s.state === "done"
            ? "step-dot-done"
            : "step-dot-todo";
        const labelClass =
          s.state === "todo"
            ? "text-[color:var(--color-ink-muted)]"
            : "text-[color:var(--color-brand-navy)] font-semibold";
        const href = hrefForStep ? hrefForStep(s.key) : null;
        const inner = (
          <>
            <div className={dotClass}>{s.state === "done" ? "✓" : i + 1}</div>
            <span className={`text-xs whitespace-nowrap ${labelClass}`}>
              {s.label}
            </span>
          </>
        );
        return (
          <li key={s.key} className="flex items-center gap-1 shrink-0">
            {href ? (
              <Link
                href={href}
                className="flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-[color:var(--color-bg)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)]"
                aria-current={s.state === "active" ? "step" : undefined}
              >
                {inner}
              </Link>
            ) : (
              <div className="flex items-center gap-1">{inner}</div>
            )}
            {i < steps.length - 1 && (
              <span
                className="mx-1 inline-block h-px w-6"
                style={{ background: "var(--color-border)" }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
