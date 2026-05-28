"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Plus, X, ChevronDown, Check } from "lucide-react";
import { State, City } from "country-state-city";

export type LocationPair = { state: string; city: string };

type Row = {
  // Stable client-side row id for React keys + remove targeting.
  rowId: string;
  // ISO-code is what country-state-city keys on internally.
  stateIso: string;
  stateName: string;
  cities: string[];
};

type Props = {
  value: LocationPair[];
  onChange: (next: LocationPair[]) => void;
};

const COUNTRY_ISO = "IN";

function buildRowsFromValue(value: LocationPair[]): Row[] {
  // Group {state, city} pairs back into per-state rows. Preserves the order
  // that states first appeared in the incoming array.
  const states = State.getStatesOfCountry(COUNTRY_ISO);
  const nameToIso = new Map(states.map((s) => [s.name, s.isoCode]));
  const grouped = new Map<string, Row>();
  for (const pair of value) {
    let row = grouped.get(pair.state);
    if (!row) {
      row = {
        rowId: `${pair.state}-${grouped.size}`,
        stateIso: nameToIso.get(pair.state) ?? "",
        stateName: pair.state,
        cities: [],
      };
      grouped.set(pair.state, row);
    }
    if (!row.cities.includes(pair.city)) row.cities.push(pair.city);
  }
  return Array.from(grouped.values());
}

function flattenRows(rows: Row[]): LocationPair[] {
  const out: LocationPair[] = [];
  for (const row of rows) {
    if (!row.stateName) continue;
    for (const city of row.cities) {
      if (city) out.push({ state: row.stateName, city });
    }
  }
  return out;
}

export default function StateCityPicker({ value, onChange }: Props) {
  const [rows, setRows] = useState<Row[]>(() => buildRowsFromValue(value));

  // Re-sync if parent resets value (e.g. form reset). Cheap deep-equal by JSON.
  const lastEmittedRef = useRef<string>(JSON.stringify(value));
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === lastEmittedRef.current) return;
    lastEmittedRef.current = incoming;
    setRows(buildRowsFromValue(value));
  }, [value]);

  function emit(nextRows: Row[]) {
    setRows(nextRows);
    const flat = flattenRows(nextRows);
    lastEmittedRef.current = JSON.stringify(flat);
    onChange(flat);
  }

  function addRow() {
    emit([
      ...rows,
      {
        rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        stateIso: "",
        stateName: "",
        cities: [],
      },
    ]);
  }

  function removeRow(rowId: string) {
    emit(rows.filter((r) => r.rowId !== rowId));
  }

  function setRowState(rowId: string, stateIso: string, stateName: string) {
    emit(
      rows.map((r) =>
        r.rowId === rowId
          ? // Reset cities — they were for the previous state.
            { ...r, stateIso, stateName, cities: [] }
          : r,
      ),
    );
  }

  function setRowCities(rowId: string, cities: string[]) {
    emit(rows.map((r) => (r.rowId === rowId ? { ...r, cities } : r)));
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-xs text-[color:var(--color-ink-muted)] italic">
          No states added. Click "Add state" to start.
        </p>
      )}

      {rows.map((row) => (
        <div
          key={row.rowId}
          className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] gap-3 items-start"
        >
          <StateCombobox
            value={row.stateIso}
            valueLabel={row.stateName}
            onPick={(iso, name) => setRowState(row.rowId, iso, name)}
          />
          <CityMultiCombobox
            stateIso={row.stateIso}
            value={row.cities}
            onChange={(next) => setRowCities(row.rowId, next)}
          />
          <button
            type="button"
            onClick={() => removeRow(row.rowId)}
            aria-label="Remove state row"
            className="inline-flex items-center justify-center w-9 h-9 mt-0.5 rounded-lg border border-[color:var(--color-border)] bg-white text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] hover:border-[color:var(--color-danger)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-[color:var(--color-brand-sky)] hover:text-[color:var(--color-brand-navy)] transition-colors"
      >
        <Plus className="w-4 h-4" />
        Add state
      </button>
    </div>
  );
}

