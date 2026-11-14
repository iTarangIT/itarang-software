// /analyst/shared/<token> — a conversation another analyst user shared (E-381), read-only.
// Open to the analyst roles (CEO, Sales Head, admin); the link stops working when its owner
// stops sharing or deletes the conversation.

import { AnalystTranscript } from "@/components/analyst/AnalystTranscript";
import { requireAnalystUser } from "@/lib/analyst/access";
import { AnalystError } from "@/lib/analyst/errors";
import { hasThreadTable, threadByShareToken } from "@/lib/analyst/threadStore";
import { loadTranscript, type TranscriptRun } from "@/lib/analyst/transcript";
import { analystHome } from "@/lib/analyst/threadList";
import { formatWhen } from "@/lib/analyst/when";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared AI Analyst conversation" };

function Notice({ text }: { text: string }) {
  return <p className="mx-auto max-w-3xl rounded-lg border border-border bg-surface p-6 text-sm text-ink-muted">{text}</p>;
}

export default async function SharedAnalystPage({ params }: { params: Promise<{ token: string }> }) {
  let user;
  try {
    user = await requireAnalystUser();
  } catch (error) {
    if (error instanceof AnalystError) {
      return <Notice text="Shared AI Analyst conversations open for the CEO, Sales Head and admin only." />;
    }
    throw error;
  }
  const { token } = await params;
  const shared = (await hasThreadTable()) ? await threadByShareToken(token) : null;
  if (!shared) return <Notice text="This link no longer works. Its owner stopped sharing the conversation or deleted it." />;

  let runs: TranscriptRun[];
  try {
    runs = await loadTranscript(shared.thread_id);
  } catch (error) {
    console.error("[analyst] shared transcript failed:", error);
    return <Notice text="The analyst service did not answer just now. Try again in a moment." />;
  }
  const by = shared.user_id === user.id ? "you" : (shared.owner_name ?? "a colleague");
  const on = shared.shared_at ? ` on ${formatWhen(shared.shared_at)}` : "";
  return (
    <AnalystTranscript
      title={shared.title}
      subtitle={`Shared by ${by}${on} · read-only · ${runs.length} question${runs.length === 1 ? "" : "s"}`}
      runs={runs}
      backHref={analystHome(user.role)}
    />
  );
}
