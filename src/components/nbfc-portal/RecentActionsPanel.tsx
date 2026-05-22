/**
 * RecentActionsPanel — count of governed borrower actions completed in the
 * last 7 days, by type. All six categories always render (zero-count rows
 * are synthesised in command-centre.ts) so the panel is stable.
 */
import type { RecentActionCount } from "@/lib/nbfc/command-centre";

export default function RecentActionsPanel({
  actions,
}: {
  actions: RecentActionCount[];
}) {
  const total = actions.reduce((a, r) => a + r.count, 0);
  return (
    <section className="card-iTarang p-5 h-full" data-testid="cc-recent-actions">
      <h2 className="text-base font-semibold text-[color:var(--color-brand-navy)]">
        Recently completed actions
      </h2>
      <p className="mt-1 text-[12px] text-[color:var(--color-ink-muted)]">
        Governed actions executed in the last 7 days.
      </p>
      {total === 0 ? (
        <p className="mt-4 text-sm text-[color:var(--color-ink-muted)]">
          No actions completed in the last 7 days.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[color:var(--color-border)]">
          {actions.map((a) => (
            <li
              key={a.action_type}
              className="flex items-center justify-between gap-3 py-2.5"
              data-testid={`cc-action-${a.action_type}`}
            >
              <span className="text-sm text-[color:var(--color-brand-navy)]">
                {a.label}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                {a.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
