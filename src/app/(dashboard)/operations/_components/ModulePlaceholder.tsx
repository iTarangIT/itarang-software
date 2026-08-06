import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Stub for an Ops Console module that has not been built yet.
 *
 * The console ships phase by phase, and a tab strip whose links 404 reads as a
 * broken deploy rather than as work in progress. This says which phase fills
 * the page in and what it will show, so the shell is honest about its own
 * state — which is the whole point of a monitoring dashboard.
 */
export function ModulePlaceholder({
  title,
  phase,
  summary,
  willShow,
}: {
  title: string;
  phase: string;
  summary: string;
  willShow: string[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="mt-1 text-xs text-ink-muted">{summary}</p>
        </div>
        <Badge variant="muted" uppercase>
          {phase}
        </Badge>
      </CardHeader>
      <CardContent>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Will show
        </p>
        <ul className="mt-2 space-y-1 text-sm text-ink-muted">
          {willShow.map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden className="text-border">
                •
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
