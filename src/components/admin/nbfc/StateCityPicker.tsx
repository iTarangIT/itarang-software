"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Plus, X, ChevronDown, Check, Upload, AlertTriangle } from "lucide-react";
import { State, City } from "country-state-city";
import { toast } from "sonner";

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

// Case- and whitespace-insensitive key used to match uploaded names against the
// country-state-city library.
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

type UploadReport = {
  addedCities: number;
  addedStates: number;
  unmatchedStates: string[];
  unmatchedCities: string[];
};

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
  const [uploadReport, setUploadReport] = useState<UploadReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-sync if parent resets value (e.g. form reset). Cheap deep-equal by JSON.
  const lastEmittedRef = useRef<string>(JSON.stringify(value));
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === lastEmittedRef.current) return;
    lastEmittedRef.current = incoming;
    setRows(buildRowsFromValue(value));
    // A parent reset (e.g. "Create another") clears the picker — drop any
    // stale upload report with it.
    setUploadReport(null);
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

  // ── Bulk upload (Excel/CSV) ──────────────────────────────────────────────
  // Validates each {state, city} against country-state-city. Matched rows are
  // merged into the current selection (stored under the library's canonical
  // spelling); anything not found is surfaced in the unmatched alert panel.
  function processPairs(pairs: { state: string; city: string }[]) {
    const states = State.getStatesOfCountry(COUNTRY_ISO);
    const stateByNorm = new Map<string, { iso: string; name: string }>();
    for (const s of states) {
      stateByNorm.set(norm(s.name), { iso: s.isoCode, name: s.name });
    }

    // iso → (normalised city name → canonical city name), filled lazily.
    const cityCache = new Map<string, Map<string, string>>();
    function citiesFor(iso: string): Map<string, string> {
      let m = cityCache.get(iso);
      if (!m) {
        m = new Map();
        for (const c of City.getCitiesOfState(COUNTRY_ISO, iso)) {
          const k = norm(c.name);
          if (!m.has(k)) m.set(k, c.name);
        }
        cityCache.set(iso, m);
      }
      return m;
    }

    const unmatchedStates = new Set<string>();
    const unmatchedCities: string[] = [];
    // canonical state name → { iso, set of canonical city names }
    const matched = new Map<string, { iso: string; cities: Set<string> }>();
    const ensureState = (iso: string, name: string) => {
      let e = matched.get(name);
      if (!e) {
        e = { iso, cities: new Set() };
        matched.set(name, e);
      }
      return e;
    };

    for (const p of pairs) {
      if (p.state === "") continue;
      const st = stateByNorm.get(norm(p.state));
      if (!st) {
        unmatchedStates.add(p.state);
        continue;
      }
      if (p.city === "") {
        // Valid state, no city given — ensure the state row exists so the
        // admin can fill it in manually. Doesn't count as a city.
        ensureState(st.iso, st.name);
        continue;
      }
      const canonCity = citiesFor(st.iso).get(norm(p.city));
      if (!canonCity) {
        unmatchedCities.push(`${p.city} — ${st.name}`);
        continue;
      }
      ensureState(st.iso, st.name).cities.add(canonCity);
    }

    // Merge into current rows (decision: never wipe existing picks).
    const nextRows: Row[] = rows.map((r) => ({ ...r, cities: [...r.cities] }));
    let addedCities = 0;
    const addedStateNames = new Set<string>();
    for (const [stateName, info] of matched) {
      let row = nextRows.find((r) => r.stateName === stateName);
      if (!row) {
        row = {
          rowId: `upload-${norm(stateName)}-${nextRows.length}`,
          stateIso: info.iso,
          stateName,
          cities: [],
        };
        nextRows.push(row);
        addedStateNames.add(stateName);
      }
      for (const c of info.cities) {
        if (!row.cities.includes(c)) {
          row.cities.push(c);
          addedCities++;
        }
      }
    }

    emit(nextRows);

    const unmatchedStatesArr = Array.from(unmatchedStates);
    const skipped = unmatchedStatesArr.length + unmatchedCities.length;
    setUploadReport({
      addedCities,
      addedStates: addedStateNames.size,
      unmatchedStates: unmatchedStatesArr,
      unmatchedCities,
    });

    if (skipped > 0) {
      toast.warning(
        `Added ${addedCities} cit${addedCities === 1 ? "y" : "ies"}. ${skipped} entr${
          skipped === 1 ? "y" : "ies"
        } couldn't be matched — see details below.`,
      );
    } else if (addedCities > 0) {
      toast.success(
        `Added ${addedCities} cit${addedCities === 1 ? "y" : "ies"} from your file.`,
      );
    } else {
      toast.message("Nothing new to add — those locations were already selected.");
    }
  }

  async function handleFile(file: File) {
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const sheetName = wb.SheetNames[0];
      const ws = sheetName ? wb.Sheets[sheetName] : undefined;
      if (!ws) {
        toast.error("That file has no readable sheet.");
        return;
      }
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        defval: "",
      });
      if (json.length === 0) {
        toast.error("The sheet is empty.");
        return;
      }
      // Header detection: prefer columns literally named State / City; else
      // fall back to the first two columns in order.
      const keys = Object.keys(json[0] ?? {});
      const stateKey = keys.find((k) => /^\s*state\s*$/i.test(k)) ?? keys[0];
      const cityKey = keys.find((k) => /^\s*city\s*$/i.test(k)) ?? keys[1];
      const pairs = json
        .map((r) => ({
          state: String(r[stateKey] ?? "").trim(),
          city: cityKey ? String(r[cityKey] ?? "").trim() : "",
        }))
        .filter((p) => p.state !== "" || p.city !== "");
      if (pairs.length === 0) {
        toast.error("No State/City rows found in the file.");
        return;
      }
      processPairs(pairs);
    } catch {
      toast.error("Couldn't read that file. Use a .xlsx, .xls, or .csv file.");
    }
  }

  async function downloadTemplate() {
    try {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.aoa_to_sheet([
        ["State", "City"],
        ["Uttar Pradesh", "Agra"],
        ["Uttar Pradesh", "Kanpur"],
        ["Bihar", "Patna"],
      ]);
      ws["!cols"] = [{ wch: 24 }, { wch: 24 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Geography");
      XLSX.writeFile(wb, "geography_template.xlsx");
    } catch {
      toast.error("Couldn't generate the template.");
    }
  }

  return (
    <div className="space-y-3">
      {/* Bulk-upload toolbar — populate the picker from an Excel/CSV sheet. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            // Reset so re-selecting the same file fires onChange again.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg border border-[color:var(--color-border)] bg-white text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-bg)] transition-colors"
        >
          <Upload className="w-4 h-4" />
          Upload Excel/CSV
        </button>
        <button
          type="button"
          onClick={downloadTemplate}
          className="text-sm font-semibold text-[color:var(--color-brand-sky)] hover:text-[color:var(--color-brand-navy)] transition-colors"
        >
          Download template
        </button>
        <span className="text-xs text-[color:var(--color-ink-muted)]">
          Columns: State, City — one row per city.
        </span>
      </div>

      {uploadReport &&
        (uploadReport.unmatchedStates.length > 0 ||
          uploadReport.unmatchedCities.length > 0) && (
          <div
            className="rounded-lg border px-3 py-2.5 flex items-start gap-2.5"
            style={{
              background: "rgba(245, 158, 11, 0.08)",
              borderColor: "rgba(245, 158, 11, 0.4)",
            }}
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <div className="text-xs text-amber-800 flex-1 space-y-1">
              <p className="font-semibold">
                {uploadReport.unmatchedStates.length +
                  uploadReport.unmatchedCities.length}{" "}
                entr
                {uploadReport.unmatchedStates.length +
                  uploadReport.unmatchedCities.length ===
                1
                  ? "y"
                  : "ies"}{" "}
                from your file weren&apos;t added — fix the names and re-upload.
              </p>
              {uploadReport.unmatchedStates.length > 0 && (
                <p>
                  Unmatched states:{" "}
                  <strong>{uploadReport.unmatchedStates.join(", ")}</strong>
                </p>
              )}
              {uploadReport.unmatchedCities.length > 0 && (
                <p>
                  Unmatched cities:{" "}
                  <strong>{uploadReport.unmatchedCities.join(", ")}</strong>
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setUploadReport(null)}
              aria-label="Dismiss"
              className="text-amber-700 hover:text-amber-900 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

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
      {/* Auto-height container (NOT the fixed-height `input-itarang`, which is
          h-11 and clips wrapped chips). Chips wrap freely; a tall selection
          scrolls inside the box so it never overlaps neighbouring rows. The
          search input sits on its own full-width line at the bottom so it is
          always reachable no matter how many cities are picked. */}
      <div
        className={
          "w-full min-h-11 px-3 py-2 rounded-lg bg-white border border-[color:var(--color-border)] transition-shadow duration-150 focus-within:outline-none focus-within:border-brand-sky focus-within:ring-4 focus-within:ring-brand-sky/15 cursor-text " +
          (disabled ? "opacity-60 cursor-not-allowed bg-[color:var(--color-bg)]" : "")
        }
        onClick={() => {
          if (disabled) return;
          setOpen(true);
        }}
      >
        {value.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 max-h-32 overflow-y-auto mb-1.5">
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
          </div>
        )}
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
                : "Search to add more cities…"
          }
          className="w-full bg-transparent outline-none text-sm"
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
