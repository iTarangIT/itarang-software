"use client";

/**
 * Dealer buyback search box (M23) — sibling of AdminBuybackSearch, same
 * debounce/dropdown mechanics, deliberately NOT a shared base component: the
 * two differ in endpoint, hit kinds and rendering, and a base component
 * parameterized on all three would be longer than the two files it replaced.
 *
 * Hits `GET /api/buyback/search?q=` — the DEALER-scoped endpoint (read
 * verbatim: src/app/api/buyback/search/route.ts). That route is requireDealer
 * + WHERE dealer_entity_id, and only ever returns the caller's own requests
 * (matched by request number or their own provenance vehicle/RC numbers), so
 * every hit is `kind: "request"` with `sublabel` = the raw deal status —
 * rendered here as request_no bold + StatusChip, navigating to the dealer
 * detail page via the hit's own href.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import StatusChip from "./StatusChip";

interface SearchHit {
  kind: "request";
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
}

const DEBOUNCE_MS = 350;

export default function DealerBuybackSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // setState calls live inside this async function, not synchronously in
    // the effect body — same react-hooks/set-state-in-effect pattern as
    // AdminBuybackSearch.
    const run = async () => {
      const query = q.trim();
      if (query.length < 2) {
        setHits([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DEBOUNCE_MS);
      });
      if (cancelled) return;

      try {
        const res = await fetch(`/api/buyback/search?q=${encodeURIComponent(query)}`);
        const j = await res.json();
        if (cancelled) return;
        setHits(j?.success === false ? [] : (j?.data?.hits ?? []));
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [q]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (hit: SearchHit) => {
    setOpen(false);
    router.push(hit.href);
  };

  return (
    <div ref={containerRef} className="relative w-[260px]">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search request, vehicle, RC…"
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12.5px] text-slate-700 placeholder:text-slate-400"
      />

      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 w-full min-w-[260px] overflow-hidden rounded-[10px] border border-gray-200 bg-white shadow-[0_4px_14px_rgba(15,23,42,.10)]">
          {loading ? (
            <div className="px-3.5 py-3 text-[12.5px] text-slate-400">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3.5 py-3 text-[12.5px] text-slate-400">No matches.</div>
          ) : (
            hits.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => go(h)}
                className="flex w-full items-center justify-between gap-2 border-b border-[#F4F6F9] px-3.5 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
              >
                <span className="font-bold text-slate-900">{h.label}</span>
                {h.sublabel && <StatusChip status={h.sublabel} />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
