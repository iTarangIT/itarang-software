// Per-rep spelling hints for the voice transcriber: the dealer / shop / city
// names in the rep's own queue (the same builders and scope as the screen, via
// my_queue) and the product catalogue. Best-effort under a short timeout — a
// slow or failed read only means the static vocabulary is used.

import { queueRowsForTool } from "@/lib/assistant/tools/read/myQueue";
import { loadCatalogue } from "@/lib/assistant/tools/quotes";
import type { AssistantUser } from "@/lib/assistant/types";
import { EMPTY_VOCAB, type VoiceVocab } from "./prompt";

/** The tabs a rep most often talks about: their own leads and today's work. */
const TABS: Record<AssistantUser["role"], readonly string[]> = {
    asm: ["my_visits", "today"],
    inside_sales_rep: ["my_open", "follow_ups"],
};

type Row = { dealer_name?: string | null; shop_name?: string | null; city?: string | null };

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(fallback), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            () => {
                clearTimeout(t);
                resolve(fallback);
            },
        );
    });
}

export async function loadVoiceVocab(user: AssistantUser, timeoutMs = 2000): Promise<VoiceVocab> {
    const names = Promise.all(
        (TABS[user.role] ?? []).map((tab) =>
            queueRowsForTool(user, tab).then(
                (r) => r.rows as Row[],
                () => [] as Row[],
            ),
        ),
    ).then((tabs) => tabs.flat().flatMap((r) => [r.dealer_name, r.shop_name, r.city].filter((s): s is string => !!s)));

    const products = loadCatalogue().then((rows) =>
        rows.flatMap((r) => [r.product_name, r.model_id].filter((s): s is string => typeof s === "string" && !!s)),
    );

    const [n, p] = await Promise.all([
        withTimeout(names, timeoutMs, [] as string[]),
        withTimeout(products, timeoutMs, [] as string[]),
    ]);
    return n.length || p.length ? { names: n, products: p } : EMPTY_VOCAB;
}