/* ===================== State (single-select combobox) ===================== */

function StateCombobox({
  value,
  valueLabel,
  onPick,
}: {
  value: string;
  valueLabel: string;
  onPick: (iso: string, name: string) => void;
}) {
  const states = useMemo(() => State.getStatesOfCountry(COUNTRY_ISO), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return states;
    return states.filter((s) => s.name.toLowerCase().includes(q));
  }, [states, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(iso: string, name: string) {
    onPick(iso, name);
    setQuery("");
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = filtered[activeIdx];
      if (s) pick(s.isoCode, s.name);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={open ? query : valueLabel}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onKeyDown={onKey}
          placeholder="Search state…"
          className="input-itarang pr-8"
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
        />
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[color:var(--color-ink-muted)] pointer-events-none" />
      </div>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-[color:var(--color-border)] bg-white shadow-lg text-sm"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-[color:var(--color-ink-muted)] italic">
              No matches
            </li>
          )}
          {filtered.map((s, idx) => {
            const isActive = idx === activeIdx;
            const isSelected = s.isoCode === value;
            return (
              <li
                key={s.isoCode}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s.isoCode, s.name);
                }}
                className={
                  "px-3 py-2 cursor-pointer flex items-center justify-between " +
                  (isActive
                    ? "bg-[color:var(--color-brand-sky)] text-white"
                    : "hover:bg-[color:var(--color-bg-muted)]")
                }
              >
                <span>{s.name}</span>
                {isSelected && <Check className="w-3.5 h-3.5" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ===================== City (multi-select combobox) ===================== */

function CityMultiCombobox({
  stateIso,
  value,
  onChange,
}: {
  stateIso: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const cities = useMemo(() => {
    if (!stateIso) return [];
    return City.getCitiesOfState(COUNTRY_ISO, stateIso);
  }, [stateIso]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = cities.map((c) => c.name);
    // De-duplicate (some districts list the same city under both city and town).
    const seen = new Set<string>();
    const unique = all.filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    if (!q) return unique;
    return unique.filter((n) => n.toLowerCase().includes(q));
  }, [cities, query]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function toggle(name: string) {
    if (value.includes(name)) onChange(value.filter((c) => c !== name));
    else onChange([...value, name]);
  }

  function removeChip(name: string) {
    onChange(value.filter((c) => c !== name));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[activeIdx];
      if (c) toggle(c);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const disabled = !stateIso;

  return (
    <div ref={rootRef} className="relative">
      <div
        className={
          "input-itarang flex flex-wrap items-center gap-1.5 min-h-11 cursor-text " +
          (disabled ? "opacity-60 cursor-not-allowed" : "")
        }
        onClick={() => {
          if (disabled) return;
          setOpen(true);
        }}
      >
        {value.map((city) => (
          <span
            key={city}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white"
            style={{ background: "var(--color-brand-sky)" }}
          >
            {city}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeChip(city);
              }}
              aria-label={`Remove ${city}`}
              className="hover:opacity-80"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onFocus={() => {
            if (!disabled) setOpen(true);
          }}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder={
            disabled
              ? "Pick a state first"
              : value.length === 0
                ? "Search cities…"
                : ""
          }
          className="flex-1 min-w-[120px] bg-transparent outline-none text-sm"
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
        />
      </div>
      {open && !disabled && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-[color:var(--color-border)] bg-white shadow-lg text-sm"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-[color:var(--color-ink-muted)] italic">
              No matches
            </li>
          )}
          {filtered.map((name, idx) => {
            const isActive = idx === activeIdx;
            const isSelected = value.includes(name);
            return (
              <li
                key={name}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  toggle(name);
                }}
                className={
                  "px-3 py-2 cursor-pointer flex items-center justify-between " +
                  (isActive
                    ? "bg-[color:var(--color-brand-sky)] text-white"
                    : "hover:bg-[color:var(--color-bg-muted)]")
                }
              >
                <span>{name}</span>
                {isSelected && <Check className="w-3.5 h-3.5" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
