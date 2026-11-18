import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadCallFeedStatus, type CallFeedStatus } from "@/lib/operations/callFeed";
import { CALL_FEED_LABEL, callFeedTone, istWhen, workingGapText } from "@/lib/operations/callFeedText";

/**
 * Tracker ID 229, test 1: the Ops Console shows "Last NeoDove call received
 * <time>" (and the same for AI dialer results), coloured like the alarm —
 * amber past 2 working hours, red past 4. Server component; reads the same
 * loader the alarm collector and the Sales Daily email use.
 */
const TONE = {
    crit: "border-danger/50 bg-danger-bg/40",
    warn: "border-warning/40 bg-warning-bg/40",
    ok: "border-border",
    unknown: "border-dashed border-border",
} as const;

const STATUS = {
    crit: "Alarm — over 4 working hours",
    warn: "Alarm — over 2 working hours",
    ok: "Reaching live",
    unknown: "No data on this database",
} as const;

function waitLine(f: CallFeedStatus): string {
    if (f.feed === "neodove") {
        return f.waitingSince
            ? `Leads waiting since ${istWhen(f.waitingSince)} · ${workingGapText(f.gapWorkingMinutes)} working time`
            : "No pushed lead waiting for a call back";
    }
    return `${workingGapText(f.gapWorkingMinutes)} working time since the last result`;
}

export async function CallFeedCard() {
    let feeds: CallFeedStatus[];
    try {
        feeds = (await loadCallFeedStatus()).feeds;
    } catch (e) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Calls reaching live</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-danger">
                    Could not read the call feed: {e instanceof Error ? e.message : String(e)}
                </CardContent>
            </Card>
        );
    }
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-base">Calls reaching live</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
                {feeds.map((f) => {
                    const tone = callFeedTone(f.gapWorkingMinutes);
                    return (
                        <div key={f.feed} className={`rounded-lg border p-3 ${TONE[tone]}`}>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                                {CALL_FEED_LABEL[f.feed]}
                            </div>
                            <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{istWhen(f.lastAt)}</div>
                            <div className="mt-1 text-xs text-ink-muted">{waitLine(f)}</div>
                            <div
                                className={`mt-1 text-xs font-semibold ${
                                    tone === "crit" ? "text-danger" : tone === "warn" ? "text-warning" : "text-ink-muted"
                                }`}
                            >
                                {STATUS[tone]}
                            </div>
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}
