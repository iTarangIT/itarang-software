"use client";

/**
 * Filter pill — proto filterPill() (iTarang Portal.dc.html:819).
 *
 * Two variants behind one prop:
 *   · default — a native <select> sits invisible on top of the pill, so the
 *     filter works with no popover/portal library. Unchanged.
 *   · searchable — a custom popover with a search box, for pills whose option
 *     list is long enough to scroll (Dealer, Vendor). A native <select> cannot
 *     carry a visible search input, so this one is hand-rolled.
 *
 * Split into two child components rather than branching inside one, so each has
 * a fixed, unconditional set of hooks (rules-of-hooks) — `searchable` is a
 * per-call-site constant, but the lint rule doesn't know that.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface FilterOption {
  value: string;
  label: string;
}

interface FilterPillProps {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  /** Render a searchable popover instead of a native select. */
  searchable?: boolean;
}

const PILL_CLASS =
  "relative flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-[7px] text-[12.5px] font-semibold text-slate-600";

export default function FilterPill(props: FilterPillProps) {
  return props.searchable ? <SearchablePill {...props} /> : <NativePill {...props} />;
}

function NativePill({ label, value, options, onChange }: FilterPillProps) {
  const selected = options.find((o) => o.value === value);

  return (
    <div className={PILL_CLASS}>
      <span>
        {label}: {selected?.label ?? value}
      </span>
      <span>▾</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SearchablePill({ label, value, options, onChange }: FilterPillProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Clear a stale search as we OPEN (not in an effect — that cascades a render).
  const toggle = () => {
    if (!open) setQuery("");
    setOpen((o) => !o);
  };

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" onClick={toggle} className={PILL_CLASS}>
        <span>
          {label}: {selected?.label ?? value}
        </span>
        <span>▾</span>
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-slate-400">No matches</li>
            ) : (
              filtered.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={`block w-full truncate px-3 py-1.5 text-left text-[12.5px] ${
                      o.value === value
                        ? "bg-sky-50 font-semibold text-sky-700"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
