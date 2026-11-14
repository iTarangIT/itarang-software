// /analyst/print?thread=<id> — one of the caller's own conversations laid out for printing or
// "Save as PDF" (E-381). The browser's print dialog opens by itself.

import { AnalystTranscript } from "@/components/analyst/AnalystTranscript";
import { ownsThread, requireAnalystUser } from "@/lib/analyst/access";
import { AnalystError } from "@/lib/analyst/errors";
import { analystHome } from "@/lib/analyst/threadList";
import { hasThreadTable, threadMeta } from "@/lib/analyst/threadStore";
import { loadTranscript, type TranscriptRun } from "@/lib/analyst/transcript";
import { formatWhen } from "@/lib/analyst/when";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Analyst conversation" };

function Notice({ text }: { text: string }) {
  return <p className="mx-auto max-w-3xl rounded-lg border border-border bg-surface p-6 text-sm text-ink-muted">{text}</p>;
}

export default async function PrintAnalystPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let user;
  try {
    user = await requireAnalystUser();
  } catch (error) {
    if (error instanceof AnalystError) return <Notice text={error.message} />;
    throw error;
  }
  const { thread } = await searchParams;
  if (typeof thread !== "string" || !ownsThread(user, thread)) return <Notice text="That conversation was not found." />;

  let runs: TranscriptRun[];
  try {
    runs = await loadTranscript(thread);
  } catch (error) {
    console.error("[analyst] print transcript failed:", error);
    return <Notice text="The analyst service did not answer just now. Try again in a moment." />;
  }
  const meta = (await hasThreadTable().catch(() => false)) ? await threadMeta(user.id, thread).catch(() => null) : null;
  return (
    <AnalystTranscript
      title={meta?.title || runs[0]?.question || "AI Analyst conversation"}
      subtitle={`Printed ${formatWhen(new Date())} (IST) · ${runs.length} question${runs.length === 1 ? "" : "s"}`}
      runs={runs}
      backHref={`${analystHome(user.role)}?thread=${encodeURIComponent(thread)}`}
      print
    />
  );
}
